import base64
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import textwrap
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "cloud"))

import uncensor_worker as worker  # noqa: E402


class TextTests(unittest.TestCase):
    def test_normalize_text(self):
        self.assertEqual(worker.normalize_text("  Кино — Группа Крови! "), "кино группа крови")
        self.assertEqual(worker.normalize_text("Ёлка / Мой мир"), "елка мой мир")

    def test_similarity_prefers_real_match(self):
        good = worker.similarity("Кино Группа крови", "Кино - Группа крови (official audio)")
        bad = worker.similarity("Кино Группа крови", "Кино - Звезда по имени Солнце")
        self.assertGreater(good, bad)
        self.assertGreater(good, 0.6)

    def test_split_artists(self):
        self.assertEqual(worker.split_artists("Кино, Виктор Цой"), ["Кино", "Виктор Цой"])
        self.assertEqual(worker.split_artists("A feat. B"), ["A", "B"])


class DurationTests(unittest.TestCase):
    def test_duration_limits(self):
        self.assertTrue(worker.duration_acceptable(245, 247))
        self.assertTrue(worker.duration_acceptable(245, 220))
        self.assertFalse(worker.duration_acceptable(245, 320))
        self.assertFalse(worker.duration_acceptable(0, 10))
        self.assertTrue(worker.duration_acceptable(0, 90))

    def test_duration_score(self):
        self.assertAlmostEqual(worker.duration_score(200, 200), 1.0)
        self.assertLess(worker.duration_score(200, 260), 1.0)
        self.assertEqual(worker.duration_score(0, 200), 0.5)


class ScoreTests(unittest.TestCase):
    def test_exact_candidate_scores_high(self):
        score = worker.score_candidate("Группа крови", "Кино", "Кино - Группа крови", "Кино", 245, 246)
        self.assertGreaterEqual(score, 0.85)

    def test_unrelated_candidate_scores_low(self):
        score = worker.score_candidate("Группа крови", "Кино", "AC/DC - Thunderstruck", "AC/DC", 245, 245)
        self.assertLess(score, 0.4)

    def test_warnings_flag_versions(self):
        warnings = worker.candidate_warnings(
            "Группа крови",
            "Кино",
            {"title": "Группа крови (cover)", "uploader": "Someone"},
            245,
            180,
            0.4,
        )
        joined = " ".join(warnings).lower()
        self.assertIn("кавер", joined)
        self.assertIn("цензур", joined)
        self.assertIn("длительность", joined)


class SourceErrorTests(unittest.TestCase):
    def test_drm_is_classified(self):
        error = worker.classify_source_error(Exception("ERROR: [soundcloud] 1: This video is DRM protected"))
        self.assertEqual(error.code, "source_drm")
        self.assertIn("DRM", error.message)

    def test_youtube_bot_check_is_classified(self):
        error = worker.classify_source_error(
            Exception("ERROR: [youtube] abc: Sign in to confirm you’re not a bot.")
        )
        self.assertEqual(error.code, "youtube_auth")
        self.assertIn("YTDLP_COOKIES", error.message)

    def test_soundcloud_drm_probe_marks_unavailable(self):
        with patch(
            "uncensor_worker.extract_single_page",
            side_effect=worker.WorkerError(
                "source_extract_failed",
                "Не удалось прочитать страницу.",
                "ERROR: [soundcloud] 1088122189: This video is DRM protected",
            ),
        ):
            reason = worker.probe_candidate_availability("https://soundcloud.com/a/b", "soundcloud")
        self.assertIn("DRM", reason)

class PermissionTests(unittest.TestCase):
    def test_only_owner_can_remove(self):
        with patch.dict(
            os.environ,
            {"GITHUB_ACTOR": "friend", "GITHUB_REPOSITORY": "owner/repo", "REPOSITORY_OWNER": "owner"},
            clear=True,
        ):
            with self.assertRaises(worker.WorkerError):
                worker.require_repository_owner("remove")
        with patch.dict(
            os.environ,
            {"GITHUB_ACTOR": "owner", "GITHUB_REPOSITORY": "owner/repo", "REPOSITORY_OWNER": "owner"},
            clear=True,
        ):
            worker.require_repository_owner("remove")

    def test_non_destructive_actions_are_allowed(self):
        with patch.dict(os.environ, {}, clear=True):
            worker.require_repository_owner("confirm")

    def test_collaborator_cannot_overwrite_existing_replacement(self):
        class FakeGitHub:
            def get_json(self, path):
                return {"tracks": {"123": {"audioUrl": "https://example.com/a.m4a"}}}

        with patch.dict(
            os.environ,
            {"GITHUB_ACTOR": "friend", "GITHUB_REPOSITORY": "owner/repo", "REPOSITORY_OWNER": "owner"},
            clear=True,
        ):
            with self.assertRaises(worker.WorkerError):
                worker.require_existing_replacement_permission(FakeGitHub(), "123")
            worker.require_existing_replacement_permission(FakeGitHub(), "456")


class FakeCheckJob:
    def __init__(self):
        self.writes = []

    def write(self, status, **fields):
        self.writes.append((status, fields))


class FakeYoutubeDL:
    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def extract_info(self, url, download=False):
        return {"id": "test", "title": "test"}


class FakeYoutubeModule:
    YoutubeDL = FakeYoutubeDL


class CookieTests(unittest.TestCase):
    COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tempty\t"

    def test_cookie_tabs_permissions_and_no_rewrite(self):
        for encoded in (False, True, "wrapped"):
            with self.subTest(encoded=encoded), tempfile.TemporaryDirectory() as directory:
                value = "base64:" + base64.b64encode(self.COOKIES.encode()).decode() if encoded else self.COOKIES
                if encoded == "wrapped":
                    value = value[:20] + "\n" + value[20:] + "\n"
                with patch.dict(os.environ, {"YTDLP_COOKIES": value}, clear=True), \
                        patch.object(worker, "YTDLP_COOKIE_FILE", Path(directory) / "cookies.txt"), \
                        patch.object(worker, "_YTDLP_COOKIE_FILES", {}):
                    options = worker.base_ydl_options("youtube")
                    path = Path(options["cookiefile"])
                    self.assertEqual(path.read_text(), self.COOKIES + "\n")
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    jar = http.cookiejar.MozillaCookieJar(str(path))
                    jar.load(ignore_discard=True, ignore_expires=True)
                    self.assertEqual([(cookie.name, cookie.value) for cookie in jar], [("empty", "")])
                    path.write_text(self.COOKIES + "\n# updated by yt-dlp\n")
                    self.assertEqual(worker.base_ydl_options("https://youtu.be/test")["cookiefile"], str(path))
                    self.assertTrue(path.read_text().endswith("# updated by yt-dlp\n"))
                    self.assertNotIn("cookiefile", worker.base_ydl_options("soundcloud"))

    def test_invalid_cookies_are_scoped_and_do_not_leak(self):
        for value in ("base64:secret!", "base64:/w==", "secret-cookie-content", "# Netscape HTTP Cookie File\nsecret\tbad"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, {"YTDLP_COOKIES": value}, clear=True), \
                    patch.object(worker, "YTDLP_COOKIE_FILE", Path(directory) / "cookies.txt"), \
                    patch.object(worker, "_YTDLP_COOKIE_FILES", {}), \
                    patch("uncensor_worker.yt_dlp_module", return_value=FakeYoutubeModule()):
                self.assertNotIn("cookiefile", worker.base_ydl_options("soundcloud"))
                worker.search_entries("soundcloud", "test")
                worker.extract_single_page("https://soundcloud.com/a/b")
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.base_ydl_options("youtube")
                self.assertEqual(raised.exception.code, "cookies_invalid")
                self.assertEqual(raised.exception.detail, "")
                self.assertNotIn(value, str(raised.exception))
                self.assertEqual(list(Path(directory).iterdir()), [])


