#!/usr/bin/env python3
"""Uncensor Cloud GitHub Actions worker.

The worker runs only inside the user's public repository. Search reads public
metadata with yt-dlp without downloading audio. Confirm downloads the selected
source, publishes one file to the "library" release, and updates list.json.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote, urljoin, urlparse

try:
    import requests
except ImportError:  # pragma: no cover - reported with a readable message at runtime
    requests = None  # type: ignore[assignment]

LOG = logging.getLogger("uncensor-cloud")

LIBRARY_TAG = "library"
PREVIEWS_TAG = "previews"
INDEX_FILE = "list.json"
JOBS_DIR = "jobs"
SUBMISSIONS_DIR = "submissions"
APPROVAL_LABELS = {
    "request": ("uncensor-request", "fbca04", "Заявка на добавление записи в общую библиотеку"),
    "approved": ("uncensor-approved", "0e8a16", "Владелец разрешил публикацию заявки"),
    "rejected": ("uncensor-rejected", "d73a4a", "Владелец отклонил заявку"),
    "published": ("uncensor-published", "5319e7", "Заявка опубликована в библиотеке"),
}
AUDIO_LIMIT_BYTES = 300 * 1024 * 1024
JOB_ETA_SECONDS = {
    "search": 45,
    "confirm": 75,
    "manual": 55,
    "toggle": 6,
    "remove": 6,
    "reject": 6,
    "check": 20,
}
SEARCH_PROVIDERS = ("youtube", "soundcloud", "rutube", "dailymotion")
MEDIA_PROVIDERS = (*SEARCH_PROVIDERS, "vimeo", "bandcamp", "vk")
PROVIDER_DOMAINS = {
    "youtube": ("youtube.com", "youtu.be"),
    "soundcloud": ("soundcloud.com",),
    "rutube": ("rutube.ru",),
    "dailymotion": ("dailymotion.com", "dai.ly"),
    "vimeo": ("vimeo.com",),
    "bandcamp": ("bandcamp.com",),
    "vk": ("vk.com", "vkvideo.ru"),
}
YOUTUBE_CHECK_URLS = (
    "https://www.youtube.com/watch?v=BaW_jenozKc",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
)
DOWNLOAD_TIMEOUT = (20, 120)
USER_AGENT = "UncensorCloud/1.0 (+https://github.com/)"
YTDLP_COOKIE_FILE = Path(tempfile.gettempdir()) / "uncensor-ytdlp-cookies.txt"

JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$")
CANDIDATE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
TRACK_ID_RE = re.compile(r"^[0-9]{1,24}$")


def provider_for_url(value: str) -> str:
    host = (urlparse(value).hostname or "").casefold()
    if not host:
        return ""
    for provider, domains in PROVIDER_DOMAINS.items():
        for domain in domains:
            if host == domain or host.endswith("." + domain):
                return provider
    return ""


def is_media_page(value: str) -> bool:
    return bool(provider_for_url(value))


class WorkerError(Exception):
    def __init__(self, code: str, message: str, detail: str = "", status: int = 0):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = truncate_text(detail, 5000)
        self.status = status


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utcnow().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_after(days: int) -> str:
    return (utcnow() + timedelta(days=days)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def truncate_text(value: Any, limit: int = 1000) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = text.replace("\r", " ").replace("\x00", "")
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text.strip()


def clean_text(value: Any, limit: int = 400) -> str:
    return re.sub(r"\s+", " ", truncate_text(value, limit)).strip()


def env(name: str, default: str = "", required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise WorkerError("env_missing", f"Не задана переменная окружения {name}.")
    return value


def parse_seconds(value: str) -> int:
    try:
        number = int(float(value or "0"))
    except (TypeError, ValueError):
        return 0
    return max(0, min(36000, number))


def parse_ms(value: str) -> int:
    return parse_seconds(value) * 1000


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value, 600)).casefold()
    text = text.replace("ё", "е")
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def similarity(left: Any, right: Any) -> float:
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    ratio = SequenceMatcher(None, a, b).ratio()
    a_tokens = set(a.split())
    b_tokens = set(b.split())
    if not a_tokens or not b_tokens:
        return ratio
    overlap = len(a_tokens & b_tokens)
    containment = overlap / max(1, min(len(a_tokens), len(b_tokens)))
    jaccard = overlap / max(1, len(a_tokens | b_tokens))
    return max(ratio, 0.6 * containment + 0.4 * jaccard)


def duration_acceptable(target_sec: int, candidate_sec: int) -> bool:
    candidate_sec = int(candidate_sec or 0)
    if candidate_sec <= 20 or candidate_sec > 3600:
        return False
    if target_sec <= 0:
        return True
    tolerance = max(20, int(target_sec * 0.12))
    return abs(candidate_sec - target_sec) <= tolerance


def duration_score(target_sec: int, candidate_sec: int) -> float:
    if target_sec <= 0 or candidate_sec <= 0:
        return 0.5
    delta = abs(target_sec - candidate_sec)
    return max(0.0, 1.0 - delta / max(30, target_sec))


def score_candidate(target_title: str, target_artist: str, candidate_title: str, candidate_uploader: str, target_sec: int, candidate_sec: int) -> float:
    full_target = f"{target_artist} {target_title}".strip()
    title_score = max(
        similarity(full_target, candidate_title),
        similarity(target_title, candidate_title),
        similarity(full_target, f"{candidate_title} {candidate_uploader}".strip()),
    )
    artist_score = similarity(target_artist, candidate_uploader) if target_artist and candidate_uploader else 0.5
    score = 0.78 * title_score + 0.12 * artist_score + 0.10 * duration_score(target_sec, candidate_sec)
    return round(max(0.0, min(1.0, score)), 3)


VERSION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(cover|кавер|перепевк|перепето)\b", re.I), "кавер или перепевка"),
    (re.compile(r"\b(remix|ремикс|mashup|мэшап)\b", re.I), "ремикс"),
    (re.compile(r"\b(instrumental|минус|инструментал|karaoke|караоке)\b", re.I), "инструментальная версия"),
    (re.compile(r"\b(live|концерт|concert|выступление)\b", re.I), "концертная запись"),
    (re.compile(r"\b(slowed|speed up|sped up|nightcore|8d|reverb)\b", re.I), "изменён темп или обработка"),
    (re.compile(r"\b(ai|нейросет|нейро)\b", re.I), "возможна обработка ИИ"),
)


def candidate_warnings(target_title: str, target_artist: str, candidate: dict[str, Any], target_sec: int, candidate_sec: int, score: float) -> list[str]:
    haystack = f"{candidate.get('title', '')} {candidate.get('uploader', '')}"
    warnings: list[str] = []
    for pattern, warning in VERSION_PATTERNS:
        if pattern.search(haystack) and warning not in warnings:
            warnings.append(warning)
    if target_artist and candidate.get("uploader") and similarity(target_artist, candidate["uploader"]) < 0.25:
        warnings.append("автор загрузившего не совпадает")
    if target_sec and candidate_sec:
        delta = abs(candidate_sec - target_sec)
        if delta > 8:
            warnings.append(f"длительность отличается на {delta} с")
    if score < 0.55:
        warnings.append("слабое совпадение названия")
    warnings.append("автоматическая проверка не гарантирует отсутствие цензуры")
    return warnings[:8]


def candidate_id(page_url: str) -> str:
    digest = hashlib.sha256(page_url.encode("utf-8")).hexdigest()[:10]
    return f"cand-{digest}"


def run_command(command: list[str], timeout: int = 300) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise WorkerError("tool_missing", f"Не найден инструмент {command[0]}.", str(error)) from error
    except subprocess.TimeoutExpired as error:
        raise WorkerError("tool_timeout", f"{command[0]} не завершился за {timeout} с.", str(error)) from error
    except subprocess.CalledProcessError as error:
        detail = clean_text(error.stderr or error.stdout or "", 2000)
        raise WorkerError("tool_failed", f"{command[0]} завершился с ошибкой.", detail) from error


def ffprobe_duration(path: Path) -> float:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=60,
    )
    try:
        return max(0.0, float(result.stdout.strip()))
    except ValueError as error:
        raise WorkerError("audio_invalid", "ffprobe не смог определить длительность аудио.") from error


def transcode_to_m4a(source: Path, destination: Path) -> float:
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-map_metadata",
            "-1",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(destination),
        ],
        timeout=420,
    )
    if not destination.exists() or destination.stat().st_size < 1024:
        raise WorkerError("audio_empty", "После перекодирования получился пустой файл.")
    duration = ffprobe_duration(destination)
    if duration < 20:
        raise WorkerError("audio_short", "Запись короче 20 секунд.")
    if duration > 3600:
        raise WorkerError("audio_long", "Запись длиннее часа — это не похоже на трек.")
    return duration


def validate_public_https(url: str) -> None:
    if not url or not isinstance(url, str):
        raise WorkerError("url_invalid", "Пустая ссылка.")
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise WorkerError("url_invalid", "Разрешены только HTTPS-ссылки.")
    if parsed.username or parsed.password:
        raise WorkerError("url_invalid", "Ссылка не должна содержать логин или пароль.")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise WorkerError("url_invalid", "В ссылке нет имени хоста.")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home.arpa")):
        raise WorkerError("url_private", "Локальные адреса запрещены.")
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except OSError as error:
            raise WorkerError("url_dns", f"Не удалось разрешить хост {host}.", str(error)) from error
        addresses = []
        for info in infos:
            try:
                addresses.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
    if not addresses:
        raise WorkerError("url_dns", "Хост не имеет IP-адресов.")
    for address in addresses:
        if not address.is_global:
            raise WorkerError("url_private", "Ссылка ведёт на локальный или служебный IP-адрес.")


def download_public_file(url: str, destination: Path, max_bytes: int = AUDIO_LIMIT_BYTES) -> str:
    if requests is None:
        raise WorkerError("worker_env", "Python-пакет requests не установлен.")
    session = requests.Session()
    headers = {"User-Agent": USER_AGENT, "Accept": "audio/*,video/*,application/octet-stream,*/*;q=0.5"}
    current = url
    for _ in range(7):
        validate_public_https(current)
        response = session.get(
            current,
            headers=headers,
            stream=True,
            allow_redirects=False,
            timeout=DOWNLOAD_TIMEOUT,
        )
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("location")
            response.close()
            if not location:
                raise WorkerError("download_redirect", "Сервер вернул редирект без адреса.")
            current = urljoin(current, location)
            continue
        if response.status_code != 200:
            response.close()
            raise WorkerError("download_http", f"Сервер вернул HTTP {response.status_code}.")
        content_type = (response.headers.get("content-type") or "").lower()
        if content_type.startswith("text/") or "html" in content_type or "json" in content_type:
            response.close()
            raise WorkerError("download_not_audio", "По ссылке находится страница, а не аудиофайл.")
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > max_bytes:
            response.close()
            raise WorkerError("download_too_large", "Аудиофайл больше допустимого размера (300 МБ).")
        total = 0
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 256):
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    handle.close()
                    destination.unlink(missing_ok=True)
                    response.close()
                    raise WorkerError("download_too_large", "Аудиофайл больше допустимого размера (300 МБ).")
                handle.write(chunk)
        response.close()
        if total < 1024:
            destination.unlink(missing_ok=True)
            raise WorkerError("download_empty", "Скачанный файл пустой.")
        return content_type
    raise WorkerError("download_redirect", "Слишком много перенаправлений.")


class GitHubAPI:
    def __init__(self, token: str, repo: str, branch: str):
        if requests is None:
            raise WorkerError("worker_env", "Python-пакет requests не установлен.")
        if not token:
            raise WorkerError("token_missing", "Workflow не получил GITHUB_TOKEN.")
        self.token = token
        self.repo = repo
        self.branch = branch
        self.api_url = env("GITHUB_API_URL", "https://api.github.com").rstrip("/")
        self.upload_url = env("GITHUB_UPLOAD_URL", "").rstrip("/") or (
            "https://uploads.github.com" if self.api_url == "https://api.github.com" else self.api_url
        )
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": USER_AGENT,
            }
        )

    def _url(self, path: str) -> str:
        return f"{self.api_url}/repos/{self.repo}{path}"

    def _error(self, response: Any, action: str) -> WorkerError:
        message = ""
        try:
            payload = response.json()
            if isinstance(payload, dict) and isinstance(payload.get("message"), str):
                message = payload["message"]
        except Exception:
            message = ""
        detail = f"{action}: HTTP {response.status_code} {truncate_text(message, 500)}"
        if response.status_code in (401, 403):
            return WorkerError("github_auth", "GitHub отклонил токен или не разрешил действие.", detail, response.status_code)
        return WorkerError("github_http", f"GitHub API вернул HTTP {response.status_code}.", detail, response.status_code)

    def get_file(self, path: str) -> tuple[str | None, str | None]:
        response = self.session.get(
            self._url(f"/contents/{quote(path, safe='/')}"),
            params={"ref": self.branch},
            timeout=30,
        )
        if response.status_code == 404:
            return None, None
        if not response.ok:
            raise self._error(response, f"Не удалось прочитать {path}")
        payload = response.json()
        if isinstance(payload, list):
            raise WorkerError("github_file", f"{path} — это папка, а не файл.")
        sha = str(payload.get("sha") or "")
        content = payload.get("content")
        if isinstance(content, str) and content:
            try:
                return base64.b64decode(content).decode("utf-8"), sha
            except Exception as error:
                raise WorkerError("github_file", f"Не удалось декодировать {path}.", str(error)) from error
        # GitHub omits content for files larger than 1 MB.
        download_url = payload.get("download_url")
        if not isinstance(download_url, str) or not download_url.startswith("https://"):
            raise WorkerError("github_file", f"GitHub не вернул содержимое {path}.")
        fallback = requests.get(download_url, timeout=30, headers={"User-Agent": USER_AGENT})
        if not fallback.ok:
            raise WorkerError("github_file", f"Не удалось скачать {path} по публичной ссылке.")
        return fallback.text, sha

    def delete_file(self, path: str, message: str) -> bool:
        _, sha = self.get_file(path)
        if not sha:
            return False
        response = self.session.delete(
            self._url(f"/contents/{quote(path, safe='/')}"),
            json={"message": message, "sha": sha, "branch": self.branch},
            timeout=30,
        )
        if not response.ok and response.status_code != 404:
            raise self._error(response, f"Не удалось удалить {path}")
        return response.ok

    def create_issue(self, title: str, body: str, labels: list[str]) -> dict[str, Any]:
        response = self.session.post(
            self._url("/issues"),
            json={"title": title, "body": body, "labels": labels},
            timeout=30,
        )
        if not response.ok:
            raise self._error(response, "Не удалось создать заявку на проверку")
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("number"):
            raise WorkerError("github_issue", "GitHub не вернул номер заявки.")
        return payload

    def comment_issue(self, number: int, body: str) -> None:
        response = self.session.post(
            self._url(f"/issues/{number}/comments"),
            json={"body": body},
            timeout=30,
        )
        if not response.ok:
            raise self._error(response, f"Не удалось прокомментировать заявку #{number}")

    def close_issue(self, number: int, state_reason: str = "completed") -> None:
        response = self.session.patch(
            self._url(f"/issues/{number}"),
            json={"state": "closed", "state_reason": state_reason},
            timeout=30,
        )
        if not response.ok:
            raise self._error(response, f"Не удалось закрыть заявку #{number}")

    def add_labels(self, number: int, labels: list[str]) -> None:
        response = self.session.post(
            self._url(f"/issues/{number}/labels"),
            json={"labels": labels},
            timeout=30,
        )
        if not response.ok:
            raise self._error(response, f"Не удалось обновить метки заявки #{number}")

    def ensure_label(self, name: str, color: str, description: str) -> None:
        response = self.session.post(
            self._url("/labels"),
            json={"name": name, "color": color, "description": description},
            timeout=30,
        )
        if not response.ok and response.status_code != 422:
            raise self._error(response, f"Не удалось создать метку {name}")

    def put_file(self, path: str, text: str, message: str, sha: str | None = None) -> None:
        payload: dict[str, Any] = {
            "message": message,
            "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
            "branch": self.branch,
        }
        if sha:
            payload["sha"] = sha
        response = self.session.put(
            self._url(f"/contents/{quote(path, safe='/')}"),
            json=payload,
            timeout=30,
        )
        if not response.ok:
            raise self._error(response, f"Не удалось записать {path}")

    def upsert_json(self, path: str, data: dict[str, Any], message: str) -> None:
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        for attempt in range(4):
            _, sha = self.get_file(path)
            try:
                self.put_file(path, text, message, sha)
                return
            except WorkerError as error:
                if error.status not in (409, 422) or attempt == 3:
                    raise
                time.sleep(1.5 * (attempt + 1))

    def get_json(self, path: str) -> dict[str, Any] | None:
        text, _ = self.get_file(path)
        if text is None:
            return None
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise WorkerError("github_json", f"{path} содержит некорректный JSON.", str(error)) from error
        if not isinstance(payload, dict):
            raise WorkerError("github_json", f"{path} должен содержать объект JSON.")
        return payload

    def update_index(self, mutator: Callable[[dict[str, Any]], bool]) -> tuple[dict[str, Any], bool]:
        for attempt in range(6):
            text, sha = self.get_file(INDEX_FILE)
            if text is None:
                index: dict[str, Any] = {"schema": 1, "name": "Uncensor Cloud", "tracks": {}}
            else:
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError as error:
                    raise WorkerError("index_invalid", "list.json содержит некорректный JSON.", str(error)) from error
                if not isinstance(raw, dict):
                    raise WorkerError("index_invalid", "list.json должен содержать объект JSON.")
                index = raw
            tracks = index.get("tracks")
            if tracks is None:
                index["tracks"] = {}
            elif not isinstance(tracks, dict):
                raise WorkerError("index_invalid", "Поле tracks в list.json должно быть объектом.")
            changed = bool(mutator(index))
            if not changed:
                return index, False
            index["schema"] = int(index.get("schema") or 1)
            if not index.get("name"):
                index["name"] = "Uncensor Cloud"
            index["updatedAt"] = iso_now()
            try:
                self.put_file(
                    INDEX_FILE,
                    json.dumps(index, ensure_ascii=False, indent=2) + "\n",
                    "uncensor-cloud: update library index",
                    sha,
                )
                return index, True
            except WorkerError as error:
                if error.status not in (409, 422) or attempt == 5:
                    raise
                time.sleep(1.5 * (attempt + 1))
        raise WorkerError("index_conflict", "Не удалось обновить list.json из-за конфликтов.")

    def get_release(self, tag: str) -> dict[str, Any] | None:
        response = self.session.get(self._url(f"/releases/tags/{quote(tag)}"), timeout=30)
        if response.status_code == 404:
            return None
        if not response.ok:
            raise self._error(response, f"Не удалось прочитать релиз {tag}")
        payload = response.json()
        return payload if isinstance(payload, dict) else None

    def ensure_release(self, tag: str, title: str) -> dict[str, Any]:
        release = self.get_release(tag)
        if release:
            return release
        response = self.session.post(
            self._url("/releases"),
            json={
                "tag_name": tag,
                "name": title,
                "body": "Автоматически созданный релиз Uncensor Cloud.",
                "draft": False,
                "prerelease": False,
            },
            timeout=30,
        )
        if response.status_code == 422:
            release = self.get_release(tag)
            if release:
                return release
        if not response.ok:
            raise self._error(response, f"Не удалось создать релиз {tag}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise WorkerError("github_release", f"GitHub не вернул данные релиза {tag}.")
        return payload

    def list_assets(self, release_id: int) -> list[dict[str, Any]]:
        assets: list[dict[str, Any]] = []
        for page in range(1, 11):
            response = self.session.get(
                self._url(f"/releases/{release_id}/assets"),
                params={"per_page": 100, "page": page},
                timeout=30,
            )
            if not response.ok:
                raise self._error(response, "Не удалось прочитать assets релиза")
            payload = response.json()
            if not isinstance(payload, list):
                break
            assets.extend(item for item in payload if isinstance(item, dict))
            if len(payload) < 100:
                break
        return assets

    def find_asset(self, release: dict[str, Any], name: str) -> dict[str, Any] | None:
        for asset in self.list_assets(int(release.get("id") or 0)):
            if asset.get("name") == name:
                return asset
        return None

    def delete_asset(self, asset: dict[str, Any]) -> None:
        asset_id = int(asset.get("id") or 0)
        if not asset_id:
            raise WorkerError("github_asset", "У release asset нет id.")
        response = self.session.delete(self._url(f"/releases/assets/{asset_id}"), timeout=30)
        if not response.ok and response.status_code != 404:
            raise self._error(response, f"Не удалось удалить asset {asset.get('name') or asset_id}")

    def delete_track_assets(self, release: dict[str, Any], track_id: str, keep_name: str = "") -> int:
        release_id = int(release.get("id") or 0)
        if not release_id:
            raise WorkerError("github_release", "У релиза нет id.")
        pattern = re.compile(rf"^{re.escape(track_id)}(?:-|\.|$)")
        removed = 0
        for asset in self.list_assets(release_id):
            name = str(asset.get("name") or "")
            if name == keep_name or not pattern.match(name):
                continue
            self.delete_asset(asset)
            removed += 1
        return removed

    def cleanup_legacy_previews(self) -> None:
        release = self.get_release(PREVIEWS_TAG)
        if not release:
            return
        release_id = int(release.get("id") or 0)
        if not release_id:
            return
        for asset in self.list_assets(release_id):
            self.delete_asset(asset)
        response = self.session.delete(self._url(f"/releases/{release_id}"), timeout=30)
        if not response.ok and response.status_code != 404:
            raise self._error(response, "Не удалось удалить старый релиз previews")
        response = self.session.delete(self._url(f"/git/refs/tags/{quote(PREVIEWS_TAG)}"), timeout=30)
        if not response.ok and response.status_code not in (404, 422):
            raise self._error(response, "Не удалось удалить тег previews")

    def upload_asset(self, release: dict[str, Any], name: str, path: Path, content_type: str = "audio/mp4") -> dict[str, Any]:
        release_id = int(release.get("id") or 0)
        if not release_id:
            raise WorkerError("github_release", "У релиза нет id.")
        existing = self.find_asset(release, name)
        if existing:
            delete = self.session.delete(self._url(f"/releases/assets/{existing.get('id')}"), timeout=30)
            if not delete.ok and delete.status_code != 404:
                raise self._error(delete, "Не удалось удалить старый asset")
        size = path.stat().st_size
        with path.open("rb") as handle:
            response = self.session.post(
                f"{self.upload_url}/repos/{self.repo}/releases/{release_id}/assets",
                params={"name": name},
                headers={"Content-Type": content_type, "Content-Length": str(size)},
                data=handle,
                timeout=(30, 600),
            )
        if not response.ok:
            raise self._error(response, f"Не удалось загрузить {name}")
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("browser_download_url"):
            raise WorkerError("github_upload", f"GitHub не вернул ссылку для {name}.")
        return payload


class JobStatus:
    def __init__(self, github: GitHubAPI, action: str, job_id: str, repo: str, branch: str):
        self.github = github
        self.action = action
        self.job_id = job_id
        self.repo = repo
        self.branch = branch
        self.created_at = iso_now()
        self.track_id = clean_text(env("TRACK_ID"), 40)
        self.track_title = clean_text(env("TITLE"), 300)
        self.track_artist = clean_text(env("ARTIST"), 300)
        self.track_duration_ms = parse_seconds(env("DURATION")) * 1000
        self.eta_seconds = JOB_ETA_SECONDS.get(action, 30)
        self.started_at = ""
        self.run_url = self._run_url()

    def _run_url(self) -> str:
        server = env("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
        run_id = env("GITHUB_RUN_ID", "")
        return f"{server}/{self.repo}/actions/runs/{run_id}" if run_id else ""

    def write(self, status: str, **fields: Any) -> None:
        now = iso_now()
        if status == "running" and not self.started_at:
            self.started_at = now
        payload: dict[str, Any] = {
            "schema": 1,
            "id": self.job_id,
            "action": self.action,
            "status": status,
            "repo": self.repo,
            "branch": self.branch,
            "trackId": self.track_id,
            "trackTitle": self.track_title,
            "trackArtist": self.track_artist,
            "trackDurationMs": self.track_duration_ms,
            "createdAt": self.created_at,
            "updatedAt": now,
            "expiresAt": iso_after(7),
            "etaSeconds": self.eta_seconds,
        }
        if self.started_at:
            payload["startedAt"] = self.started_at
        if self.run_url:
            payload["runUrl"] = self.run_url
        payload.update(fields)
        self.github.upsert_json(f"{JOBS_DIR}/{self.job_id}.json", payload, f"uncensor-cloud: job {self.job_id} {status}")


def error_payload(error: WorkerError) -> dict[str, str]:
    payload = {"code": error.code, "message": error.message}
    if error.detail:
        payload["detail"] = error.detail
    return payload


def yt_dlp_module() -> Any:
    try:
        import yt_dlp  # type: ignore[import-not-found]
    except ImportError as error:  # pragma: no cover
        raise WorkerError("worker_env", "yt-dlp не установлен на runner.") from error
    return yt_dlp


def yt_dlp_auth_options() -> dict[str, Any]:
    options: dict[str, Any] = {}
    cookies = env("YTDLP_COOKIES").strip()
    if cookies:
        if cookies.startswith("base64:"):
            try:
                cookies = base64.b64decode(cookies[7:]).decode("utf-8")
            except Exception as error:
                raise WorkerError("cookies_invalid", "Секрет YTDLP_COOKIES не удалось декодировать из base64.", str(error)) from error
        YTDLP_COOKIE_FILE.write_text(cookies.rstrip() + "\n", encoding="utf-8")
        try:
            YTDLP_COOKIE_FILE.chmod(0o600)
        except OSError:
            pass
        options["cookiefile"] = str(YTDLP_COOKIE_FILE)
    proxy = env("YTDLP_PROXY").strip()
    if proxy:
        options["proxy"] = proxy
    return options


def base_ydl_options() -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 25,
        "retries": 2,
        "fragment_retries": 2,
        "extractor_retries": 2,
        "cachedir": False,
        "max_filesize": AUDIO_LIMIT_BYTES,
        "format": "bestaudio/best",
        **yt_dlp_auth_options(),
    }


def http_get_json(url: str, params: dict[str, Any], provider: str) -> dict[str, Any]:
    if requests is None:
        raise WorkerError("worker_env", "Модуль requests не установлен на runner.")
    try:
        response = requests.get(url, params=params, timeout=25, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        raise WorkerError(
            f"{provider}_search_failed",
            f"Поиск в {provider} не удался.",
            truncate_text(error, 1200),
        ) from error
    if not isinstance(payload, dict):
        raise WorkerError(f"{provider}_search_failed", f"{provider} вернул неожиданный ответ.")
    return payload


def parse_rutube_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    entries = payload.get("results")
    if not isinstance(entries, list):
        return []
    result: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("is_live") or entry.get("is_deleted") or entry.get("is_hidden"):
            continue
        page_url = clean_text(entry.get("video_url"), 1000)
        if not page_url.startswith("https://"):
            continue
        author = entry.get("author") if isinstance(entry.get("author"), dict) else {}
        result.append(
            {
                "provider": "rutube",
                "pageUrl": page_url,
                "title": clean_text(entry.get("title"), 300),
                "artist": "",
                "uploader": clean_text(author.get("name"), 200),
                "duration": max(0, int(entry.get("duration") or 0)),
                "isLive": bool(entry.get("is_live")),
            }
        )
    return result


def parse_dailymotion_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    entries = payload.get("list")
    if not isinstance(entries, list):
        return []
    result: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        page_url = clean_text(entry.get("url"), 1000)
        if not page_url.startswith("https://"):
            continue
        result.append(
            {
                "provider": "dailymotion",
                "pageUrl": page_url,
                "title": clean_text(entry.get("title"), 300),
                "artist": "",
                "uploader": clean_text(entry.get("owner.screenname") or entry.get("owner"), 200),
                "duration": max(0, int(entry.get("duration") or 0)),
                "isLive": False,
            }
        )
    return result


def search_entries(provider: str, query: str) -> list[dict[str, Any]]:
    if provider == "rutube":
        payload = http_get_json(
            "https://rutube.ru/api/search/video/",
            {"query": query, "limit": 15},
            provider,
        )
        return parse_rutube_results(payload)
    if provider == "dailymotion":
        payload = http_get_json(
            "https://api.dailymotion.com/videos",
            {
                "search": query,
                "fields": "id,title,url,duration,owner.screenname",
                "limit": 15,
            },
            provider,
        )
        return parse_dailymotion_results(payload)
    if provider not in ("youtube", "soundcloud"):
        return []

    yt_dlp = yt_dlp_module()
    prefix = "ytsearch20" if provider == "youtube" else "scsearch15"
    options = {
        **base_ydl_options(),
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(f"{prefix}:{query}", download=False)
    except Exception as error:
        raise WorkerError(f"{provider}_search_failed", f"Поиск в {provider} не удался.", truncate_text(error, 1200)) from error
    if not isinstance(info, dict):
        return []
    entries = info.get("entries")
    if not isinstance(entries, list):
        return []
    result: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        webpage = entry.get("webpage_url") or entry.get("url") or ""
        if not isinstance(webpage, str) or not webpage.startswith("https://"):
            identifier = str(entry.get("id") or "")
            if provider == "youtube" and identifier:
                webpage = f"https://www.youtube.com/watch?v={quote(identifier)}"
            else:
                continue
        if provider == "youtube" and "youtube.com" not in webpage and "youtu.be" not in webpage:
            continue
        if provider == "soundcloud" and "soundcloud.com" not in webpage:
            continue
        duration = int(entry.get("duration") or 0)
        result.append(
            {
                "provider": provider,
                "pageUrl": webpage,
                "title": clean_text(entry.get("track") or entry.get("title"), 300),
                "artist": clean_text(entry.get("artist") or entry.get("creator"), 200),
                "uploader": clean_text(entry.get("uploader") or entry.get("channel") or entry.get("user"), 200),
                "duration": max(0, duration),
                "isLive": bool(entry.get("is_live")),
            }
        )
    return result


def extract_single_page(page_url: str) -> dict[str, Any]:
    yt_dlp = yt_dlp_module()
    try:
        with yt_dlp.YoutubeDL({**base_ydl_options(), "skip_download": True}) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as error:
        raise WorkerError("source_extract_failed", "Не удалось прочитать указанную страницу источника.", truncate_text(error, 1200)) from error
    if not isinstance(info, dict):
        raise WorkerError("source_extract_failed", "Источник не вернул данные.")
    if info.get("_type") in ("playlist", "multi_video"):
        entries = info.get("entries")
        if isinstance(entries, list) and entries and isinstance(entries[0], dict):
            info = entries[0]
        else:
            raise WorkerError("source_extract_failed", "Ссылка ведёт на плейлист, а не на отдельную запись.")
    return info


def classify_source_error(error: Exception) -> WorkerError:
    detail = truncate_text(error, 1500)
    low = detail.casefold()
    if "drm protected" in low or ("drm" in low and "protected" in low):
        return WorkerError(
            "source_drm",
            "Источник защищён DRM и не может быть скачан. Выберите другую запись.",
            detail,
        )
    if "sign in to confirm" in low or "not a bot" in low or "cookies" in low and "youtube" in low:
        return WorkerError(
            "youtube_auth",
            "YouTube требует вход с IP GitHub Actions. Добавьте cookies в секрет YTDLP_COOKIES или выберите SoundCloud.",
            detail,
        )
    if "video unavailable" in low or "this video is unavailable" in low or "private video" in low:
        return WorkerError("source_unavailable", "Источник больше недоступен. Выберите другую запись.", detail)
    return WorkerError("download_failed", "Не удалось скачать аудио из источника.", detail)


def probe_candidate_availability(page_url: str, provider: str) -> str:
    if provider != "soundcloud":
        return ""
    try:
        info = extract_single_page(page_url)
    except WorkerError as error:
        haystack = f"{error.message} {error.detail}".casefold()
        if "drm" in haystack and "protected" in haystack:
            return "DRM-защита: SoundCloud не отдаёт этот трек для скачивания"
        return ""
    if info.get("_has_drm") is True or info.get("has_drm") is True:
        return "DRM-защита: SoundCloud не отдаёт этот трек для скачивания"
    formats = info.get("formats")
    if isinstance(formats, list) and formats:
        if all(isinstance(item, dict) and item.get("has_drm") is True for item in formats):
            return "DRM-защита: SoundCloud не отдаёт этот трек для скачивания"
    return ""


def download_and_transcode(page_url: str, work_dir: Path) -> tuple[Path, float, dict[str, Any]]:
    yt_dlp = yt_dlp_module()
    target_dir = Path(tempfile.mkdtemp(prefix="source-", dir=work_dir))
    options = {
        **base_ydl_options(),
        "outtmpl": str(target_dir / "source.%(ext)s"),
        "overwrites": True,
        "concurrent_fragment_downloads": 4,
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(page_url, download=True)
    except Exception as error:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise classify_source_error(error) from error
    if not isinstance(info, dict):
        shutil.rmtree(target_dir, ignore_errors=True)
        raise WorkerError("download_failed", "Источник не вернул данные после скачивания.")
    downloaded: Path | None = None
    requested = info.get("requested_downloads")
    if isinstance(requested, list):
        for item in requested:
            if isinstance(item, dict):
                filepath = item.get("filepath")
                if isinstance(filepath, str) and Path(filepath).exists():
                    downloaded = Path(filepath)
                    break
    if downloaded is None:
        files = [path for path in target_dir.glob("source.*") if path.is_file()]
        if files:
            downloaded = max(files, key=lambda path: path.stat().st_size)
    if downloaded is None:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise WorkerError("download_failed", "yt-dlp не создал аудиофайл.")
    output = target_dir / "source.m4a"
    try:
        duration = transcode_to_m4a(downloaded, output)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    return output, duration, info


def make_candidate(
    raw: dict[str, Any],
    target_title: str,
    target_artist: str,
    target_sec: int,
    forced: bool = False,
) -> dict[str, Any]:
    page_url = clean_text(raw.get("pageUrl"), 1000)
    validate_public_https(page_url)
    provider = clean_text(raw.get("provider"), 40)
    if provider not in MEDIA_PROVIDERS:
        provider = provider_for_url(page_url) or "unknown"
    duration_sec = max(0, int(raw.get("duration") or 0))
    title = clean_text(raw.get("title"), 300) or "Без названия"
    uploader = clean_text(raw.get("uploader"), 200)
    artist = clean_text(raw.get("artist"), 200)
    score = 1.0 if forced else score_candidate(
        target_title,
        target_artist,
        title,
        uploader or artist,
        target_sec,
        duration_sec,
    )
    warnings = candidate_warnings(
        target_title,
        target_artist,
        {"title": title, "uploader": uploader or artist},
        target_sec,
        duration_sec,
        score,
    )
    if forced:
        warnings.insert(0, "выбрано вручную по указанной ссылке")
    return {
        "id": candidate_id(page_url),
        "provider": provider,
        "pageUrl": page_url,
        "title": title,
        "artist": artist,
        "uploader": uploader,
        "durationMs": duration_sec * 1000,
        "score": score,
        "warnings": warnings,
    }


def handle_search(github: GitHubAPI, job: JobStatus) -> None:
    target_title = clean_text(env("TITLE"), 300)
    target_artist = clean_text(env("ARTIST"), 300)
    target_sec = parse_seconds(env("DURATION"))
    source_url = env("SOURCE_URL").strip()
    if not target_title:
        raise WorkerError("input_invalid", "Не передано название трека.")
    if target_sec and not 20 <= target_sec <= 3600:
        raise WorkerError("input_invalid", "Длительность трека выглядит некорректной.")
    if source_url:
        validate_public_https(source_url)
    query = f"{target_artist} {target_title}".strip()
    provider_errors: list[str] = []
    raw_candidates: list[dict[str, Any]] = []

    if source_url:
        try:
            info = extract_single_page(source_url)
            raw_candidates.append(
                {
                    "provider": provider_for_url(source_url) or "unknown",
                    "pageUrl": str(info.get("webpage_url") or source_url),
                    "title": clean_text(info.get("track") or info.get("title"), 300),
                    "artist": clean_text(info.get("artist") or info.get("creator"), 200),
                    "uploader": clean_text(info.get("uploader") or info.get("channel"), 200),
                    "duration": int(info.get("duration") or 0),
                    "isLive": bool(info.get("is_live")),
                    "forced": True,
                }
            )
        except WorkerError as error:
            provider_errors.append(f"указанная ссылка: {error.message}")

    for provider in SEARCH_PROVIDERS:
        try:
            raw_candidates.extend(search_entries(provider, query))
        except WorkerError as error:
            provider_errors.append(f"{provider}: {error.message} {error.detail}".strip())

    seen_urls: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for raw in raw_candidates:
        page_url = str(raw.get("pageUrl") or "")
        if not page_url or page_url in seen_urls or raw.get("isLive"):
            continue
        seen_urls.add(page_url)
        duration = int(raw.get("duration") or 0)
        forced = bool(raw.get("forced"))
        if not forced and duration and not duration_acceptable(target_sec, duration):
            continue
        try:
            candidate = make_candidate(raw, target_title, target_artist, target_sec, forced)
        except WorkerError as error:
            provider_errors.append(f"{error.code}: {error.message}")
            continue
        if not forced and candidate["score"] < 0.28:
            continue
        candidates.append(candidate)

    candidates.sort(
        key=lambda item: (
            1 if str(item.get("pageUrl")) == source_url else 0,
            float(item.get("score") or 0),
            int(item.get("durationMs") or 0),
        ),
        reverse=True,
    )
    for candidate in candidates[:8]:
        reason = probe_candidate_availability(str(candidate.get("pageUrl") or ""), str(candidate.get("provider") or ""))
        candidate["probed"] = True
        if reason:
            candidate["unavailable"] = True
            candidate["unavailableReason"] = reason
    if not candidates:
        raise WorkerError(
            "no_candidates",
            "Подходящие записи не найдены.",
            " ".join(provider_errors)[:3000] or "Поиск не вернул результатов.",
        )

    job.write("ready", candidates=candidates[:12], warnings=provider_errors[:8])


def split_artists(value: str) -> list[str]:
    parts = [clean_text(part, 120) for part in re.split(r"\s*(?:,|&|;|\b(?:feat|ft)\.?)\s*", value, flags=re.I)]
    return [part for part in parts if part][:6]


def build_mapping(
    track_id: str,
    title: str,
    artist: str,
    duration_ms: int,
    audio_url: str,
    asset_name: str,
    source: dict[str, Any],
    existing: dict[str, Any] | None,
) -> dict[str, Any]:
    now = iso_now()
    mapping: dict[str, Any] = {
        "trackId": track_id,
        "title": clean_text(title, 300) or "Без названия",
        "artists": split_artists(artist) or ["Неизвестный исполнитель"],
        "durationMs": max(0, int(duration_ms or 0)),
        "enabled": True,
        "audioUrl": audio_url,
        "assetName": asset_name,
        "releaseTag": LIBRARY_TAG,
        "source": source,
        "addedAt": now,
        "updatedAt": now,
    }
    if existing and isinstance(existing, dict):
        mapping["addedAt"] = str(existing.get("addedAt") or now)
        mapping["enabled"] = True
    return mapping


SOURCE_FALLBACK_CODES = {
    "source_drm",
    "source_unavailable",
    "youtube_auth",
    "download_failed",
    "duration_mismatch",
    "audio_short",
    "audio_long",
    "audio_invalid",
    "audio_empty",
}
FALLBACK_REJECT_WARNINGS = (
    "кавер",
    "перепев",
    "ремикс",
    "мэшап",
    "инструментал",
    "минус",
    "караоке",
    "концерт",
    "изменён темп",
    "обработка ии",
)


def fallback_candidates(source_job: dict[str, Any], selected: dict[str, Any]) -> list[dict[str, Any]]:
    selected_id = str(selected.get("id") or "")
    target_sec = int(source_job.get("trackDurationMs") or 0) // 1000
    result: list[dict[str, Any]] = []
    for item in source_job.get("candidates") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "") == selected_id:
            continue
        if item.get("unavailable") is True:
            continue
        page_url = clean_text(item.get("pageUrl"), 1000)
        if not page_url:
            continue
        score = float(item.get("score") or 0)
        if score < 0.55:
            continue
        duration_sec = int(item.get("durationMs") or 0) // 1000
        if target_sec and duration_sec and abs(duration_sec - target_sec) > 10:
            continue
        warnings = " ".join(str(value) for value in (item.get("warnings") or [])).casefold()
        if any(pattern in warnings for pattern in FALLBACK_REJECT_WARNINGS):
            continue
        result.append(item)
    result.sort(key=lambda item: float(item.get("score") or 0), reverse=True)
    return result[:4]


def current_actor() -> str:
    return env("GITHUB_ACTOR").strip()


def repository_owner_login() -> str:
    owner = env("REPOSITORY_OWNER").strip()
    if not owner:
        owner = env("GITHUB_REPOSITORY").strip().split("/", 1)[0]
    return owner


def is_repository_owner() -> bool:
    actor = current_actor().casefold()
    owner = repository_owner_login().casefold()
    return bool(actor and owner and actor == owner)


def approval_issue_number(required: bool = False) -> int:
    value = env("APPROVAL_ISSUE").strip()
    if not value:
        if required:
            raise WorkerError("input_invalid", "Не передан номер заявки.")
        return 0
    if not value.isdigit():
        raise WorkerError("input_invalid", "Некорректный номер заявки.")
    return int(value)


def submission_path(job_id: str) -> str:
    return f"{SUBMISSIONS_DIR}/{job_id}.json"


def ensure_approval_labels(github: GitHubAPI) -> None:
    for name, color, description in APPROVAL_LABELS.values():
        github.ensure_label(name, color, description)


def create_submission(
    github: GitHubAPI,
    job: JobStatus,
    action: str,
    details: dict[str, Any],
) -> None:
    payload: dict[str, Any] = {
        "schema": 1,
        "action": action,
        "jobId": job.job_id,
        "trackId": job.track_id,
        "trackTitle": job.track_title,
        "trackArtist": job.track_artist,
        "trackDurationMs": job.track_duration_ms,
        "requestedBy": current_actor(),
        "requestedAt": iso_now(),
        **details,
    }
    ensure_approval_labels(github)
    source_line = clean_text(details.get("sourceUrl"), 1000) or "не указан"
    candidate_line = clean_text(details.get("candidateTitle"), 300) or "ручная ссылка"
    issue = github.create_issue(
        f"[Uncensor] {action}: {job.track_artist or 'Неизвестный исполнитель'} — {job.track_title or job.track_id}",
        "\n".join(
            [
                "## Заявка на добавление записи",
                "",
                f"**Трек:** {job.track_artist or '—'} — {job.track_title or job.track_id}",
                f"**Кто просит:** @{current_actor() or 'unknown'}",
                f"**Действие:** `{action}`",
                f"**Кандидат:** {candidate_line}",
                f"**Источник:** {source_line}",
                f"**Задание:** `{job.job_id}`",
                f"**Workflow:** {job.run_url or '—'}",
                "",
                f"Владелец: добавьте метку `{APPROVAL_LABELS['approved'][0]}`, чтобы опубликовать запись, "
                f"или `{APPROVAL_LABELS['rejected'][0]}`, чтобы отклонить заявку.",
                "",
                f"Данные заявки хранятся в `{submission_path(job.job_id)}`. Не редактируйте этот файл вручную.",
            ]
        ),
        [APPROVAL_LABELS["request"][0]],
    )
    number = int(issue.get("number") or 0)
    issue_url = clean_text(issue.get("html_url"), 1000) or f"https://github.com/{job.repo}/issues/{number}"
    payload["issueNumber"] = number
    try:
        github.upsert_json(submission_path(job.job_id), payload, f"uncensor-cloud: request {job.job_id}")
    except Exception as error:
        try:
            github.comment_issue(number, "Не удалось сохранить данные заявки. Попросите владельца отклонить её.")
            github.close_issue(number)
        except Exception:
            pass
        raise error
    job.write(
        "awaiting_approval",
        issueUrl=issue_url,
        issueNumber=number,
        requestedBy=current_actor(),
        note="Заявка отправлена владельцу на проверку в GitHub. Публикация начнётся после подтверждения.",
    )


def finalize_approval(github: GitHubAPI, job: JobStatus) -> None:
    number = approval_issue_number()
    if not number:
        return
    try:
        github.delete_file(submission_path(job.job_id), f"uncensor-cloud: close request {job.job_id}")
    except Exception as error:  # pragma: no cover - cleanup must not hide a successful publish
        LOG.warning("Could not delete approved submission: %s", error)
    try:
        github.add_labels(number, [APPROVAL_LABELS["published"][0]])
        github.comment_issue(
            number,
            f"✅ Запись опубликована в общей библиотеке.\n\n[Открыть запуск]({job.run_url or '—'})",
        )
        github.close_issue(number)
    except Exception as error:  # pragma: no cover - publish already succeeded
        LOG.warning("Could not finalize approval issue #%s: %s", number, error)


def require_existing_replacement_permission(github: GitHubAPI, track_id: str) -> None:
    actor = current_actor().casefold()
    owner = repository_owner_login().casefold()
    if not actor or not owner or actor == owner:
        return
    index = github.get_json(INDEX_FILE)
    tracks = index.get("tracks") if isinstance(index, dict) else None
    if isinstance(tracks, dict) and track_id in tracks:
        raise WorkerError(
            "forbidden",
            "Существующую подмену может заменить только владелец репозитория.",
            f"actor={actor} owner={owner} track={track_id}",
            403,
        )


def handle_confirm(github: GitHubAPI, job: JobStatus) -> None:
    source_job_id = env("SOURCE_JOB_ID", required=True)
    candidate_id_value = env("CANDIDATE_ID", required=True)
    if not JOB_ID_RE.fullmatch(source_job_id):
        raise WorkerError("input_invalid", "Некорректный source_job_id.")
    if not CANDIDATE_ID_RE.fullmatch(candidate_id_value):
        raise WorkerError("input_invalid", "Некорректный candidate_id.")
    source_job = github.get_json(f"{JOBS_DIR}/{source_job_id}.json")
    if not source_job:
        raise WorkerError("source_job_missing", "Исходное задание поиска не найдено или истекло.")
    if str(source_job.get("status")) != "ready":
        raise WorkerError("source_job_not_ready", "Исходное задание уже не находится в состоянии ready.")
    if str(source_job.get("trackId")) != job.track_id:
        raise WorkerError("source_job_mismatch", "Исходное задание относится к другому треку.")
    candidates = source_job.get("candidates")
    if not isinstance(candidates, list):
        raise WorkerError("source_job_invalid", "В исходном задании нет списка кандидатов.")
    candidate = next(
        (item for item in candidates if isinstance(item, dict) and str(item.get("id")) == candidate_id_value),
        None,
    )
    if not candidate:
        raise WorkerError("candidate_missing", "Кандидат не найден в исходном задании.")
    source_url = clean_text(candidate.get("pageUrl"), 1000)
    validate_public_https(source_url)
    require_existing_replacement_permission(github, job.track_id)
    if not is_repository_owner():
        create_submission(
            github,
            job,
            "confirm",
            {
                "sourceJobId": source_job_id,
                "candidateId": candidate_id_value,
                "sourceUrl": source_url,
                "candidateTitle": clean_text(candidate.get("title"), 300),
                "candidateProvider": clean_text(candidate.get("provider"), 40),
            },
        )
        return

    attempts = [candidate, *fallback_candidates(source_job, candidate)]
    work_root = Path(tempfile.mkdtemp(prefix="uncensor-confirm-"))
    failure_notes: list[str] = []
    try:
        chosen: dict[str, Any] | None = None
        output_path: Path | None = None
        duration = 0.0
        downloaded_info: dict[str, Any] = {}
        skip_provider = ""
        for index, current in enumerate(attempts):
            page_url = clean_text(current.get("pageUrl"), 1000)
            title = clean_text(current.get("title"), 200) or page_url
            provider = str(current.get("provider") or "")
            if skip_provider and provider == skip_provider:
                continue
            try:
                validate_public_https(page_url)
                if current.get("unavailable") is True:
                    raise WorkerError(
                        "source_unavailable",
                        clean_text(current.get("unavailableReason"), 300) or "Этот источник помечен как недоступный.",
                    )
                if provider == "soundcloud" and not current.get("probed"):
                    reason = probe_candidate_availability(page_url, provider)
                    if reason:
                        raise WorkerError("source_unavailable", reason)
                output_path, duration, downloaded_info = download_and_transcode(page_url, work_root)
                duration_sec = int(round(duration))
                expected_sec = int(current.get("durationMs") or source_job.get("trackDurationMs") or 0) // 1000
                if expected_sec and not duration_acceptable(expected_sec, duration_sec):
                    raise WorkerError(
                        "duration_mismatch",
                        f"Длительность изменилась: ожидалось около {expected_sec} с, получено {duration_sec} с.",
                    )
                chosen = current
                break
            except WorkerError as error:
                if error.code == "youtube_auth":
                    skip_provider = "youtube"
                remaining = [
                    item
                    for item in attempts[index + 1 :]
                    if not (skip_provider and str(item.get("provider") or "") == skip_provider)
                ]
                if error.code not in SOURCE_FALLBACK_CODES or not remaining:
                    if failure_notes:
                        error.detail = truncate_text(" | ".join([*failure_notes, error.detail]), 3000)
                    raise
                failure_notes.append(f"{title}: {error.message}")
                next_title = clean_text(remaining[0].get("title"), 200) or "следующий источник"
                job.write(
                    "running",
                    note=f"Источник недоступен: {error.message} Пробую резервный вариант «{next_title}».",
                )
        if chosen is None or output_path is None:
            raise WorkerError("download_failed", "Не удалось скачать ни один из источников.")

        duration_sec = int(round(duration))
        library = github.ensure_release(LIBRARY_TAG, "Uncensor Cloud — library")
        track_id = job.track_id
        final_name = f"{track_id}.m4a"
        final_asset = github.upload_asset(library, final_name, output_path, "audio/mp4")
        audio_url = str(final_asset.get("browser_download_url") or "")
        if not audio_url.startswith("https://"):
            raise WorkerError("github_upload", "GitHub не вернул ссылку на итоговый аудиофайл.")
        title = job.track_title or clean_text(chosen.get("title") or downloaded_info.get("title"), 300)
        artist = job.track_artist or clean_text(
            chosen.get("artist") or chosen.get("uploader") or downloaded_info.get("artist"),
            300,
        )
        source = {
            "provider": chosen.get("provider") if chosen.get("provider") in MEDIA_PROVIDERS else "unknown",
            "pageUrl": clean_text(chosen.get("pageUrl"), 1000),
            "title": clean_text(chosen.get("title"), 300),
            "artist": clean_text(chosen.get("artist"), 300),
            "uploader": clean_text(chosen.get("uploader"), 300),
            "durationMs": duration_sec * 1000,
            "score": float(chosen.get("score") or 0),
            "warnings": chosen.get("warnings") if isinstance(chosen.get("warnings"), list) else [],
        }
        existing: dict[str, Any] | None = None

        def mutate(index: dict[str, Any]) -> bool:
            nonlocal existing
            tracks = index.setdefault("tracks", {})
            current = tracks.get(track_id)
            existing = current if isinstance(current, dict) else None
            tracks[track_id] = build_mapping(
                track_id,
                title,
                artist,
                duration_sec * 1000,
                audio_url,
                final_name,
                source,
                existing,
            )
            return True

        github.update_index(mutate)
        github.delete_track_assets(library, track_id, keep_name=final_name)
        fields: dict[str, Any] = {
            "published": {"audioUrl": audio_url, "assetName": final_name},
            "candidateId": str(chosen.get("id") or candidate_id_value),
            "sourceJobId": source_job_id,
        }
        if failure_notes:
            fields["note"] = (
                "Основной источник не подошёл. Использован резервный: "
                f"«{clean_text(chosen.get('title'), 200) or 'без названия'}». "
                + " ".join(failure_notes)
            )
        job.write("published", **fields)
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


def handle_check(github: GitHubAPI, job: JobStatus) -> None:  # pragma: no cover - network path
    cookies = env("YTDLP_COOKIES").strip()
    proxy = env("YTDLP_PROXY").strip()
    last_error: WorkerError | None = None
    for url in YOUTUBE_CHECK_URLS:
        try:
            yt_dlp = yt_dlp_module()
            with yt_dlp.YoutubeDL({**base_ydl_options(), "skip_download": True}) as ydl:
                info = ydl.extract_info(url, download=False)
            if isinstance(info, dict) and info.get("id"):
                mode = "cookies" if cookies else "proxy" if proxy else "без cookies"
                job.write("ready", note=f"YouTube доступен ({mode}). Можно скачивать.", candidates=[])
                return
            last_error = WorkerError("check_failed", "YouTube не вернул данные.")
        except WorkerError:
            raise
        except Exception as error:
            classified = classify_source_error(error)
            if classified.code == "youtube_auth":
                if cookies:
                    classified.message = "YouTube не принял cookies. Экспортируйте cookies заново и обновите секрет YTDLP_COOKIES."
                else:
                    classified.message = "YouTube требует вход. Добавьте cookies в секрет YTDLP_COOKIES или настройте YTDLP_PROXY."
                raise classified from error
            last_error = classified
    if last_error:
        raise last_error
    raise WorkerError("check_failed", "Не удалось проверить доступ к YouTube.")


def handle_manual(github: GitHubAPI, job: JobStatus) -> None:
    require_existing_replacement_permission(github, job.track_id)
    source_url = env("SOURCE_URL", required=True).strip()
    validate_public_https(source_url)
    if not is_repository_owner():
        create_submission(
            github,
            job,
            "manual",
            {
                "sourceUrl": source_url,
                "candidateTitle": job.track_title or "Ручная ссылка",
                "candidateProvider": provider_for_url(source_url) or "manual",
            },
        )
        return
    work_root = Path(tempfile.mkdtemp(prefix="uncensor-manual-"))
    try:
        page_provider = provider_for_url(source_url)
        if page_provider:
            output_path, duration, downloaded_info = download_and_transcode(source_url, work_root)
            page_url = clean_text(downloaded_info.get("webpage_url"), 1000) or source_url
            title = job.track_title or clean_text(
                downloaded_info.get("track") or downloaded_info.get("title"),
                300,
            ) or "Ручная запись"
            artist = job.track_artist or clean_text(
                downloaded_info.get("artist") or downloaded_info.get("creator") or downloaded_info.get("uploader"),
                300,
            )
            uploader = clean_text(downloaded_info.get("uploader"), 300)
        else:
            download_path = work_root / "download.bin"
            output_path = work_root / "manual.m4a"
            download_public_file(source_url, download_path)
            duration = transcode_to_m4a(download_path, output_path)
            parsed = urlparse(source_url)
            page_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            title = job.track_title or "Ручная запись"
            artist = job.track_artist or ""
            uploader = ""
            page_provider = "manual"
        library = github.ensure_release(LIBRARY_TAG, "Uncensor Cloud — library")
        final_name = f"{job.track_id}.m4a"
        asset = github.upload_asset(library, final_name, output_path, "audio/mp4")
        audio_url = str(asset.get("browser_download_url") or "")
        if not audio_url.startswith("https://"):
            raise WorkerError("github_upload", "GitHub не вернул ссылку на итоговый аудиофайл.")
        source = {
            "provider": page_provider,
            "pageUrl": page_url[:1000],
            "title": title,
            "artist": artist,
            "uploader": uploader,
            "durationMs": int(round(duration * 1000)),
            "manual": True,
        }

        def mutate(index: dict[str, Any]) -> bool:
            tracks = index.setdefault("tracks", {})
            current = tracks.get(job.track_id)
            existing = current if isinstance(current, dict) else None
            tracks[job.track_id] = build_mapping(
                job.track_id,
                title,
                artist,
                int(round(duration * 1000)),
                audio_url,
                final_name,
                source,
                existing,
            )
            return True

        github.update_index(mutate)
        github.delete_track_assets(library, job.track_id, keep_name=final_name)
        job.write("published", published={"audioUrl": audio_url, "assetName": final_name})
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


def handle_reject(github: GitHubAPI, job: JobStatus) -> None:
    require_repository_owner("reject")
    number = approval_issue_number(required=True)
    try:
        github.delete_file(submission_path(job.job_id), f"uncensor-cloud: reject request {job.job_id}")
    except Exception as error:  # pragma: no cover - the rejection must still be recorded
        LOG.warning("Could not delete rejected submission: %s", error)
    job.write(
        "failed",
        error={
            "code": "rejected",
            "message": "Заявка отклонена владельцем репозитория.",
        },
        note="Проверка завершена: владелец отклонил публикацию.",
    )
    try:
        github.add_labels(number, [APPROVAL_LABELS["rejected"][0]])
        github.comment_issue(number, "❌ Владелец отклонил эту заявку. Запись не опубликована.")
        github.close_issue(number, "not_planned")
    except Exception as error:  # pragma: no cover - status is already recorded
        LOG.warning("Could not finalize rejected issue #%s: %s", number, error)


def require_repository_owner(action: str) -> None:
    if action not in ("toggle", "remove", "reject"):
        return
    actor = current_actor().casefold()
    owner = repository_owner_login().casefold()
    if not actor or not owner or actor != owner:
        raise WorkerError(
            "forbidden",
            "Удалять замены, менять их для всех и проверять заявки может только владелец репозитория.",
            f"actor={actor or 'unknown'} owner={owner or 'unknown'}",
            403,
        )


def handle_toggle(github: GitHubAPI, job: JobStatus) -> None:
    require_repository_owner("toggle")
    enabled = env("ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
    missing: list[bool] = []

    def mutate(index: dict[str, Any]) -> bool:
        tracks = index.setdefault("tracks", {})
        mapping = tracks.get(job.track_id)
        if not isinstance(mapping, dict):
            missing.append(True)
            return False
        mapping["enabled"] = enabled
        mapping["updatedAt"] = iso_now()
        return True

    github.update_index(mutate)
    if missing:
        raise WorkerError("mapping_missing", "Связь для трека не найдена в list.json.")
    job.write("updated", enabled=enabled)


def handle_remove(github: GitHubAPI, job: JobStatus) -> None:
    require_repository_owner("remove")

    def mutate(index: dict[str, Any]) -> bool:
        tracks = index.setdefault("tracks", {})
        if job.track_id not in tracks:
            return False
        del tracks[job.track_id]
        return True

    github.update_index(mutate)
    library = github.get_release(LIBRARY_TAG)
    if library:
        github.delete_track_assets(library, job.track_id)
    job.write("removed", note="Аудиофайлы трека удалены из Releases.")


def validate_inputs(action: str, job_id: str, track_id: str) -> None:
    if not JOB_ID_RE.fullmatch(job_id):
        raise WorkerError("input_invalid", "Некорректный job_id.")
    if not TRACK_ID_RE.fullmatch(track_id):
        raise WorkerError("input_invalid", "Некорректный ID трека Яндекс Музыки.")
    if action not in ("search", "confirm", "manual", "toggle", "remove", "reject", "check"):
        raise WorkerError("input_invalid", f"Неизвестное действие: {action}")


def report_approval_failure(github: GitHubAPI, error: WorkerError) -> None:  # pragma: no cover - network path
    number = approval_issue_number()
    if not number:
        return
    try:
        github.comment_issue(
            number,
            "\n".join(
                [
                    "❌ Не удалось опубликовать заявку.",
                    "",
                    f"**{error.message}**",
                    "",
                    f"`{clean_text(error.detail, 1200)}`" if error.detail else "",
                    "",
                    "Можно отклонить заявку меткой или исправить проблему и добавить метку подтверждения ещё раз.",
                ]
            ).strip(),
        )
    except Exception as comment_error:
        LOG.warning("Could not report approval failure: %s", comment_error)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    action = env("ACTION", required=True).strip()
    job_id = env("JOB_ID", required=True).strip()
    track_id = env("TRACK_ID", required=True).strip()
    repo = env("GITHUB_REPOSITORY", required=True).strip()
    branch = env("GITHUB_REF_NAME", required=True).strip()
    token = env("GITHUB_TOKEN", required=True).strip()

    job: JobStatus | None = None
    github: GitHubAPI | None = None
    try:
        validate_inputs(action, job_id, track_id)
        require_repository_owner(action)
        github = GitHubAPI(token, repo, branch)
        job = JobStatus(github, action, job_id, repo, branch)
        job.write("running")
        try:
            github.cleanup_legacy_previews()
        except Exception as cleanup_error:  # pragma: no cover - cleanup must not block the job
            LOG.warning("Legacy previews cleanup failed: %s", cleanup_error)
        if action == "search":
            handle_search(github, job)
        elif action == "confirm":
            handle_confirm(github, job)
            finalize_approval(github, job)
        elif action == "manual":
            handle_manual(github, job)
            finalize_approval(github, job)
        elif action == "toggle":
            handle_toggle(github, job)
        elif action == "remove":
            handle_remove(github, job)
        elif action == "reject":
            handle_reject(github, job)
        elif action == "check":
            handle_check(github, job)
        LOG.info("Job %s completed as %s", job_id, action)
        return 0
    except WorkerError as error:
        LOG.error("%s: %s %s", error.code, error.message, error.detail)
        if job is not None:
            try:
                job.write("failed", error=error_payload(error))
            except Exception as write_error:  # pragma: no cover
                LOG.error("Could not write failure status: %s", write_error)
        if github is not None and approval_issue_number():
            report_approval_failure(github, error)
        return 1
    except Exception as error:  # pragma: no cover - last-resort safety net
        LOG.exception("Unexpected worker error")
        if job is not None:
            try:
                job.write(
                    "failed",
                    error={
                        "code": "internal",
                        "message": "Внутренняя ошибка обработчика.",
                        "detail": truncate_text(error, 1500),
                    },
                )
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
