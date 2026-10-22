#!/usr/bin/env python3
"""Uncensor Cloud GitHub Actions worker.

The worker runs only inside the user's public repository. It searches public
sources with yt-dlp, publishes previews to the "previews" release, and copies a
user-selected preview to the "library" release before updating list.json.
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

PREVIEWS_TAG = "previews"
LIBRARY_TAG = "library"
INDEX_FILE = "list.json"
JOBS_DIR = "jobs"
PREVIEW_LIMIT = 5
AUDIO_LIMIT_BYTES = 300 * 1024 * 1024
DOWNLOAD_TIMEOUT = (20, 120)
USER_AGENT = "UncensorCloud/1.0 (+https://github.com/)"

JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$")
TRACK_ID_RE = re.compile(r"^[0-9]{1,24}$")


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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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

    def download_asset(self, asset: dict[str, Any], destination: Path, max_bytes: int = AUDIO_LIMIT_BYTES) -> None:
        url = asset.get("url")
        if not isinstance(url, str) or not url:
            raise WorkerError("github_asset", "У asset нет API-ссылки.")
        response = self.session.get(
            url,
            headers={"Accept": "application/octet-stream"},
            stream=True,
            allow_redirects=True,
            timeout=DOWNLOAD_TIMEOUT,
        )
        if not response.ok:
            raise self._error(response, "Не удалось скачать asset")
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
                    raise WorkerError("asset_too_large", "Asset больше допустимого размера.")
                handle.write(chunk)
        response.close()
        if total < 1024:
            destination.unlink(missing_ok=True)
            raise WorkerError("asset_empty", "Asset пустой.")


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
        self.run_url = self._run_url()

    def _run_url(self) -> str:
        server = env("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
        run_id = env("GITHUB_RUN_ID", "")
        return f"{server}/{self.repo}/actions/runs/{run_id}" if run_id else ""

    def write(self, status: str, **fields: Any) -> None:
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
            "createdAt": self.created_at,
            "updatedAt": iso_now(),
            "expiresAt": iso_after(7),
        }
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
        "http_headers": {"User-Agent": USER_AGENT},
    }


def search_entries(provider: str, query: str) -> list[dict[str, Any]]:
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
        raise WorkerError("download_failed", "Не удалось скачать аудио из источника.", truncate_text(error, 1500)) from error
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
    output = target_dir / "preview.m4a"
    try:
        duration = transcode_to_m4a(downloaded, output)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    return output, duration, info


def make_preview_candidate(
    github: GitHubAPI,
    previews_release: dict[str, Any],
    job_id: str,
    raw: dict[str, Any],
    target_title: str,
    target_artist: str,
    target_sec: int,
    work_dir: Path,
    page_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    page_url = str(raw.get("pageUrl") or "")
    validate_public_https(page_url)
    preview_path, duration, downloaded_info = download_and_transcode(page_url, work_dir)
    duration_sec = int(round(duration))
    if not duration_acceptable(target_sec, duration_sec):
        if not target_sec:
            raise WorkerError("duration_mismatch", "Длительность записи вне допустимого диапазона.")
        raise WorkerError(
            "duration_mismatch",
            f"Длительность не совпадает: у записи {duration_sec} с, у трека {target_sec} с.",
        )
    title = clean_text(raw.get("title") or downloaded_info.get("title"), 300) or "Без названия"
    uploader = clean_text(raw.get("uploader") or downloaded_info.get("uploader") or downloaded_info.get("channel"), 200)
    artist = clean_text(raw.get("artist") or downloaded_info.get("artist") or downloaded_info.get("creator"), 200)
    if page_info:
        title = clean_text(page_info.get("track") or page_info.get("title") or title, 300)
        uploader = clean_text(page_info.get("uploader") or page_info.get("channel") or uploader, 200)
        artist = clean_text(page_info.get("artist") or page_info.get("creator") or artist, 200)
    score = score_candidate(target_title, target_artist, title, uploader or artist, target_sec, duration_sec)
    if page_info:
        score = max(score, 0.8)
    identifier = candidate_id(page_url)
    asset_name = f"{job_id}-{identifier}.m4a"
    digest = sha256_file(preview_path)
    size = preview_path.stat().st_size
    asset = github.upload_asset(previews_release, asset_name, preview_path, "audio/mp4")
    preview_url = str(asset.get("browser_download_url") or "")
    if not preview_url.startswith("https://"):
        raise WorkerError("github_upload", "GitHub не вернул публичную ссылку на preview.")
    warnings = candidate_warnings(target_title, target_artist, {"title": title, "uploader": uploader or artist}, target_sec, duration_sec, score)
    if page_info:
        warnings.insert(0, "выбрано вручную по указанной ссылке")
    provider = raw.get("provider")
    if provider not in ("youtube", "soundcloud"):
        provider = "youtube" if "youtu" in page_url else "soundcloud" if "soundcloud" in page_url else "youtube"
    return {
        "id": identifier,
        "provider": provider,
        "pageUrl": page_url,
        "title": title,
        "artist": artist,
        "uploader": uploader,
        "durationMs": duration_sec * 1000,
        "score": score,
        "warnings": warnings,
        "previewUrl": preview_url,
        "assetName": asset_name,
        "sizeBytes": size,
        "sha256": digest,
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
    manual_page: dict[str, Any] | None = None

    if source_url:
        try:
            info = extract_single_page(source_url)
            webpage = str(info.get("webpage_url") or source_url)
            raw_candidates.append(
                {
                    "provider": "youtube" if "youtu" in webpage else "soundcloud" if "soundcloud" in webpage else "youtube",
                    "pageUrl": source_url,
                    "title": clean_text(info.get("track") or info.get("title"), 300),
                    "artist": clean_text(info.get("artist") or info.get("creator"), 200),
                    "uploader": clean_text(info.get("uploader") or info.get("channel"), 200),
                    "duration": int(info.get("duration") or 0),
                    "isLive": bool(info.get("is_live")),
                }
            )
            manual_page = info
        except WorkerError as error:
            provider_errors.append(f"указанная ссылка: {error.message}")

    for provider in ("youtube", "soundcloud"):
        try:
            raw_candidates.extend(search_entries(provider, query))
        except WorkerError as error:
            provider_errors.append(f"{provider}: {error.message} {error.detail}".strip())

    seen_urls: set[str] = set()
    ranked: list[dict[str, Any]] = []
    for candidate in raw_candidates:
        page_url = str(candidate.get("pageUrl") or "")
        if not page_url or page_url in seen_urls or candidate.get("isLive"):
            continue
        seen_urls.add(page_url)
        duration = int(candidate.get("duration") or 0)
        if source_url and page_url == source_url:
            candidate["forced"] = True
        elif duration and not duration_acceptable(target_sec, duration):
            continue
        candidate["score"] = 1.0 if candidate.get("forced") else score_candidate(
            target_title,
            target_artist,
            str(candidate.get("title") or ""),
            str(candidate.get("uploader") or candidate.get("artist") or ""),
            target_sec,
            duration,
        )
        if not candidate.get("forced") and candidate["score"] < 0.28:
            continue
        ranked.append(candidate)

    ranked.sort(key=lambda item: (1 if item.get("forced") else 0, float(item.get("score") or 0)), reverse=True)
    if not ranked:
        raise WorkerError(
            "no_candidates",
            "Подходящие записи не найдены.",
            " ".join(provider_errors)[:3000] or "Поиск не вернул результатов.",
        )

    previews = github.ensure_release(PREVIEWS_TAG, "Uncensor Cloud — previews")
    work_root = Path(tempfile.mkdtemp(prefix="uncensor-search-"))
    accepted: list[dict[str, Any]] = []
    download_errors: list[str] = []
    try:
        for index, candidate in enumerate(ranked[:12]):
            if len(accepted) >= PREVIEW_LIMIT:
                break
            page_url = str(candidate.get("pageUrl") or "")
            try:
                prepared = make_preview_candidate(
                    github,
                    previews,
                    job.job_id,
                    candidate,
                    target_title,
                    target_artist,
                    target_sec,
                    work_root,
                    manual_page if candidate.get("forced") else None,
                )
                if any(item["pageUrl"] == prepared["pageUrl"] for item in accepted):
                    continue
                accepted.append(prepared)
            except WorkerError as error:
                download_errors.append(f"{index + 1}. {error.message}")
            except Exception as error:  # keep other candidates alive
                download_errors.append(f"{index + 1}. {truncate_text(error, 300)}")
    finally:
        shutil.rmtree(work_root, ignore_errors=True)

    if not accepted:
        detail_parts = provider_errors + download_errors
        raise WorkerError(
            "no_candidates",
            "Не удалось подготовить ни одного кандидата.",
            " ".join(detail_parts)[:4000] or "Все источники отклонили загрузку.",
        )
    accepted.sort(key=lambda item: (float(item.get("score") or 0), int(item.get("durationMs") or 0)), reverse=True)
    job.write("ready", candidates=accepted, warnings=provider_errors[:8])


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
        history = existing.get("history")
        history_items = history if isinstance(history, list) else []
        old_url = existing.get("audioUrl")
        if old_url and old_url != audio_url:
            history_items = [
                {
                    "audioUrl": old_url,
                    "assetName": str(existing.get("assetName") or ""),
                    "source": existing.get("source") if isinstance(existing.get("source"), dict) else {},
                    "replacedAt": now,
                },
                *history_items,
            ][:20]
        if history_items:
            mapping["history"] = history_items[:20]
        mapping["enabled"] = True
    return mapping


def handle_confirm(github: GitHubAPI, job: JobStatus) -> None:
    source_job_id = env("SOURCE_JOB_ID", required=True)
    candidate_id_value = env("CANDIDATE_ID", required=True)
    if not JOB_ID_RE.fullmatch(source_job_id):
        raise WorkerError("input_invalid", "Некорректный source_job_id.")
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

    previews = github.ensure_release(PREVIEWS_TAG, "Uncensor Cloud — previews")
    asset_name = str(candidate.get("assetName") or "")
    if not asset_name or "/" in asset_name:
        raise WorkerError("candidate_invalid", "У кандидата некорректное имя preview-файла.")
    asset = github.find_asset(previews, asset_name)
    if not asset:
        raise WorkerError("preview_missing", "Preview-файл кандидата не найден в релизе previews.")
    work_root = Path(tempfile.mkdtemp(prefix="uncensor-confirm-"))
    preview_path = work_root / "preview.m4a"
    try:
        github.download_asset(asset, preview_path)
        expected_sha = str(candidate.get("sha256") or "")
        if expected_sha and sha256_file(preview_path) != expected_sha:
            raise WorkerError("preview_changed", "SHA-256 preview-файла не совпал. Повторите поиск.")
        duration = ffprobe_duration(preview_path)
        library = github.ensure_release(LIBRARY_TAG, "Uncensor Cloud — library")
        track_id = job.track_id
        final_name = f"{track_id}-{candidate_id_value}.m4a"
        final_asset = github.upload_asset(library, final_name, preview_path, "audio/mp4")
        audio_url = str(final_asset.get("browser_download_url") or "")
        if not audio_url.startswith("https://"):
            raise WorkerError("github_upload", "GitHub не вернул ссылку на итоговый аудиофайл.")
        title = job.track_title or clean_text(candidate.get("title"), 300)
        artist = job.track_artist or clean_text(candidate.get("artist") or candidate.get("uploader"), 300)
        source = {
            "provider": candidate.get("provider") if candidate.get("provider") in ("youtube", "soundcloud") else "unknown",
            "pageUrl": clean_text(candidate.get("pageUrl"), 1000),
            "title": clean_text(candidate.get("title"), 300),
            "artist": clean_text(candidate.get("artist"), 300),
            "uploader": clean_text(candidate.get("uploader"), 300),
            "durationMs": int(candidate.get("durationMs") or 0),
            "score": float(candidate.get("score") or 0),
            "warnings": candidate.get("warnings") if isinstance(candidate.get("warnings"), list) else [],
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
                int(round(duration * 1000)),
                audio_url,
                final_name,
                source,
                existing,
            )
            return True

        github.update_index(mutate)
        job.write(
            "published",
            published={"audioUrl": audio_url, "assetName": final_name},
            candidateId=candidate_id_value,
            sourceJobId=source_job_id,
        )
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


def handle_manual(github: GitHubAPI, job: JobStatus) -> None:
    source_url = env("SOURCE_URL", required=True).strip()
    validate_public_https(source_url)
    work_root = Path(tempfile.mkdtemp(prefix="uncensor-manual-"))
    download_path = work_root / "download.bin"
    output_path = work_root / "manual.m4a"
    try:
        download_public_file(source_url, download_path)
        duration = transcode_to_m4a(download_path, output_path)
        library = github.ensure_release(LIBRARY_TAG, "Uncensor Cloud — library")
        source_hash = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:10]
        final_name = f"{job.track_id}-manual-{source_hash}.m4a"
        asset = github.upload_asset(library, final_name, output_path, "audio/mp4")
        audio_url = str(asset.get("browser_download_url") or "")
        if not audio_url.startswith("https://"):
            raise WorkerError("github_upload", "GitHub не вернул ссылку на итоговый аудиофайл.")
        parsed = urlparse(source_url)
        source_origin = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        title = job.track_title or "Ручная запись"
        artist = job.track_artist or ""
        source = {
            "provider": "manual",
            "pageUrl": source_origin[:1000],
            "title": title,
            "artist": artist,
            "uploader": "",
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
        job.write("published", published={"audioUrl": audio_url, "assetName": final_name})
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


def handle_toggle(github: GitHubAPI, job: JobStatus) -> None:
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
    def mutate(index: dict[str, Any]) -> bool:
        tracks = index.setdefault("tracks", {})
        if job.track_id not in tracks:
            return False
        del tracks[job.track_id]
        return True

    github.update_index(mutate)
    job.write("removed", note="Аудиофайл в Releases не удаляется.")


def validate_inputs(action: str, job_id: str, track_id: str) -> None:
    if not JOB_ID_RE.fullmatch(job_id):
        raise WorkerError("input_invalid", "Некорректный job_id.")
    if not TRACK_ID_RE.fullmatch(track_id):
        raise WorkerError("input_invalid", "Некорректный ID трека Яндекс Музыки.")
    if action not in ("search", "confirm", "manual", "toggle", "remove"):
        raise WorkerError("input_invalid", f"Неизвестное действие: {action}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    action = env("ACTION", required=True).strip()
    job_id = env("JOB_ID", required=True).strip()
    track_id = env("TRACK_ID", required=True).strip()
    repo = env("GITHUB_REPOSITORY", required=True).strip()
    branch = env("GITHUB_REF_NAME", required=True).strip()
    token = env("GITHUB_TOKEN", required=True).strip()

    job: JobStatus | None = None
    try:
        validate_inputs(action, job_id, track_id)
        github = GitHubAPI(token, repo, branch)
        job = JobStatus(github, action, job_id, repo, branch)
        job.write("running")
        if action == "search":
            handle_search(github, job)
        elif action == "confirm":
            handle_confirm(github, job)
        elif action == "manual":
            handle_manual(github, job)
        elif action == "toggle":
            handle_toggle(github, job)
        elif action == "remove":
            handle_remove(github, job)
        LOG.info("Job %s completed as %s", job_id, action)
        return 0
    except WorkerError as error:
        LOG.error("%s: %s %s", error.code, error.message, error.detail)
        if job is not None:
            try:
                job.write("failed", error=error_payload(error))
            except Exception as write_error:  # pragma: no cover
                LOG.error("Could not write failure status: %s", write_error)
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
