#!/usr/bin/env python3
"""Process owner-approved requests locally and publish audio to GitHub."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent if (SCRIPT_DIR.parent / "cloud" / "uncensor_worker.py").exists() else SCRIPT_DIR
sys.path.insert(0, str(ROOT))

from cloud import uncensor_worker as worker  # noqa: E402

REQUEST_PREFIX = "stupidcensor-request-v1\n```json\n"
DEFAULT_REPO = "xaundz/stupidcensor-cloud"
KEYCHAIN_SERVICE = "stupidcensor-local-token"
LOCAL_LABEL = worker.APPROVAL_LABELS["local"][0]
ALLOWED_ACTIONS = ("confirm", "manual")


class LocalError(Exception):
    pass


def github_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token.strip()
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    if sys.platform == "darwin":
        result = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    raise LocalError(
        "Не найден GitHub-токен. Запустите install-token.command или задайте GITHUB_TOKEN. "
        "Токену нужны Contents: Read and write и Issues: Read and write."
    )


def api(
    github: worker.GitHubAPI,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    response = github.session.request(
        method,
        f"{github.api_url}/repos/{github.repo}{path}",
        params=params,
        json=json_body,
        timeout=30,
    )
    if not response.ok:
        message = ""
        try:
            payload = response.json()
            if isinstance(payload, dict) and isinstance(payload.get("message"), str):
                message = payload["message"]
        except Exception:
            pass
        raise LocalError(f"GitHub API: HTTP {response.status_code} {worker.truncate_text(message, 300)}")
    if response.status_code == 204:
        return None
    return response.json()


def owner_login(github: worker.GitHubAPI) -> str:
    response = github.session.get(f"{github.api_url}/user", timeout=30)
    if not response.ok:
        raise LocalError("GitHub не подтвердил токен. Проверьте срок действия и права.")
    payload = response.json()
    login = payload.get("login") if isinstance(payload, dict) else None
    if not isinstance(login, str) or not login:
        raise LocalError("GitHub не вернул имя пользователя.")
    return login


def default_branch(github: worker.GitHubAPI) -> str:
    payload = api(github, "GET", "")
    branch = payload.get("default_branch") if isinstance(payload, dict) else None
    if not isinstance(branch, str) or not branch:
        raise LocalError("GitHub не вернул основную ветку репозитория.")
    return branch


def issue_job_id(body: str) -> str:
    if body.startswith(REQUEST_PREFIX):
        envelope = body[len(REQUEST_PREFIX):]
        if envelope.endswith("\n```"):
            envelope = envelope[:-4]
        try:
            payload = json.loads(envelope)
        except json.JSONDecodeError as error:
            raise LocalError("В заявке повреждён JSON.") from error
        job_id = payload.get("id") if isinstance(payload, dict) else None
        if isinstance(job_id, str) and worker.JOB_ID_RE.fullmatch(job_id):
            return job_id
    match = re.search(r"\*\*Задание:\*\*\s*`([A-Za-z0-9][A-Za-z0-9._-]{7,80})`", body)
    if match:
        return match.group(1)
    raise LocalError("В заявке не найден ID задания.")


def submission_for_issue(github: worker.GitHubAPI, issue: dict[str, Any]) -> dict[str, Any]:
    number = issue.get("number")
    body = issue.get("body")
    if type(number) is not int or number <= 0 or not isinstance(body, str):
        raise LocalError("Некорректная заявка GitHub.")
    job_id = issue_job_id(body)
    submission = github.get_json(worker.submission_path(job_id))
    if not submission:
        raise LocalError("Данные заявки не найдены или уже обработаны.")
    if int(submission.get("issueNumber") or 0) != number:
        raise LocalError("Данные заявки относятся к другому Issue.")
    action = submission.get("action")
    track_id = submission.get("trackId")
    if action not in ALLOWED_ACTIONS or not isinstance(track_id, str):
        raise LocalError("Заявка не поддерживает локальную загрузку.")
    worker.validate_inputs(action, job_id, track_id)
    return submission


def list_approved(github: worker.GitHubAPI) -> list[dict[str, Any]]:
    payload = api(
        github,
        "GET",
        "/issues",
        params={"state": "open", "labels": f"uncensor-request,{LOCAL_LABEL}", "per_page": 50},
    )
    if not isinstance(payload, list):
        raise LocalError("GitHub вернул некорректный список заявок.")
    result: list[dict[str, Any]] = []
    for issue in payload:
        if not isinstance(issue, dict) or issue.get("pull_request"):
            continue
        labels = {
            item if isinstance(item, str) else item.get("name")
            for item in issue.get("labels", [])
            if isinstance(item, (str, dict))
        }
        if "uncensor-request" in labels and LOCAL_LABEL in labels:
            result.append(issue)
    return result


def remove_local_label(github: worker.GitHubAPI, number: int) -> None:
    response = github.session.delete(
        f"{github.api_url}/repos/{github.repo}/issues/{number}/labels/{quote(LOCAL_LABEL, safe='')}",
        timeout=30,
    )
    if not response.ok and response.status_code != 404:
        raise LocalError(f"Не удалось снять метку {LOCAL_LABEL} с заявки #{number}.")


def comment_failure(github: worker.GitHubAPI, number: int, error: worker.WorkerError) -> None:
    lines = [
        "❌ Локальная загрузка не удалась.",
        "",
        f"**{error.message}**",
        "",
        "Заявка оставлена открытой. Исправьте причину и снова нажмите «Принять» в аддоне.",
    ]
    if error.code:
        lines += ["", f"Код: `{error.code}`"]
    try:
        github.comment_issue(number, "\n".join(lines))
    except Exception:
        pass


@contextmanager
def worker_environment(values: dict[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def process_issue(
    github: worker.GitHubAPI,
    repo: str,
    branch: str,
    owner: str,
    issue: dict[str, Any],
    args: argparse.Namespace,
) -> bool:
    number = int(issue["number"])
    try:
        submission = submission_for_issue(github, issue)
    except (LocalError, worker.WorkerError) as error:
        failure = error if isinstance(error, worker.WorkerError) else worker.WorkerError(
            "local_request", str(error)
        )
        print(f"[заявка #{number}] ошибка: {failure.code}: {failure.message}", flush=True)
        comment_failure(github, number, failure)
        try:
            remove_local_label(github, number)
        except Exception as label_error:
            print(f"[заявка #{number}] не удалось снять метку: {label_error}", flush=True)
        return False
    action = str(submission["action"])
    job_id = str(submission["jobId"])
    track_id = str(submission["trackId"])
    title = worker.clean_text(submission.get("trackTitle"), 300)
    artist = worker.clean_text(submission.get("trackArtist"), 300)
    duration = max(0, int(submission.get("trackDurationMs") or 0)) // 1000
    source_url = worker.clean_text(submission.get("sourceUrl"), 1000)
    source_job_id = worker.clean_text(submission.get("sourceJobId"), 100)
    candidate_id = worker.clean_text(submission.get("candidateId"), 100)
    requested_by = worker.clean_text(submission.get("requestedBy"), 100)
    print(f"[заявка #{number}] {artist or '—'} — {title or track_id}", flush=True)

    values = {
        "GITHUB_TOKEN": args.token_value,
        "GITHUB_REPOSITORY": repo,
        "GITHUB_REF_NAME": branch,
        "GITHUB_ACTOR": owner,
        "REPOSITORY_OWNER": owner,
        "GITHUB_SERVER_URL": "https://github.com",
        "GITHUB_RUN_ID": "",
        "ACTION": action,
        "JOB_ID": job_id,
        "TRACK_ID": track_id,
        "TITLE": title,
        "ARTIST": artist,
        "DURATION": str(duration),
        "SOURCE_URL": source_url,
        "SOURCE_JOB_ID": source_job_id,
        "CANDIDATE_ID": candidate_id,
        "APPROVAL_ISSUE": str(number),
        "YTDLP_COOKIES": args.cookie_text,
        "YTDLP_PROXY": args.proxy or "",
        "YTDLP_COOKIES_FROM_BROWSER": args.cookies_from_browser or "",
    }
    job: worker.JobStatus | None = None
    with worker_environment(values):
        try:
            job = worker.JobStatus(github, action, job_id, repo, branch)
            job.issue_number = number
            job.issue_url = str(issue.get("html_url") or f"https://github.com/{repo}/issues/{number}")
            job.requested_by = requested_by
            job.write("running", note="Локальная загрузка на компьютере владельца.")
            if action == "confirm":
                worker.handle_confirm(github, job)
            else:
                worker.handle_manual(github, job)
            worker.finalize_approval(github, job)
            print(f"[заявка #{number}] опубликовано", flush=True)
            return True
        except worker.WorkerError as error:
            print(f"[заявка #{number}] ошибка: {error.code}: {error.message}", flush=True)
            if job is not None:
                try:
                    job.write("failed", error=worker.error_payload(error))
                except Exception:
                    pass
            comment_failure(github, number, error)
            try:
                remove_local_label(github, number)
            except Exception as label_error:
                print(f"[заявка #{number}] не удалось снять метку: {label_error}", flush=True)
            return False
        except Exception as error:
            failure = worker.WorkerError("local_failed", "Ошибка локального помощника.", str(error))
            print(f"[заявка #{number}] ошибка: {failure.message}", flush=True)
            if job is not None:
                try:
                    job.write("failed", error=worker.error_payload(failure))
                except Exception:
                    pass
            comment_failure(github, number, failure)
            try:
                remove_local_label(github, number)
            except Exception:
                pass
            return False


def run_once(github: worker.GitHubAPI, repo: str, branch: str, owner: str, args: argparse.Namespace) -> int:
    issues = list_approved(github)
    if not issues:
        print("Новых заявок с меткой локальной загрузки нет.", flush=True)
        return 0
    print(f"Найдено заявок: {len(issues)}", flush=True)
    if args.dry_run:
        for issue in issues:
            print(f"#{issue.get('number')} {issue.get('title') or ''}", flush=True)
        return 0
    processed = 0
    for issue in issues:
        if process_issue(github, repo, branch, owner, issue, args):
            processed += 1
        time.sleep(1)
    return 0 if processed == len(issues) else 1


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Скачивает одобренные заявки на этом компьютере и публикует аудио в GitHub Releases.",
    )
    result.add_argument("--repo", default=os.environ.get("STUPIDCENSOR_REPO", DEFAULT_REPO))
    result.add_argument("--branch", default=os.environ.get("STUPIDCENSOR_BRANCH", ""))
    result.add_argument("--token", default="", help="Токен GitHub. Лучше использовать Keychain или GITHUB_TOKEN.")
    result.add_argument("--cookies-file", type=Path, help="Netscape cookies.txt только для youtube.com.")
    result.add_argument(
        "--cookies-from-browser",
        default=os.environ.get("YTDLP_COOKIES_FROM_BROWSER", ""),
        help="Взять cookies YouTube из браузера: chrome, firefox, edge, brave, safari.",
    )
    result.add_argument("--proxy", default=os.environ.get("YTDLP_PROXY", ""), help="Необязательный прокси.")
    result.add_argument("--interval", type=int, default=20, help="Пауза между проверками, секунд.")
    result.add_argument("--once", action="store_true", help="Проверить очередь один раз и выйти.")
    result.add_argument("--dry-run", action="store_true", help="Показать очередь, ничего не скачивать.")
    return result


def main() -> int:
    args = parser().parse_args()
    args.repo = worker.clean_text(args.repo, 140)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise LocalError("Укажите репозиторий в формате владелец/репозиторий.")
    if args.cookies_file:
        try:
            args.cookie_text = args.cookies_file.read_text(encoding="utf-8")
        except OSError as error:
            raise LocalError(f"Не удалось прочитать cookies: {error.strerror or 'ошибка файла'}.") from error
    else:
        args.cookie_text = os.environ.get("YTDLP_COOKIES", "").strip()
    if args.cookie_text and len(args.cookie_text.encode("utf-8")) > 256 * 1024:
        raise LocalError("Файл cookies слишком большой.")
    if args.cookies_from_browser:
        with worker_environment({"YTDLP_COOKIES_FROM_BROWSER": args.cookies_from_browser}):
            worker.local_browser_cookie_option()
    args.proxy = (args.proxy or "").strip()
    args.interval = max(5, min(300, int(args.interval)))
    args.token_value = github_token(args)
    github = worker.GitHubAPI(args.token_value, args.repo, args.branch or "main")
    owner = owner_login(github)
    repo_owner = args.repo.split("/", 1)[0]
    if owner.casefold() != repo_owner.casefold():
        raise LocalError(f"Токен принадлежит {owner}, а репозиторий — {repo_owner}. Нужен токен владельца.")
    branch = args.branch or default_branch(github)
    github.branch = branch
    worker.ensure_approval_labels(github)
    print(f"stupidCensor local publisher: {args.repo}@{branch}", flush=True)
    print("Ожидаю заявки с меткой «Принять» в панели stupidCensor. Ctrl+C — выход.", flush=True)
    if args.once or args.dry_run:
        return run_once(github, args.repo, branch, owner, args)
    while True:
        try:
            run_once(github, args.repo, branch, owner, args)
        except LocalError as error:
            print(f"Ошибка: {error}", flush=True)
        except Exception as error:
            print(f"Ошибка сети или GitHub: {worker.truncate_text(error, 300)}", flush=True)
        time.sleep(args.interval)


def locked_main() -> int:
    lock_path = Path(tempfile.gettempdir()) / "stupidcensor-local-publisher.lock"
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Локальный помощник уже запущен.", file=sys.stderr)
            return 2
        try:
            return main()
        except (LocalError, worker.WorkerError) as error:
            print(f"Ошибка: {error}", file=sys.stderr)
            return 2
        except KeyboardInterrupt:
            print("\nОстановлено.", file=sys.stderr)
            return 0


if __name__ == "__main__":
    sys.exit(locked_main())