class DownloadTests(unittest.TestCase):
    def test_m4a_download_and_decode_errors(self):
        class DownloadYoutubeDL(FakeYoutubeDL):
            def extract_info(self, url, download=False):
                path = Path(self.options["outtmpl"].replace("%(ext)s", "m4a"))
                path.write_bytes(b"synthetic m4a")
                return {"requested_downloads": [{"filepath": str(path)}]}

        class Module:
            YoutubeDL = DownloadYoutubeDL

        def transcode(source, destination):
            self.assertNotEqual(source, destination)
            self.assertEqual(source.name, "source.m4a")
            destination.write_bytes(b"synthetic output")
            return 245.0

        with tempfile.TemporaryDirectory() as directory, \
                patch("uncensor_worker.yt_dlp_auth_options", return_value={}), \
                patch("uncensor_worker.yt_dlp_module", return_value=Module()):
            with patch("uncensor_worker.transcode_to_m4a", side_effect=transcode):
                output, duration, _ = worker.download_and_transcode("https://soundcloud.com/a/b", Path(directory))
            self.assertEqual(output.name, "transcoded.m4a")
            self.assertEqual(duration, 245.0)
            for tool in ("ffmpeg", "ffprobe"):
                for code in ("tool_failed", "tool_timeout", "tool_missing"):
                    error = worker.WorkerError(code, tool + " failed")

                    def run(command, **kwargs):
                        if command[0] == tool:
                            raise error
                        Path(command[-1]).write_bytes(b"x" * 2048)

                    with self.subTest(tool=tool, code=code), \
                            patch("uncensor_worker.run_command", side_effect=run):
                        with self.assertRaises(worker.WorkerError) as raised:
                            worker.download_and_transcode("https://soundcloud.com/a/b", Path(directory))
                    if code == "tool_missing":
                        self.assertIs(raised.exception, error)
                    else:
                        self.assertEqual(raised.exception.code, "audio_invalid")
            self.assertEqual(list(Path(directory).iterdir()), [output.parent])

    def test_extract_preserves_worker_error(self):
        error = worker.WorkerError("cookies_invalid", "Invalid cookies")
        with patch("uncensor_worker.yt_dlp_module", return_value=FakeYoutubeModule()), \
                patch("uncensor_worker.yt_dlp_auth_options", side_effect=error):
            with self.assertRaises(worker.WorkerError) as raised:
                worker.extract_single_page("https://youtu.be/test")
        self.assertIs(raised.exception, error)


class CheckTests(unittest.TestCase):
    def test_check_reports_success(self):
        job = FakeCheckJob()
        with patch.dict(os.environ, {"YTDLP_COOKIES": "cookies"}, clear=True), \
                patch("uncensor_worker.yt_dlp_auth_options", return_value={}), \
                patch("uncensor_worker.yt_dlp_module", return_value=FakeYoutubeModule()):
            worker.handle_check(None, job)
        self.assertEqual(job.writes[0][0], "ready")
        self.assertEqual(job.writes[0][1]["candidates"], [])
        self.assertIn("cookies", job.writes[0][1]["note"])

    def test_check_classifies_bot_check(self):
        class FailingYoutubeDL(FakeYoutubeDL):
            def extract_info(self, url, download=False):
                raise RuntimeError("Sign in to confirm you're not a bot")

        class Module:
            YoutubeDL = FailingYoutubeDL

        job = FakeCheckJob()
        with patch.dict(os.environ, {}, clear=True), \
                patch("uncensor_worker.yt_dlp_auth_options", return_value={}), \
                patch("uncensor_worker.yt_dlp_module", return_value=Module()):
            with self.assertRaises(worker.WorkerError) as raised:
                worker.handle_check(None, job)
        self.assertEqual(raised.exception.code, "youtube_auth")
        self.assertIn("YTDLP_COOKIES", raised.exception.message)


class UrlTests(unittest.TestCase):
    def test_rejects_insecure_and_local(self):
        for url in (
            "http://example.com/a.m4a",
            "https://localhost/a.m4a",
            "https://127.0.0.1/a.m4a",
            "https://[::1]/a.m4a",
            "https://169.254.169.254/latest/meta-data",
            "https://user:pass@example.com/a.m4a",
        ):
            with self.subTest(url=url):
                with self.assertRaises(worker.WorkerError):
                    worker.validate_public_https(url)

    def test_accepts_public_ip_literal(self):
        worker.validate_public_https("https://8.8.8.8/audio.m4a")

    def test_rejects_unresolvable_host(self):
        with patch("uncensor_worker.socket.getaddrinfo", side_effect=OSError("dns failed")):
            with self.assertRaises(worker.WorkerError):
                worker.validate_public_https("https://does-not-exist.invalid/a.m4a")


class MappingTests(unittest.TestCase):
    def test_candidate_id_is_stable(self):
        first = worker.candidate_id("https://www.youtube.com/watch?v=abc")
        second = worker.candidate_id("https://www.youtube.com/watch?v=abc")
        self.assertEqual(first, second)
        self.assertNotEqual(first, worker.candidate_id("https://www.youtube.com/watch?v=def"))

    def test_new_mapping(self):
        mapping = worker.build_mapping(
            "123",
            "Группа крови",
            "Кино",
            245000,
            "https://github.com/a/b/releases/download/library/123-cand.m4a",
            "123-cand.m4a",
            {"provider": "youtube", "pageUrl": "https://youtube.com/watch?v=x"},
            None,
        )
        self.assertEqual(mapping["trackId"], "123")
        self.assertEqual(mapping["artists"], ["Кино"])
        self.assertTrue(mapping["enabled"])
        self.assertNotIn("history", mapping)

    def test_replacement_preserves_added_at_without_history(self):
        existing = {
            "addedAt": "2024-01-01T00:00:00Z",
            "enabled": False,
            "audioUrl": "https://github.com/a/b/releases/download/library/old.m4a",
            "assetName": "old.m4a",
            "source": {"provider": "manual"},
            "history": [{"audioUrl": "https://example.com/older.m4a", "assetName": "older.m4a", "replacedAt": "2023"}],
        }
        mapping = worker.build_mapping(
            "123",
            "Группа крови",
            "Кино",
            245000,
            "https://github.com/a/b/releases/download/library/new.m4a",
            "new.m4a",
            {"provider": "soundcloud"},
            existing,
        )
        self.assertEqual(mapping["addedAt"], "2024-01-01T00:00:00Z")
        self.assertTrue(mapping["enabled"])
        self.assertNotIn("history", mapping)

    def test_track_asset_cleanup_keeps_only_current_file(self):
        class Response:
            status_code = 200
            ok = True

            def json(self):
                return []

        class Session:
            def __init__(self):
                self.deleted = []

            def get(self, url, **kwargs):
                Response.json = lambda *args: [
                    {"id": 1, "name": "123-old.m4a"},
                    {"id": 2, "name": "123.m4a"},
                    {"id": 3, "name": "1234-old.m4a"},
                    {"id": 4, "name": "other.m4a"},
                ]
                return Response()

            def delete(self, url, **kwargs):
                self.deleted.append(url)
                return Response()

        github = object.__new__(worker.GitHubAPI)
        github.repo = "owner/repo"
        github.api_url = "https://api.github.com"
        github.session = Session()
        removed = github.delete_track_assets({"id": 7}, "123", keep_name="123.m4a")
        self.assertEqual(removed, 1)
        self.assertEqual(len(github.session.deleted), 1)
        self.assertTrue(github.session.deleted[0].endswith("/releases/assets/1"))

    def test_legacy_previews_release_is_removed(self):
        class Response:
            status_code = 200
            ok = True

            def __init__(self, payload=None):
                self.payload = payload

            def json(self):
                return self.payload if self.payload is not None else []

        class Session:
            def __init__(self):
                self.deleted = []

            def get(self, url, **kwargs):
                if url.endswith("/releases/tags/previews"):
                    return Response({"id": 9})
                if url.endswith("/releases/9/assets"):
                    return Response([{"id": 11, "name": "old-a.m4a"}, {"id": 12, "name": "old-b.m4a"}])
                return Response([])

            def delete(self, url, **kwargs):
                self.deleted.append(url)
                return Response()

        github = object.__new__(worker.GitHubAPI)
        github.repo = "owner/repo"
        github.api_url = "https://api.github.com"
        github.session = Session()
        github.cleanup_legacy_previews()
        self.assertEqual(len(github.session.deleted), 4)
        self.assertTrue(github.session.deleted[-1].endswith("/git/refs/tags/previews"))


