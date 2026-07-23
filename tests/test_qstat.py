from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cluster_observer.config import ClusterConfig
from cluster_observer.qstat import _parse_qstat_output, collect_cluster_jobs


QSTAT_OUTPUT = """
Job Id: 200.gaas
    Job_Owner = alice@gaas
    job_state = B
    qtime = 2026-07-01 10:00:00
    queue = gpu_free
    project = proj-a

Job Id: 200[1].gaas
    Job_Owner = alice@gaas
    job_state = R
    qtime = 2026-07-01 10:01:00
    queue = gpu_free
    project = proj-a
    resources_used.walltime = 00:10:00
    Resource_List.walltime = 01:00:00
    Resource_List.ngpus = 1
    schedstart = 2026-07-01 10:05:00

Job Id: 201.gaas
    Job_Owner = bob@gaas
    job_state = Q
    ctime = 2026-07-01 10:02:00
    queue = gpu_debug
    project = proj-b
    Resource_List.walltime = 02:00:00
    estimated.start_time = 2026-07-01 11:00:00
"""


class QstatTests(unittest.TestCase):
    def test_parse_qstat_output_keeps_project_and_drops_batched_parent_rows(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={"project": {"project": ("proj-a",)}},
        )

        jobs = _parse_qstat_output(QSTAT_OUTPUT, cluster)

        self.assertEqual([job.job_id for job in jobs], ["200[1].gaas", "201.gaas"])
        self.assertEqual(jobs[0].project, "proj-a")
        self.assertEqual(jobs[0].submitted_at, "2026-07-01 10:01:00")
        self.assertEqual(jobs[1].submitted_at, "2026-07-01 10:02:00")
        self.assertEqual(jobs[1].scheduled_start_time, "2026-07-01 11:00:00")

    def test_collect_cluster_jobs_scopes_results_to_matching_groups(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={"project": {"project": ("proj-a",)}},
        )

        with patch(
            "cluster_observer.qstat.subprocess.run",
            return_value=SimpleNamespace(stdout=QSTAT_OUTPUT),
        ):
            payload = collect_cluster_jobs(cluster, timeout_seconds=5)

        self.assertTrue(payload["ok"])
        self.assertEqual([job["job_id"] for job in payload["jobs"]], ["200[1].gaas"])
        self.assertEqual(payload["job_groups"][0]["job_count"], 1)
        self.assertEqual(payload["summary"]["total_jobs"], 1)
