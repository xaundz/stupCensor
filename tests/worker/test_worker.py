import sys
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
