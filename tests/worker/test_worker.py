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

    def test_replacement_preserves_added_at_and_history(self):
        existing = {
            "addedAt": "2024-01-01T00:00:00Z",
            "enabled": False,
            "audioUrl": "https://github.com/a/b/releases/download/library/old.m4a",
            "assetName": "old.m4a",
            "source": {"provider": "manual"},
            "history": [{"audioUrl": "https://example.com/older.m4a", "assetName": "older.m4a", "replacedAt": "2023" }],
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
        self.assertEqual(mapping["history"][0]["audioUrl"], existing["audioUrl"])
        self.assertEqual(mapping["history"][1]["audioUrl"], "https://example.com/older.m4a")

    def test_same_url_does_not_duplicate_history(self):
        url = "https://github.com/a/b/releases/download/library/same.m4a"
        existing = {"audioUrl": url, "assetName": "same.m4a", "addedAt": "2024-01-01T00:00:00Z"}
        mapping = worker.build_mapping("123", "T", "A", 1000, url, "same.m4a", {}, existing)
        self.assertNotIn("history", mapping)


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
                patch("uncensor_worker.search_entries", side_effect=[entries, []]), \
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
        }
        with tempfile.NamedTemporaryFile(suffix=".m4a") as output, \
                patch.dict(os.environ, env, clear=True), \
                patch("uncensor_worker.validate_public_https"), \
                patch("uncensor_worker.download_and_transcode", return_value=(Path(output.name), 245.0, {})) as download:
            job = worker.JobStatus(github, "confirm", "job-confirm-12345678", "owner/repo", "main")
            worker.handle_confirm(github, job)

        download.assert_called_once()
        self.assertEqual(github.asset_name, "123456-abc123def4.m4a")
        self.assertIsNotNone(github.index)
        mapping = github.index["tracks"]["123456"]
        self.assertEqual(mapping["source"]["pageUrl"], "https://www.youtube.com/watch?v=abc123")
        self.assertTrue(mapping["audioUrl"].startswith("https://github.com/"))
        self.assertEqual(github.writes[-1][1]["status"], "published")
        self.assertEqual(github.writes[-1][1]["candidateId"], "abc123def4")


class ValidationTests(unittest.TestCase):
    def test_job_and_track_ids(self):
        worker.validate_inputs("search", "12345678-abcd", "123456")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("unknown", "12345678-abcd", "123456")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("search", "../escape", "123456")
        with self.assertRaises(worker.WorkerError):
            worker.validate_inputs("search", "12345678-abcd", "abc")


if __name__ == "__main__":
    unittest.main()
