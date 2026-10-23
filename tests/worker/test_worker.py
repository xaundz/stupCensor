import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_fallback_skips_unavailable_and_wrong_versions(self):
        source = {
            "trackDurationMs": 245000,
            "candidates": [
                {"id": "selected", "pageUrl": "https://soundcloud.com/a/selected", "durationMs": 245000, "score": 0.9, "warnings": []},
                {"id": "drm", "pageUrl": "https://soundcloud.com/a/drm", "durationMs": 245000, "score": 0.95, "warnings": [], "unavailable": True},
                {"id": "instrumental", "pageUrl": "https://youtube.com/watch?v=inst", "durationMs": 245000, "score": 0.94, "warnings": ["инструментальная версия"]},
                {"id": "good", "pageUrl": "https://youtube.com/watch?v=good", "durationMs": 247000, "score": 0.83, "warnings": ["автор загрузившего не совпадает"]},
            ],
        }
        selected = source["candidates"][0]
        result = worker.fallback_candidates(source, selected)
        self.assertEqual([item["id"] for item in result], ["good"])

    def test_fallback_returns_up_to_four_candidates(self):
        candidates = [
            {"id": f"c{index}", "pageUrl": f"https://soundcloud.com/a/{index}", "durationMs": 245000, "score": 0.9 - index / 100, "warnings": []}
            for index in range(6)
        ]
        source = {"trackDurationMs": 245000, "candidates": candidates}
        result = worker.fallback_candidates(source, candidates[0])
        self.assertEqual([item["id"] for item in result], ["c1", "c2", "c3", "c4"])


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

    def test_rutube_results_are_parsed(self):
        payload = {
            "results": [
                {
                    "id": "abc",
                    "title": "Кино - Группа крови",
                    "duration": 246,
                    "video_url": "https://rutube.ru/video/abc/",
                    "author": {"name": "Кино"},
                    "is_live": False,
                },
                {"id": "live", "title": "Live", "duration": 10, "video_url": "https://rutube.ru/video/live/", "is_live": True},
            ]
        }
        result = worker.parse_rutube_results(payload)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["provider"], "rutube")
        self.assertEqual(result[0]["pageUrl"], "https://rutube.ru/video/abc/")
        self.assertEqual(result[0]["uploader"], "Кино")
        self.assertEqual(result[0]["duration"], 246)

    def test_dailymotion_results_are_parsed(self):
        payload = {
            "list": [
                {
                    "id": "x1",
                    "title": "Кино - Группа крови",
                    "url": "https://www.dailymotion.com/video/x1",
                    "duration": 246,
                    "owner.screenname": "Кино",
                }
            ]
        }
        result = worker.parse_dailymotion_results(payload)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["provider"], "dailymotion")
        self.assertEqual(result[0]["uploader"], "Кино")
        self.assertEqual(result[0]["duration"], 246)


class SearchMetadataTests(unittest.TestCase):
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
                patch("uncensor_worker.search_entries", side_effect=[entries, [], [], []]), \
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
                patch("uncensor_worker.download_and_transcode", return_value=(Path(output.name), 245.0, {})) as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_confirm(github, job)

        download.assert_called_once()
        self.assertEqual(github.asset_name, "123456.m4a")
        self.assertEqual(github.cleanup, ("123456", "123456.m4a"))
        self.assertIsNotNone(github.index)
        mapping = github.index["tracks"]["123456"]
        self.assertEqual(mapping["source"]["pageUrl"], "https://www.youtube.com/watch?v=abc123")
        self.assertTrue(mapping["audioUrl"].startswith("https://github.com/"))
        self.assertEqual(github.writes[-1][1]["status"], "published")
        self.assertEqual(github.writes[-1][1]["candidateId"], "abc123def4")

    def test_confirm_skips_youtube_after_auth_failure(self):
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
                        {
                            "id": "youtube-two",
                            "provider": "youtube",
                            "pageUrl": "https://www.youtube.com/watch?v=second",
                            "title": "Кино - Группа крови (second)",
                            "durationMs": 245000,
                            "score": 0.90,
                            "warnings": [],
                        },
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
                patch(
                    "uncensor_worker.download_and_transcode",
                    side_effect=[
                        worker.WorkerError("youtube_auth", "YouTube требует cookies."),
                        (Path(output.name), 245.0, {}),
                    ],
                ) as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_confirm(github, job)

        self.assertEqual(download.call_count, 2)
        self.assertEqual(github.index["tracks"]["123456"]["source"]["provider"], "soundcloud")
        self.assertEqual(github.writes[-1][1]["status"], "published")


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


class ValidationTests(unittest.TestCase):
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