class ProviderTests(unittest.TestCase):
    def test_provider_for_url(self):
        self.assertEqual(worker.provider_for_url("https://www.youtube.com/watch?v=x"), "youtube")
        self.assertEqual(worker.provider_for_url("https://youtu.be/x"), "youtube")
        self.assertEqual(worker.provider_for_url("https://soundcloud.com/a/b"), "soundcloud")
        self.assertEqual(worker.provider_for_url("https://rutube.ru/video/abc/"), "rutube")
        self.assertEqual(worker.provider_for_url("https://www.dailymotion.com/video/x1"), "dailymotion")
        self.assertEqual(worker.provider_for_url("https://vimeo.com/123"), "vimeo")
        self.assertEqual(worker.provider_for_url("https://artist.bandcamp.com/track/x"), "bandcamp")
        self.assertEqual(worker.provider_for_url("https://vk.com/video-1_2"), "vk")
        self.assertEqual(worker.provider_for_url("https://example.com/a.m4a"), "")

    def test_unsupported_sources_cannot_be_downloaded_or_selected(self):
        urls = ("https://rutube.ru/video/abc/", "https://dailymotion.com/video/x1",
                "https://vimeo.com/123", "https://artist.bandcamp.com/track/x", "https://vk.com/video-1_2")
        with patch("uncensor_worker.yt_dlp_module") as module, \
                patch("uncensor_worker.validate_public_https"):
            for url in urls:
                with self.subTest(url=url):
                    self.assertEqual(worker.search_entries(worker.provider_for_url(url), "test"), [])
                    with self.assertRaises(worker.WorkerError):
                        worker.download_and_transcode(url, Path("unused"))
                    with self.assertRaises(worker.WorkerError):
                        worker.make_candidate({"pageUrl": url, "provider": "youtube"}, "Track", "Artist", 245)
            module.assert_not_called()

    def test_provider_metadata_comes_from_validated_url(self):
        with patch("uncensor_worker.validate_public_https"):
            candidate = worker.make_candidate({"pageUrl": "https://soundcloud.com/a/b", "provider": "youtube"},
                                              "Track", "Artist", 245)
        self.assertEqual(candidate["provider"], "soundcloud")

    def test_resolved_source_must_be_exact_selection(self):
        url = "https://www.youtube.com/watch?v=chosen"
        for info in ({"webpage_url": "https://dailymotion.com/video/other"},
                     {"webpage_url": "https://youtube.com/watch?v=other"},
                     {"id": "other"}, {"_type": "playlist"}):
            with self.subTest(info=info), self.assertRaises(worker.WorkerError):
                worker.validate_source(url, info)
        worker.validate_source(url, {"webpage_url": "https://youtu.be/chosen", "id": "chosen"})
        with self.assertRaises(worker.WorkerError):
            worker.validate_source("https://soundcloud.com/a/chosen", {"webpage_url": "https://soundcloud.com/a/other"})


class SearchMetadataTests(unittest.TestCase):
    def test_parallel_search_preserves_provider_order_and_errors(self):
        barrier = threading.Barrier(2)
        youtube_done = threading.Event()

        def search(provider, query):
            barrier.wait(timeout=3)
            if provider == "youtube":
                youtube_done.set()
            else:
                self.assertTrue(youtube_done.wait(timeout=3))
            return [{"provider": provider, "pageUrl": ("https://youtube.com/watch?v=one" if provider == "youtube"
                                                       else "https://soundcloud.com/a/one"),
                     "title": "Artist Track", "uploader": "Artist", "duration": 245}]

        job = FakeCheckJob()
        job.issue_number = 0
        with patch.dict(os.environ, {"TITLE": "Track", "ARTIST": "Artist", "DURATION": "245"}, clear=True), \
                patch("uncensor_worker.search_entries", side_effect=search), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.probe_candidate_availability", return_value=""), \
                patch("uncensor_worker.download_and_transcode") as download:
            worker.handle_search(None, job)
            self.assertEqual([item["provider"] for item in job.writes[-1][1]["candidates"]],
                             ["youtube", "soundcloud"])
            download.assert_not_called()

            def fail(provider, query):
                barrier.wait(timeout=3)
                raise worker.WorkerError("search_failed", provider + " failed")

            with patch("uncensor_worker.search_entries", side_effect=fail):
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.handle_search(None, job)
            self.assertEqual(raised.exception.code, "no_candidates")
            self.assertLess(raised.exception.detail.index("youtube:"), raised.exception.detail.index("soundcloud:"))

    def test_soundcloud_probes_are_bounded_and_parallel(self):
        barrier = threading.Barrier(3)
        lock = threading.Lock()
        active = 0
        peak = 0

        def probe(url, provider):
            nonlocal active, peak
            self.assertEqual(provider, "soundcloud")
            with lock:
                active += 1
                peak = max(peak, active)
            barrier.wait(timeout=3)
            with lock:
                active -= 1
            return "blocked" if url.endswith("/0") else ""

        entries = [{"pageUrl": f"https://soundcloud.com/a/{index}", "title": "Artist Track",
                    "duration": 245, "uploader": "Artist"} for index in range(6)]
        job = FakeCheckJob()
        job.issue_number = 0
        with patch.dict(os.environ, {"TITLE": "Track", "ARTIST": "Artist"}, clear=True), \
                patch("uncensor_worker.search_entries", side_effect=lambda provider, query: entries if provider == "soundcloud" else []), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.probe_candidate_availability", side_effect=probe):
            worker.handle_search(None, job)
        self.assertEqual(peak, 3)
        candidates = job.writes[-1][1]["candidates"]
        self.assertTrue(all(item["probed"] for item in candidates))
        self.assertTrue(candidates[0]["unavailable"])
        self.assertFalse(any(item.get("unavailable") for item in candidates[1:]))

    def test_search_returns_metadata_without_downloading(self):
        class FakeGitHub:
            def __init__(self):
                self.writes = []

            def upsert_json(self, path, payload, message):
                self.writes.append((path, payload, message))

        github = FakeGitHub()
        metadata = {
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_RUN_ID": "123",
        }
        entries = [
            {
                "provider": "youtube",
                "pageUrl": "https://www.youtube.com/watch?v=abc123",
                "title": "Кино - Группа крови",
                "artist": "Кино",
                "uploader": "Кино",
                "duration": 246,
                "isLive": False,
            }
        ]
        with patch.dict(os.environ, metadata, clear=True), \
                patch("uncensor_worker.search_entries", side_effect=lambda provider, query: entries if provider == "youtube" else []), \
                patch("uncensor_worker.validate_public_https") as validate, \
                patch("uncensor_worker.download_and_transcode") as download:
            job = worker.JobStatus(github, "search", "job-12345678", "owner/repo", "main")
            worker.handle_search(github, job)

        self.assertGreaterEqual(validate.call_count, 1)
        download.assert_not_called()
        self.assertEqual(len(github.writes), 1)
        path, payload, _ = github.writes[0]
        self.assertEqual(path, "jobs/job-12345678.json")
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["etaSeconds"], worker.JOB_ETA_SECONDS["search"])
        candidate = payload["candidates"][0]
        self.assertEqual(candidate["pageUrl"], "https://www.youtube.com/watch?v=abc123")
        self.assertNotIn("previewUrl", candidate)
        self.assertNotIn("previewAsset", candidate)


