from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cluster_observer.config import ClusterConfig
from cluster_observer.models import JobRecord
from cluster_observer.qstat import (
    _build_quota_groups,
    _parse_project_quotas,
    _parse_qstat_output,
    collect_cluster_jobs,
)


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
    Resource_List.ncpus = 8
    Resource_List.ngpus = 1
    schedstart = 2026-07-01 10:05:00

Job Id: 201.gaas
    Job_Owner = bob@gaas
    job_state = Q
    ctime = 2026-07-01 10:02:00
    queue = gpu_debug
    project = proj-b
    Resource_List.select = 2:ncpus=16:ngpus=1+1:ncpus=4
    Resource_List.walltime = 02:00:00
    estimated.start_time = 2026-07-01 11:00:00
"""


class QstatTests(unittest.TestCase):
    def test_parse_project_quotas_scopes_cpu_and_gpu_limits(self) -> None:
        output = """
        max_run_res.ngpus = [p:gs_cceb_r.ni=2]
        max_run_res.ncpus = [p:gs_cceb_r.ni=24]
        max_run_res.ngpus = [p:other-project=8]
        """

        self.assertEqual(
            _parse_project_quotas(output, {"gs_cceb_r.ni"}),
            {"gs_cceb_r.ni": {"gpu": 2, "cpu": 24}},
        )

    def test_manual_quota_group_replaces_covered_pbs_project_quota(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={"project": {"project": ("proj-a", "proj-b")}},
            quota_groups=(
                {
                    "name": "shared",
                    "label": "shared queue",
                    "projects": ("proj-a",),
                    "gpu": 8,
                },
            ),
        )

        groups = _build_quota_groups(
            cluster,
            [],
            {"proj-a": {"gpu": 1}, "proj-b": {"gpu": 2}},
        )

        self.assertEqual([group["name"] for group in groups], ["shared", "pbs:proj-b"])

    def test_shared_quota_splits_configured_projects_from_external_usage(self) -> None:
        cluster = ClusterConfig(
            name="gaas",
            host="gaas.example",
            user="alice",
            filter_groups={"project": {"project": ("proj-a",)}},
            quota_groups=(
                {
                    "name": "shared",
                    "queue": "gpu_as",
                    "covers_projects": ("proj-a",),
                    "gpu": 8,
                },
            ),
        )
        jobs = [
            JobRecord("gaas", "1", "alice", "R", "proj-a", "", "gpu_as", "2", "", "", ""),
            JobRecord("gaas", "2", "bob", "R", "external", "", "gpu_as", "3", "", "", ""),
        ]

        groups = _build_quota_groups(cluster, jobs, {"proj-a": {"gpu": 1}})

        self.assertEqual(groups[0]["used_gpu"], 5)
        self.assertEqual(groups[0]["own_used_gpu"], 2)
        self.assertEqual(groups[0]["own_projects"], ["proj-a"])
        self.assertEqual([group["name"] for group in groups], ["shared"])

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
        self.assertEqual(jobs[0].cpu, "8")
        self.assertEqual(jobs[0].gpu, "1")
        self.assertEqual(jobs[1].cpu, "36")
        self.assertEqual(jobs[1].gpu, "2")
        self.assertEqual(jobs[1].resource_shape, "2x (16 CPU / 1 GPU) + 4 CPU")
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
            payload = collect_cluster_jobs(
                cluster,
                timeout_seconds=5,
                user_aliases={"alice": "Alice A."},
            )

        self.assertTrue(payload["ok"])
        self.assertEqual([job["job_id"] for job in payload["jobs"]], ["200[1].gaas"])
        self.assertEqual(payload["jobs"][0]["cpu"], "8")
        self.assertEqual(payload["jobs"][0]["user_alias"], "Alice A.")
        self.assertEqual(
            payload["summary"]["user_counts"][0],
            {"value": "alice", "label": "Alice A. (alice)", "count": 1},
        )
        self.assertEqual(payload["job_groups"][0]["job_count"], 1)
        self.assertEqual(payload["summary"]["total_jobs"], 1)
