from __future__ import annotations

import unittest
from unittest.mock import patch

from cluster_observer.collector import SnapshotCollector
from cluster_observer.config import AppConfig


def cluster_result(*, ok: bool, jobs: int = 0) -> dict:
    return {
        "cluster": "gaas",
        "host": "...s",
        "ok": ok,
        "error": "temporary failure" if not ok else "",
        "jobs": [{"job_id": str(index)} for index in range(jobs)],
        "job_groups": [],
        "summary": {"total_jobs": jobs},
        "job_count": jobs,
        "duration_seconds": 0.1,
    }


def payload(epoch: int, result: dict) -> dict:
    return {
        "dashboard_title": "Test",
        "generated_at_epoch": epoch,
        "refresh_seconds": 30,
        "total_jobs": result["job_count"],
        "ok_clusters": int(result["ok"]),
        "total_clusters": 1,
        "clusters": [result],
    }


class CollectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = AppConfig("Test", "127.0.0.1", 0, 30, 5, ())

    def test_refresh_caches_successful_snapshot(self) -> None:
        collector = SnapshotCollector(self.config)
        with patch(
            "cluster_observer.collector.collect_all_clusters",
            return_value=payload(100, cluster_result(ok=True, jobs=2)),
        ):
            snapshot = collector.refresh()

        self.assertIs(snapshot, collector.snapshot())
        self.assertFalse(snapshot["clusters"][0]["stale"])
        self.assertEqual(snapshot["clusters"][0]["last_success_epoch"], 100)

    def test_get_snapshot_collects_once_until_forced(self) -> None:
        collector = SnapshotCollector(self.config, max_age_seconds=900)
        first = payload(2_000_000_000, cluster_result(ok=True, jobs=2))
        second = payload(2_000_000_001, cluster_result(ok=True, jobs=3))
        with patch(
            "cluster_observer.collector.collect_all_clusters",
            side_effect=[first, second],
        ) as collect:
            with patch("cluster_observer.collector.time.time", return_value=2_000_000_001):
                cached = collector.get_snapshot()
                self.assertEqual(collector.get_snapshot(), cached)
                forced = collector.get_snapshot(force=True)

        self.assertEqual(collect.call_count, 2)
        self.assertEqual(cached["total_jobs"], 2)
        self.assertEqual(forced["total_jobs"], 3)

    def test_failed_refresh_preserves_last_successful_cluster_data(self) -> None:
        collector = SnapshotCollector(self.config)
        responses = [
            payload(100, cluster_result(ok=True, jobs=2)),
            payload(130, cluster_result(ok=False)),
        ]
        with patch(
            "cluster_observer.collector.collect_all_clusters",
            side_effect=responses,
        ):
            collector.refresh()
            snapshot = collector.refresh()

        cluster = snapshot["clusters"][0]
        self.assertFalse(cluster["ok"])
        self.assertTrue(cluster["stale"])
        self.assertEqual(cluster["job_count"], 2)
        self.assertEqual(cluster["last_success_epoch"], 100)
        self.assertEqual(cluster["error"], "temporary failure")
        self.assertEqual(snapshot["total_jobs"], 2)
        self.assertEqual(snapshot["stale_clusters"], 1)

    def test_initial_failure_has_no_stale_data(self) -> None:
        collector = SnapshotCollector(self.config)
        with patch(
            "cluster_observer.collector.collect_all_clusters",
            return_value=payload(100, cluster_result(ok=False)),
        ):
            snapshot = collector.refresh()

        cluster = snapshot["clusters"][0]
        self.assertFalse(cluster["stale"])
        self.assertEqual(cluster["job_count"], 0)