class ConfirmTests(unittest.TestCase):
    def test_confirm_never_falls_back_on_selected_download_failure(self):
        candidates = [
            {"id": f"candidate-{index}", "provider": "soundcloud", "pageUrl": f"https://soundcloud.com/a/{index}",
             "durationMs": 245000, "score": 0.9, "warnings": [], "probed": True}
            for index in range(8)
        ]

        class FakeGitHub:
            def get_json(self, path):
                return {"status": "ready", "trackId": "123456", "trackDurationMs": 245000, "candidates": candidates}

        job = FakeCheckJob()
        job.track_id = "123456"
        for code in ("audio_invalid", "tool_missing", "source_drm", "download_failed", "cookies_invalid"):
            error = worker.WorkerError(code, "Synthetic failure")
            with self.subTest(code=code), \
                    patch.dict(os.environ, {"SOURCE_JOB_ID": "job-source-12345678", "CANDIDATE_ID": "candidate-0"}, clear=True), \
                    patch("uncensor_worker.is_repository_owner", return_value=True), \
                    patch("uncensor_worker.require_existing_replacement_permission"), \
                    patch("uncensor_worker.validate_public_https"), \
                    patch("uncensor_worker.probe_candidate_availability", return_value=""), \
                    patch("uncensor_worker.download_and_transcode", side_effect=error) as download:
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.handle_confirm(FakeGitHub(), job)
            self.assertIs(raised.exception, error)
            self.assertEqual(download.call_count, 1)
            self.assertEqual(download.call_args.args[0], candidates[0]["pageUrl"])

    def test_confirm_downloads_selected_candidate_and_publishes(self):
        class FakeGitHub:
            def __init__(self):
                self.writes = []
                self.index = None

            def upsert_json(self, path, payload, message):
                self.writes.append((path, payload, message))

            def get_json(self, path):
                self.assert_path = path
                return {
                    "status": "ready",
                    "trackId": "123456",
                    "trackDurationMs": 245000,
                    "candidates": [
                        {
                            "id": "abc123def4",
                            "provider": "youtube",
                            "pageUrl": "https://www.youtube.com/watch?v=abc123",
                            "title": "Кино - Группа крови",
                            "artist": "Кино",
                            "uploader": "Кино",
                            "durationMs": 245000,
                            "score": 0.91,
                            "warnings": [],
                        }
                    ],
                }

            def ensure_release(self, tag, title):
                return {"id": 7}

            def upload_asset(self, release, name, path, content_type="audio/mp4"):
                self.asset_name = name
                return {"browser_download_url": f"https://github.com/owner/repo/releases/download/library/{name}"}

            def delete_track_assets(self, release, track_id, keep_name=""):
                self.cleanup = (track_id, keep_name)
                return 0

            def update_index(self, mutator):
                self.index = {"schema": 1, "tracks": {}}
                mutator(self.index)
                return self.index, True

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "SOURCE_JOB_ID": "job-source-12345678",
            "CANDIDATE_ID": "abc123def4",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_RUN_ID": "456",
            "GITHUB_ACTOR": "owner",
            "REPOSITORY_OWNER": "owner",
        }
        with tempfile.NamedTemporaryFile(suffix=".m4a") as output, \
                patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.probe_candidate_availability", return_value=""), \
                patch("uncensor_worker.download_and_transcode", return_value=(Path(output.name), 245.0, {})) as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_confirm(github, job)

        download.assert_called_once()
        self.assertRegex(github.asset_name, r"^123456-job-confirm-12345678-[0-9a-f]{32}\.m4a$")
        self.assertEqual(github.cleanup, ("123456", github.asset_name))
        self.assertIsNotNone(github.index)
        mapping = github.index["tracks"]["123456"]
        self.assertEqual(mapping["source"]["pageUrl"], "https://www.youtube.com/watch?v=abc123")
        self.assertTrue(mapping["audioUrl"].startswith("https://github.com/"))
        self.assertEqual(github.writes[-1][1]["status"], "published")
        self.assertEqual(github.writes[-1][1]["candidateId"], "abc123def4")

        first_name = github.asset_name
        with tempfile.NamedTemporaryFile(suffix=".m4a") as output, \
                patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.download_and_transcode", return_value=(Path(output.name), 245.0, {})):
            worker.handle_confirm(github, job)
        self.assertNotEqual(first_name, github.asset_name)
        self.assertEqual(github.cleanup, ("123456", github.asset_name))

        for info, duration, code in (({"webpage_url": "https://dailymotion.com/video/other"}, 245, "source_mismatch"),
                                     ({"id": "other"}, 245, "source_mismatch"),
                                     ({}, 900, "duration_mismatch")):
            with self.subTest(code=code, info=info), \
                    patch.dict(os.environ, env, clear=True), \
                    patch("uncensor_worker.validate_public_https"), \
                    patch("uncensor_worker.download_and_transcode", return_value=(Path("unused"), duration, info)), \
                    patch.object(github, "upload_asset") as upload:
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.handle_confirm(github, job)
                self.assertEqual(raised.exception.code, code)
                upload.assert_not_called()

        with patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.download_and_transcode", return_value=(Path("unused"), 245.0, {})), \
                patch.object(github, "delete_track_assets", side_effect=worker.WorkerError("github_http", "Delete failed")), \
                patch.object(job, "write") as write:
            with self.assertRaises(worker.WorkerError):
                worker.handle_confirm(github, job)
            write.assert_not_called()

    def test_confirm_youtube_auth_failure_never_switches_provider(self):
        class FakeGitHub:
            def __init__(self):
                self.writes = []
                self.index = None

            def upsert_json(self, path, payload, message):
                self.writes.append((path, payload, message))

            def get_json(self, path):
                return {
                    "status": "ready",
                    "trackId": "123456",
                    "trackDurationMs": 245000,
                    "candidates": [
                        {
                            "id": "selected",
                            "provider": "youtube",
                            "pageUrl": "https://www.youtube.com/watch?v=selected",
                            "title": "Кино - Группа крови",
                            "durationMs": 245000,
                            "score": 0.95,
                            "warnings": [],
                        },
                        *[{
                            "id": f"youtube-{index}",
                            "provider": "youtube",
                            "pageUrl": f"https://www.youtube.com/watch?v=alternative{index}",
                            "title": "Кино - Группа крови (second)",
                            "durationMs": 245000,
                            "score": 0.90,
                            "warnings": [],
                        } for index in range(4)],
                        {
                            "id": "soundcloud-good",
                            "provider": "soundcloud",
                            "pageUrl": "https://soundcloud.com/filthdirtklib3rt/my-rabotaem-na-kreml-kpsszamay",
                            "title": "Кино - Группа крови",
                            "durationMs": 245000,
                            "score": 0.85,
                            "warnings": [],
                        },
                    ],
                }

            def ensure_release(self, tag, title):
                return {"id": 7}

            def upload_asset(self, release, name, path, content_type="audio/mp4"):
                return {"browser_download_url": f"https://github.com/owner/repo/releases/download/library/{name}"}

            def delete_track_assets(self, release, track_id, keep_name=""):
                return 0

            def update_index(self, mutator):
                self.index = {"schema": 1, "tracks": {}}
                mutator(self.index)
                return self.index, True

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "SOURCE_JOB_ID": "job-source-12345678",
            "CANDIDATE_ID": "selected",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_RUN_ID": "456",
            "GITHUB_ACTOR": "owner",
            "REPOSITORY_OWNER": "owner",
        }
        with tempfile.NamedTemporaryFile(suffix=".m4a") as output, \
                patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.probe_candidate_availability", return_value=""), \
                patch(
                    "uncensor_worker.download_and_transcode",
                    side_effect=[
                        worker.WorkerError("youtube_auth", "YouTube требует cookies."),
                        (Path(output.name), 245.0, {}),
                    ],
                ) as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            with self.assertRaises(worker.WorkerError) as raised:
                worker.handle_confirm(github, job)

        self.assertEqual(raised.exception.code, "youtube_auth")
        download.assert_called_once()
        self.assertEqual(download.call_args.args[0], "https://www.youtube.com/watch?v=selected")
        self.assertIsNone(github.index)
        self.assertEqual(github.writes, [])


