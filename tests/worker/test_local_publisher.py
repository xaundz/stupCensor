import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

import local_publisher as publisher  # noqa: E402


class IssueJobIdTests(unittest.TestCase):
    def test_reads_browser_request_envelope(self):
        body = publisher.REQUEST_PREFIX + json.dumps({"id": "job-123456", "action": "confirm"}) + "\n```"
        self.assertEqual(publisher.issue_job_id(body), "job-123456")

    def test_reads_worker_request_markdown(self):
        body = "## Заявка\n\n**Задание:** `job-abcdefgh`\n"
        self.assertEqual(publisher.issue_job_id(body), "job-abcdefgh")

    def test_rejects_missing_or_invalid_job_id(self):
        with self.assertRaises(publisher.LocalError):
            publisher.issue_job_id("no identifiers here")
        with self.assertRaises(publisher.LocalError):
            publisher.issue_job_id(publisher.REQUEST_PREFIX + '{"id":"bad id"}' + "\n```")

    def test_local_label_is_separate_from_cloud_approval(self):
        self.assertEqual(publisher.LOCAL_LABEL, "uncensor-local")


if __name__ == "__main__":
    unittest.main()
