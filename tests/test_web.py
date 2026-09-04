from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from cluster_observer.web import DashboardHandler


class WebTests(unittest.TestCase):
    def test_api_jobs_returns_json_payload(self) -> None:
        payload = {
            "dashboard_title": "Test",
            "generated_at_epoch": 1,
            "refresh_seconds": 30,
            "total_jobs": 0,
            "ok_clusters": 0,
            "total_clusters": 0,
            "clusters": [],
        }
        DashboardHandler.collector = unittest.mock.Mock()
        DashboardHandler.collector.snapshot.return_value = payload

        with patch.object(DashboardHandler, "log_request"):
            handler = DashboardHandler.__new__(DashboardHandler)
            handler.path = "/api/jobs"
            sent: dict[str, object] = {}

            def capture_send_bytes(body: bytes, content_type: str) -> None:
                sent["body"] = body
                sent["content_type"] = content_type

            handler._send_bytes = capture_send_bytes
            handler.send_error = lambda *args, **kwargs: self.fail("unexpected send_error")
            handler.do_GET()

        self.assertEqual(sent["content_type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(sent["body"]), payload)