class ApprovalTests(unittest.TestCase):
    def test_friend_confirm_creates_github_request_without_publishing(self):
        class FakeGitHub:
            def __init__(self):
                self.writes = []
                self.issue = None
                self.labels = []

            def get_json(self, path):
                return {
                    "status": "ready",
                    "trackId": "123456",
                    "trackDurationMs": 245000,
                    "candidates": [
                        {
                            "id": "candidate-one",
                            "provider": "youtube",
                            "pageUrl": "https://www.youtube.com/watch?v=abc123",
                            "title": "Кино - Группа крови",
                            "artist": "Кино",
                            "uploader": "Кино",
                            "durationMs": 245000,
                            "score": 0.91,
                            "warnings": [],
                        }
                    ],
                }

            def ensure_label(self, name, color, description):
                self.labels.append(name)

            def create_issue(self, title, body, labels):
                self.issue = {"number": 42, "html_url": "https://github.com/owner/repo/issues/42", "body": body}
                return self.issue

            def upsert_json(self, path, payload, message):
                self.writes.append((path, payload, message))

            def update_index(self, mutator):
                raise AssertionError("friend request must not publish")

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "SOURCE_JOB_ID": "job-source-12345678",
            "CANDIDATE_ID": "candidate-one",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_RUN_ID": "456",
            "GITHUB_ACTOR": "friend",
            "REPOSITORY_OWNER": "owner",
        }
        with patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.download_and_transcode") as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_confirm(github, job)

        download.assert_not_called()
        self.assertEqual(github.labels, [item[0] for item in worker.APPROVAL_LABELS.values()])
        self.assertIsNotNone(github.issue)
        paths = [path for path, _, _ in github.writes]
        self.assertIn("submissions/job-confirm-12345678.json", paths)
        submission = next(payload for path, payload, _ in github.writes if path.startswith("submissions/"))
        self.assertEqual(submission["issueNumber"], 42)
        self.assertEqual(submission["requestedBy"], "friend")
        self.assertEqual(submission["candidateId"], "candidate-one")
        awaiting = next(payload for path, payload, _ in github.writes if path.startswith("jobs/"))
        self.assertEqual(awaiting["status"], "awaiting_approval")
        self.assertEqual(awaiting["issueUrl"], "https://github.com/owner/repo/issues/42")

    def test_owner_rejection_removes_submission_and_closes_issue(self):
        class FakeGitHub:
            def __init__(self):
                self.writes = []
                self.deleted = []
                self.labels = []
                self.comments = []
                self.closed = []

            def upsert_json(self, path, payload, message):
                self.writes.append((path, payload, message))

            def delete_file(self, path, message):
                self.deleted.append(path)
                return True

            def add_labels(self, number, labels):
                self.labels.append((number, labels))

            def comment_issue(self, number, body):
                self.comments.append((number, body))

            def close_issue(self, number, state_reason="completed"):
                self.closed.append((number, state_reason))

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_RUN_ID": "456",
            "GITHUB_ACTOR": "owner",
            "REPOSITORY_OWNER": "owner",
            "APPROVAL_ISSUE": "42",
        }
        with patch.dict(os.environ, env, clear=True):
            job = worker.JobStatus(github, "reject", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_reject(github, job)

        self.assertEqual(github.deleted, ["submissions/job-confirm-12345678.json"])
        self.assertEqual(github.writes[-1][1]["status"], "failed")
        self.assertEqual(github.writes[-1][1]["error"]["code"], "rejected")
        self.assertEqual(github.labels[0][1], ["uncensor-rejected"])
        self.assertEqual(github.closed, [(42, "not_planned")])

    def test_friend_cannot_reject(self):
        class FakeGitHub:
            def delete_file(self, path, message):
                raise AssertionError("friend must not reject")

            def add_labels(self, number, labels):
                raise AssertionError("friend must not reject")

            def comment_issue(self, number, body):
                raise AssertionError("friend must not reject")

            def close_issue(self, number):
                raise AssertionError("friend must not reject")

        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_ACTOR": "friend",
            "REPOSITORY_OWNER": "owner",
            "APPROVAL_ISSUE": "42",
        }
        with patch.dict(os.environ, env, clear=True):
            job = worker.JobStatus(FakeGitHub(), "reject", "job-confirm-12345678", "owner/repo", "main")
            with self.assertRaises(worker.WorkerError) as raised:
                worker.handle_reject(FakeGitHub(), job)
        self.assertEqual(raised.exception.code, "forbidden")

    def test_publication_finalizes_issue(self):
        class FakeGitHub:
            def __init__(self):
                self.deleted = []
                self.labels = []
                self.comments = []
                self.closed = []

            def delete_file(self, path, message):
                self.deleted.append(path)
                return True

            def add_labels(self, number, labels):
                self.labels.append((number, labels))

            def comment_issue(self, number, body):
                self.comments.append((number, body))

            def close_issue(self, number):
                self.closed.append(number)

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_ACTOR": "owner",
            "REPOSITORY_OWNER": "owner",
            "APPROVAL_ISSUE": "42",
        }
        with patch.dict(os.environ, env, clear=True):
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.finalize_approval(github, job)

        self.assertEqual(github.deleted, ["submissions/job-confirm-12345678.json"])
        self.assertEqual(github.labels, [(42, ["uncensor-published"])])
        self.assertEqual(github.closed, [42])
        self.assertIn("опубликована", github.comments[0][1])

    def test_cleanup_failure_does_not_hide_publication(self):
        class FakeGitHub:
            def __init__(self):
                self.labels = []
                self.comments = []
                self.closed = []

            def delete_file(self, path, message):
                raise OSError("network down")

            def add_labels(self, number, labels):
                self.labels.append((number, labels))

            def comment_issue(self, number, body):
                self.comments.append((number, body))

            def close_issue(self, number):
                self.closed.append(number)

        github = FakeGitHub()
        env = {
            "TRACK_ID": "123456",
            "TITLE": "Группа крови",
            "ARTIST": "Кино",
            "DURATION": "245",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_REF_NAME": "main",
            "GITHUB_ACTOR": "owner",
            "REPOSITORY_OWNER": "owner",
            "APPROVAL_ISSUE": "42",
        }
        with patch.dict(os.environ, env, clear=True):
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.finalize_approval(github, job)

        self.assertEqual(github.labels, [(42, ["uncensor-published"])])
        self.assertEqual(github.closed, [42])


class FakeRequestGitHub:
    def __init__(self):
        self.files = {}
        self.writes = []
        self.comments = []
        self.closed = []
        self.labels = []
        self.reservations = []

    def get_json(self, path):
        return self.files.get(path)

    def put_file(self, path, text, message, sha=None):
        if sha is not None or path in self.files:
            raise worker.WorkerError("github_http", "Create-only conflict", status=422)
        if not path.startswith("jobs/"):
            raise AssertionError("Only jobs may be reserved")
        payload = json.loads(text)
        self.files[path] = payload
        self.reservations.append((path, payload))

    def upsert_json(self, path, payload, message):
        if not path.startswith(("jobs/", "submissions/")):
            raise AssertionError("Intake must not mutate the library")
        self.files[path] = payload
        self.writes.append((path, payload))

    def comment_issue(self, number, body):
        self.comments.append((number, body))

    def close_issue(self, number):
        self.closed.append(number)

    def ensure_label(self, *args):
        pass

    def add_labels(self, number, labels):
        self.labels.append((number, labels))


class IssueRequestTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeRequestGitHub()
        self.payload = {"id": "12345678-abcd", "action": "search", "trackId": "123456",
                        "title": "Track", "artist": "Artist", "duration": 245}
        self.candidate = {"id": "candidate-one", "provider": "youtube",
                          "pageUrl": "https://youtube.com/watch?v=one", "title": "Trusted title"}
        self.github.files["jobs/source-12345678.json"] = {
            "status": "ready", "trackId": "123456", "candidates": [self.candidate]}

    def run_request(self, body=None, actor="ordinary-user", use_main=False):
        event = {"action": "opened", "issue": {"number": 42, "user": {"login": actor},
                 "body": body if body is not None else worker.REQUEST_PREFIX + json.dumps(self.payload) + "\n```"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "event.json"
            path.write_text(json.dumps(event), encoding="utf-8")
            with patch.dict(os.environ, {"ACTION": "request", "GITHUB_EVENT_PATH": str(path),
                            "GITHUB_REPOSITORY": "owner/repo", "GITHUB_REF_NAME": "main",
                            "GITHUB_TOKEN": "synthetic", "GITHUB_ACTOR": "owner"}, clear=True), \
                    patch("uncensor_worker.download_and_transcode") as download, \
                    patch("uncensor_worker.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]), \
                    patch("uncensor_worker.download_public_file") as direct_download, \
                    patch.object(worker.GitHubAPI, "cleanup_legacy_previews") as cleanup, \
                    patch.object(worker.GitHubAPI, "update_index") as publish, \
                    patch.object(worker.GitHubAPI, "ensure_release") as release, \
                    patch.object(worker.GitHubAPI, "upload_asset") as upload, \
                    patch("uncensor_worker.handle_confirm") as confirm, \
                    patch("uncensor_worker.handle_manual") as manual:
                if use_main:
                    with patch("uncensor_worker.GitHubAPI", return_value=self.github):
                        result = worker.main()
                else:
                    result = worker.handle_issue_request(self.github, "owner/repo", "main")
                for forbidden in (download, direct_download, cleanup, publish, release, upload, confirm, manual):
                    forbidden.assert_not_called()
                return result

    def test_ordinary_user_search_via_main_without_job_env(self):
        entry = {"provider": "youtube", "pageUrl": self.candidate["pageUrl"],
                 "title": "Artist Track", "uploader": "Artist", "duration": 245}
        with patch("uncensor_worker.search_entries", side_effect=lambda provider, query: [entry] if provider == "youtube" else []):
            self.assertEqual(self.run_request(use_main=True), 0)
        self.assertEqual([data["status"] for _, data in self.github.writes], ["running", "ready"])
        self.assertEqual(self.github.reservations, [("jobs/12345678-abcd.json", {
            "schema": 1, "id": "12345678-abcd", "action": "search", "trackId": "123456",
            "issueNumber": 42, "requestedBy": "ordinary-user", "status": "reserved",
        })])
        for _, status in self.github.writes:
            self.assertEqual(status["issueNumber"], 42)
            self.assertEqual(status["requestedBy"], "ordinary-user")
            self.assertEqual(status["issueUrl"], "https://github.com/owner/repo/issues/42")
        self.assertEqual(self.github.closed, [42])
        self.assertIn(self.candidate["pageUrl"], self.github.comments[0][1])
        self.assertIn("Выберите подходящий вариант в дополнении", self.github.comments[0][1])
        self.assertIn("подтверждать её меткой не нужно", self.github.comments[0][1])
        self.assertFalse(any(path.startswith("submissions/") for path, _ in self.github.writes))

    def test_confirm_uses_current_issue_and_trusted_candidate(self):
        self.payload.update(action="confirm", sourceJobId="source-12345678", candidateId="candidate-one",
                            sourceUrl="https://8.8.8.8/forged", requestedBy="owner", issueNumber=99,
                            candidateTitle="Forged", candidateProvider="Forged")
        self.assertEqual(self.run_request(), 0)
        submission = self.github.files["submissions/12345678-abcd.json"]
        self.assertEqual(submission["action"], "confirm")
        self.assertEqual(submission["issueNumber"], 42)
        self.assertEqual(submission["requestedBy"], "ordinary-user")
        self.assertEqual(submission["sourceUrl"], self.candidate["pageUrl"])
        self.assertEqual(submission["candidateTitle"], "Trusted title")
        self.assertEqual(submission["candidateProvider"], "youtube")
        self.assertEqual(self.github.writes[-1][1]["status"], "awaiting_approval")
        self.assertEqual(self.github.labels, [(42, [worker.APPROVAL_LABELS["request"][0]])])
        self.assertEqual(self.github.closed, [])
        comment = self.github.comments[-1][1]
        self.assertIn("`Track`", comment)
        self.assertIn("`Artist`", comment)
        self.assertIn("https://music.yandex.ru/track/123456", comment)
        self.assertIn("[Открыть источник для прослушивания](<" + self.candidate["pageUrl"] + ">)", comment)
        self.assertIn("`uncensor-approved`", comment)
        self.assertIn("`uncensor-rejected`", comment)

    def test_owner_manual_also_requires_review(self):
        self.payload.update(action="manual", sourceUrl="https://8.8.8.8/audio.m4a")
        self.assertEqual(self.run_request(actor="owner"), 0)
        self.assertEqual(self.github.files["submissions/12345678-abcd.json"]["action"], "manual")
        self.assertEqual(self.github.writes[-1][1]["status"], "awaiting_approval")

    def test_review_comment_escapes_metadata_and_source_link(self):
        self.payload.update(action="manual", title="@owner ` [click](evil)", artist="@everyone `Artist`",
                            sourceUrl="https://8.8.8.8/audio?q=)[x](<bad>)&user=@owner")
        self.assertEqual(self.run_request(), 0)
        comment = self.github.comments[-1][1]
        self.assertNotIn("@owner", comment)
        self.assertNotIn("@everyone", comment)
        self.assertIn("`(at)owner ' [click](evil)`", comment)
        self.assertIn("`(at)everyone 'Artist'`", comment)
        self.assertIn("%29%5Bx%5D%28%3Cbad%3E%29", comment)
        self.assertIn("%40owner", comment)

    def test_malformed_envelope_and_json(self):
        for body in ("not a request", worker.REQUEST_PREFIX + "{}", worker.REQUEST_PREFIX + "[]\n```",
                     worker.REQUEST_PREFIX + "{bad}\n```", worker.REQUEST_PREFIX + "x" * 17000 + "\n```"):
            with self.subTest(body=body[:50]):
                self.assertEqual(self.run_request(body=body), 1)
        self.assertEqual(self.github.writes, [])

    def test_invalid_payload_fields(self):
        for field, value in (("action", "remove"), ("action", []), ("id", "../escape"),
                             ("trackId", "abc"), ("trackId", 123), ("title", "x" * 301),
                             ("title", ""), ("artist", "bad\nmetadata"), ("duration", True),
                             ("duration", float("nan")), ("duration", 3601), ("duration", -1),
                             ("sourceUrl", "https://127.0.0.1/private")):
            with self.subTest(field=field, value=value), patch.dict(self.payload, {field: value}):
                self.assertEqual(self.run_request(), 1)
        self.assertEqual(self.github.writes, [])

    def test_collisions_never_overwrite_and_redelivery_is_noop(self):
        path = "jobs/12345678-abcd.json"
        self.github.files[path] = {"issueNumber": 99, "requestedBy": "ordinary-user"}
        self.assertEqual(self.run_request(), 1)
        self.assertEqual(self.github.writes, [])
        self.github.files[path]["issueNumber"] = 42
        self.assertEqual(self.run_request(), 0)
        self.assertEqual(self.github.writes, [])
        del self.github.files[path]
        self.github.files["submissions/12345678-abcd.json"] = {"issueNumber": 99}
        self.assertEqual(self.run_request(), 1)
        self.assertEqual(self.github.writes, [])

    def test_racing_issue_reservation_conflict_never_overwrites_winner(self):
        path = "jobs/12345678-abcd.json"
        winner = {"schema": 1, "id": self.payload["id"], "action": "manual", "trackId": "999",
                  "issueNumber": 99, "requestedBy": "other-user", "status": "reserved"}
        create_only = self.github.put_file

        def race(reserved_path, text, message, sha=None):
            self.assertNotIn(path, self.github.files)
            self.assertEqual(reserved_path, path)
            self.assertIsNone(sha)
            self.github.files[path] = winner.copy()
            return create_only(reserved_path, text, message, sha)

        with patch.object(self.github, "put_file", side_effect=race) as reserve, \
                patch("uncensor_worker.handle_search") as search:
            self.assertEqual(self.run_request(), 1)
        reserve.assert_called_once()
        search.assert_not_called()
        self.assertEqual(self.github.files[path], winner)
        self.assertEqual(self.github.writes, [])
        self.assertEqual(self.github.reservations, [])
        self.assertEqual(self.github.labels, [])
        self.assertEqual(self.github.comments[0][0], 42)
        self.assertFalse(any(path.startswith("submissions/") for path in self.github.files))

    def test_confirm_rejects_mismatched_missing_or_unavailable_candidate(self):
        self.payload.update(action="confirm", sourceJobId="source-12345678", candidateId="candidate-one")
        source = self.github.files["jobs/source-12345678.json"]
        for changes in ({"trackId": "999"}, {"status": "running"}, {"candidates": []},
                        {"candidates": [{**self.candidate, "unavailable": True}]}):
            with self.subTest(changes=changes), patch.dict(source, changes):
                self.github.files.pop("jobs/12345678-abcd.json", None)
                self.assertEqual(self.run_request(), 1)
                self.assertEqual(self.github.writes, [])
                self.assertEqual(self.github.reservations, [])
                self.assertNotIn("submissions/12345678-abcd.json", self.github.files)

    def test_nonowner_cannot_replace_existing_mapping(self):
        self.github.files["list.json"] = {"tracks": {"123456": {"audioUrl": "existing"}}}
        self.payload.update(action="manual", sourceUrl="https://8.8.8.8/audio.m4a")
        self.assertEqual(self.run_request(), 1)
        self.assertNotIn("submissions/12345678-abcd.json", self.github.files)
        self.assertEqual(self.github.reservations, [])
        self.assertEqual(self.github.files["list.json"]["tracks"]["123456"]["audioUrl"], "existing")

    def test_search_failure_is_sanitized(self):
        with patch("uncensor_worker.handle_search", side_effect=worker.WorkerError("bad", "secret-payload", "secret-token")):
            self.assertEqual(self.run_request(), 1)
        status = self.github.writes[-1][1]
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["requestedBy"], "ordinary-user")
        self.assertNotIn("secret", json.dumps(status) + json.dumps(self.github.comments))
        self.assertIn("Не удалось обработать заявку", self.github.comments[-1][1])


class RemoveTests(unittest.TestCase):
    def test_removed_status_uses_actual_mapping_url_not_request_input(self):
        github = Mock()
        index = {"tracks": {"123": {"audioUrl": "https://example.com/current.m4a"},
                            "999": {"audioUrl": "https://example.com/other.m4a"}}}
        github.update_index.side_effect = lambda mutate: (index, mutate(index))
        github.get_release.return_value = {"id": 7}
        job = FakeCheckJob()
        job.track_id = "123"
        with patch.dict(os.environ, {"GITHUB_ACTOR": "owner", "REPOSITORY_OWNER": "owner",
                                     "SOURCE_URL": "https://example.com/forged.m4a"}, clear=True):
            worker.handle_remove(github, job)
        self.assertEqual(job.writes[-1][0], "removed")
        self.assertEqual(job.writes[-1][1]["removedAudioUrl"], "https://example.com/current.m4a")
        self.assertNotIn("123", index["tracks"])
        self.assertEqual(index["tracks"]["999"]["audioUrl"], "https://example.com/other.m4a")
        github.delete_track_assets.assert_called_once_with({"id": 7}, "123")

    def test_removed_url_is_reset_on_every_index_retry(self):
        stale = {"audioUrl": "https://example.com/stale.m4a"}
        current = {"audioUrl": "https://example.com/current.m4a"}
        for final_tracks, expected in (({}, ""), ({"123": current}, current["audioUrl"]),
                                       ({"123": {}}, ""), ({"123": None}, ""),
                                       ({"123": {"audioUrl": None}}, "")):
            with self.subTest(final_tracks=final_tracks):
                github = Mock()
                github.get_release.return_value = None

                def update(mutator):
                    mutator({"tracks": {"123": stale}})
                    index = {"tracks": final_tracks.copy()}
                    changed = mutator(index)
                    return index, changed

                github.update_index.side_effect = update
                job = FakeCheckJob()
                job.track_id = "123"
                with patch("uncensor_worker.require_repository_owner"):
                    worker.handle_remove(github, job)
                self.assertEqual(job.writes[-1][1]["removedAudioUrl"], expected)


class AssetLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.github = object.__new__(worker.GitHubAPI)
        self.github.repo = "owner/repo"
        self.github.api_url = "https://api.github.com"
        self.github.session = Mock()

    def test_cleanup_lists_every_page_before_deleting_legacy_and_new_names(self):
        assets = [{"id": index + 1, "name": f"999-other-{index}.m4a"} for index in range(1100)]
        names = ["123.m4a", "123-cand-abcdef.m4a", "123-job-old-deadbeef.m4a",
                 "123-job-current-cafebabe.m4a", "1234.m4a"]
        assets.extend({"id": 2000 + index, "name": name} for index, name in enumerate(names))
        pages = []

        def get(url, params, **kwargs):
            pages.append(params["page"])
            start = (params["page"] - 1) * params["per_page"]
            return Mock(ok=True, json=lambda: assets[start:start + params["per_page"]])

        self.github.session.get.side_effect = get
        self.github.session.delete.return_value = Mock(ok=True)
        removed = self.github.delete_track_assets({"id": 7}, "123", keep_name=names[3])
        self.assertEqual(pages, list(range(1, 13)))
        self.assertEqual(removed, 3)
        self.assertEqual([call.args[0].rsplit("/", 1)[-1] for call in self.github.session.delete.call_args_list],
                         ["2000", "2001", "2002"])
        self.github.session.delete.reset_mock()
        self.assertEqual(self.github.delete_track_assets({"id": 7}, "123"), 4)

    def test_listing_and_deletion_failures_are_not_silenced(self):
        for payload in ({"message": "bad"}, [None]):
            with self.subTest(payload=payload):
                self.github.session.get.return_value = Mock(ok=True, json=lambda: payload)
                with self.assertRaises(worker.WorkerError):
                    self.github.list_assets(7)
        self.github.session.get.return_value = Mock(ok=True, json=lambda: [{"id": 1, "name": "123.m4a"}])
        self.github.session.delete.return_value = Mock(ok=False, status_code=403, json=lambda: {"message": "Denied"})
        with self.assertRaises(worker.WorkerError) as raised:
            self.github.delete_track_assets({"id": 7}, "123")
        self.assertEqual(raised.exception.status, 403)
        self.github.session.get.return_value = Mock(ok=False, status_code=500, json=lambda: {})
        with self.assertRaises(worker.WorkerError):
            self.github.list_assets(7)

    def test_manual_republish_after_remove_has_new_url_even_for_same_job(self):
        github = Mock()
        index = {"tracks": {"999": {"source": {"provider": "dailymotion"}}}}
        github.update_index.side_effect = lambda mutate: (index, mutate(index))
        github.ensure_release.return_value = {"id": 7}
        github.get_release.return_value = {"id": 7}
        names = []

        def upload(release, name, path, content_type):
            names.append(name)
            return {"browser_download_url": "https://github.com/owner/repo/releases/download/library/" + name}

        github.upload_asset.side_effect = upload
        with patch.dict(os.environ, {"TRACK_ID": "123", "TITLE": "Track", "SOURCE_URL": "https://8.8.8.8/a.m4a",
                                     "GITHUB_ACTOR": "owner", "REPOSITORY_OWNER": "owner"}, clear=True), \
                patch("uncensor_worker.download_public_file"), \
                patch("uncensor_worker.transcode_to_m4a", return_value=245):
            job = worker.JobStatus(github, "manual", "job-same-12345678", "owner/repo", "main")
            worker.handle_manual(github, job)
            first_url = index["tracks"]["123"]["audioUrl"]
            worker.handle_remove(github, job)
            self.assertNotIn("123", index["tracks"])
            worker.handle_manual(github, job)
            self.assertNotEqual(first_url, index["tracks"]["123"]["audioUrl"])
            self.assertNotEqual(names[0], names[1])
            self.assertTrue(all(name.startswith("123-job-same-12345678-") for name in names))
            self.assertEqual(index["tracks"]["123"]["source"]["provider"], "manual")
            self.assertEqual(index["tracks"]["999"], {"source": {"provider": "dailymotion"}})
            self.assertEqual(github.delete_track_assets.call_args_list[-1].kwargs, {"keep_name": names[-1]})

            github.delete_track_assets.side_effect = worker.WorkerError("github_http", "Delete failed")
            github.upsert_json.reset_mock()
            with self.assertRaises(worker.WorkerError):
                worker.handle_manual(github, job)
            github.upsert_json.assert_not_called()
            with self.assertRaises(worker.WorkerError):
                worker.handle_remove(github, job)
            github.upsert_json.assert_not_called()

    def test_manual_unsupported_provider_rejected_before_submission_or_download(self):
        github = Mock()
        github.get_json.return_value = None
        for owner in (True, False):
            with patch.dict(os.environ, {"SOURCE_URL": "https://vimeo.com/123"}, clear=True), \
                    patch("uncensor_worker.validate_public_https"), \
                    patch("uncensor_worker.is_repository_owner", return_value=owner), \
                    patch("uncensor_worker.download_and_transcode") as download, \
                    patch("uncensor_worker.create_submission") as submit:
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.handle_manual(github, Mock(track_id="123"))
                self.assertEqual(raised.exception.code, "source_unsupported")
                download.assert_not_called()
                submit.assert_not_called()


class ApprovalWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / ".github/workflows/uncensor-approve.yml").read_text()
        self.scripts = [textwrap.dedent(part.split("          PY", 1)[0])
                        for part in self.text.split("          python - <<'PY'\n")[1:]]
        self.data = {"issueNumber": 42, "action": "manual", "jobId": "job-request-12345678",
                     "trackId": "123", "sourceUrl": "https://8.8.8.8/a.m4a"}

    def run_script(self, script, data, prepared_track_id="123"):
        with tempfile.TemporaryDirectory() as directory:
            submission = Path(directory) / "request.json"
            output = Path(directory) / "output"
            submission.write_text(json.dumps(data))
            with patch.dict(os.environ, {"ISSUE_NUMBER": "42", "GITHUB_OUTPUT": str(output),
                                         "PREPARED_TRACK_ID": prepared_track_id}, clear=True), \
                    patch("glob.glob", return_value=[str(submission)]), \
                    patch.dict(sys.modules, {"cloud.uncensor_worker": worker}), \
                    patch.object(sys, "path", [str(ROOT), *sys.path]):
                exec(compile(self.scripts[script], "approval-workflow", "exec"), {})
            return output.read_text()

    def test_prepare_outputs_only_validated_track_id(self):
        self.assertEqual(self.run_script(0, self.data), "track_id=123\n")
        for changes in ({"trackId": "123\nother=value"}, {"trackId": "../escape"},
                        {"trackId": 123}, {"jobId": "bad"}, {"action": "remove"},
                        {"issueNumber": 99}):
            with self.subTest(changes=changes), self.assertRaises((SystemExit, worker.WorkerError)):
                self.run_script(0, {**self.data, **changes})

    def test_review_rereads_submission_and_rejects_changed_track_or_missing_request(self):
        output = self.run_script(1, {**self.data, "sourceUrl": "https://8.8.8.8/latest.m4a"})
        self.assertIn("source_url=https://8.8.8.8/latest.m4a\n", output)
        self.assertIn("track_id=123\n", output)
        for data in ({**self.data, "trackId": "456"}, {**self.data, "issueNumber": 99}):
            with self.subTest(data=data), self.assertRaises(SystemExit):
                self.run_script(1, data)

    def test_approval_workflows_share_dispatch_track_lock_and_keep_owner_checks(self):
        self.assertEqual(self.text, (ROOT / "repository-template/.github/workflows/uncensor-approve.yml").read_text())
        prepare, review = self.text.split("  review:\n", 1)
        self.assertIn("github.event.sender.login == github.repository_owner &&", prepare)
        self.assertIn("github.event.issue.state == 'open'", prepare)
        self.assertIn("contains(github.event.issue.labels.*.name, 'uncensor-request')", prepare)
        self.assertIn("github.event.label.name == 'uncensor-approved' || github.event.label.name == 'uncensor-rejected'", prepare)
        self.assertIn("track_id: ${{ steps.request.outputs.track_id }}", prepare)
        self.assertIn("needs: prepare", review)
        self.assertIn("group: uncensor-cloud-track-${{ needs.prepare.outputs.track_id }}", review)
        self.assertIn("cancel-in-progress: false", review)
        self.assertNotIn("uncensor-approval-", self.text)
        self.assertNotIn("\nconcurrency:", self.text)
        self.assertIn('if [ "$ACTOR" != "$OWNER" ]; then', review)
        self.assertIn("GITHUB_ACTOR: ${{ github.event.sender.login }}", review)
        self.assertIn("PREPARED_TRACK_ID: ${{ needs.prepare.outputs.track_id }}", review)
        self.assertLess(review.index("uses: actions/checkout@v4"), review.index("- name: Find request"))
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", review)


class ValidationTests(unittest.TestCase):
    def test_dispatch_workflows_serialize_track_mutations_without_cancellation(self):
        for path in (ROOT / ".github/workflows/uncensor-cloud.yml",
                     ROOT / "repository-template/.github/workflows/uncensor-cloud.yml"):
            text = path.read_text()
            self.assertIn("cancel-in-progress: false", text)
            self.assertIn("fromJSON('[\"confirm\",\"manual\",\"remove\",\"toggle\"]')", text)
            self.assertIn("format('track-{0}', inputs.track_id)", text)
            self.assertIn("format('job-{0}', inputs.job_id)", text)

    def test_job_and_track_ids(self):
        worker.validate_inputs("search", "12345678-abcd", "123456")
        worker.validate_inputs("check", "12345678-abcd", "0")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("unknown", "12345678-abcd", "123456")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("search", "../escape", "123456")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("search", "12345678-abcd", "abc")


if __name__ == "__main__":
    unittest.main()
