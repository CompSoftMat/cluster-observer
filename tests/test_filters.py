from __future__ import annotations

import unittest

from cluster_observer.config import ClusterConfig
from cluster_observer.filters import build_job_groups, summarize_jobs
from cluster_observer.models import JobRecord


class FilterTests(unittest.TestCase):
    def test_build_job_groups_separates_groups_and_deduplicates_cluster_count(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={
                "project": {"project": ("proj-a",)},
                "free_queue": {"queue": ("gpu_free",)},
            },
        )
        jobs = [
            JobRecord(
                cluster="gaas",
                job_id="100",
                user="alice",
                state="R",
                project="proj-a",
                submitted_at="2026-07-01 10:00:00",
                queue="gpu_free",
                gpu="1",
                used_walltime="00:10:00",
                requested_walltime="01:00:00",
                scheduled_start_time="",
            ),
            JobRecord(
                cluster="gaas",
                job_id="101",
                user="bob",
                state="Q",
                project="proj-b",
                submitted_at="2026-07-01 10:05:00",
                queue="gpu_free",
                gpu="1",
                used_walltime="",
                requested_walltime="02:00:00",
                scheduled_start_time="2026-07-01 11:00:00",
            ),
        ]

        groups, unique_jobs = build_job_groups(cluster, jobs)

        self.assertEqual([group.name for group in groups], ["project", "free_queue"])
        self.assertEqual([job.job_id for job in groups[0].jobs], ["100"])
        self.assertEqual([job.job_id for job in groups[1].jobs], ["100", "101"])
        self.assertEqual([job.job_id for job in unique_jobs], ["100", "101"])

    def test_summarize_jobs_builds_counts_for_faceted_dashboard(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={
                "project": {"project": ("proj-a",)},
                "free_queue": {"queue": ("gpu_free",)},
            },
        )
        jobs = [
            JobRecord(
                cluster="gaas",
                job_id="100",
                user="alice",
                state="R",
                project="proj-a",
                submitted_at="2026-07-01 10:00:00",
                queue="gpu_free",
                gpu="2",
                used_walltime="00:10:00",
                requested_walltime="01:00:00",
                scheduled_start_time="",
            ),
            JobRecord(
                cluster="gaas",
                job_id="101",
                user="bob",
                state="Q",
                project="proj-b",
                submitted_at="2026-07-01 10:05:00",
                queue="gpu_free",
                gpu="1",
                used_walltime="",
                requested_walltime="02:00:00",
                scheduled_start_time="2026-07-01 11:00:00",
            ),
            JobRecord(
                cluster="gaas",
                job_id="102",
                user="alice",
                state="H",
                project="proj-a",
                submitted_at="2026-07-01 10:06:00",
                queue="gpu_debug",
                gpu="not-a-number",
                used_walltime="",
                requested_walltime="02:00:00",
                scheduled_start_time="2026-07-01 11:30:00",
            ),
        ]

        summary = summarize_jobs(jobs, cluster)

        self.assertEqual(summary["total_jobs"], 3)
        self.assertEqual(summary["running_jobs"], 1)
        self.assertEqual(summary["queued_jobs"], 1)
        self.assertEqual(summary["held_jobs"], 1)
        self.assertEqual(summary["running_gpu_total"], 2)
        self.assertEqual(summary["user_counts"][0], {"value": "alice", "count": 2})
        self.assertEqual(summary["queue_counts"][0], {"value": "gpu_free", "count": 2})
        self.assertEqual(summary["projects_count"], 1)
        self.assertEqual(summary["project_counts"], [{"value": "proj-a", "count": 2}])
        self.assertEqual(summary["running_gpu_by_user"], [{"value": "alice", "count": 2}])
