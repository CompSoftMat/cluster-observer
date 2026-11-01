from dataclasses import replace
import unittest

from cluster_observer.config import ClusterConfig
from cluster_observer.filters import summarize_jobs
from cluster_observer.qstat import _parse_qstat_output


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.cluster = ClusterConfig("test", "localhost", "test", {})

    def parse(self, attributes):
        return _parse_qstat_output("Job Id: 42[1].pbs\n" + attributes, self.cluster)[0]

    def test_terminal_outcomes_require_exit_status(self):
        for state in ("X", "F", "C"):
            for exit_status, outcome in ((None, "unknown"), (0, "successful"), (1, "failed"), (-1, "failed")):
                with self.subTest(state=state, exit_status=exit_status):
                    job = self.parse(f"    job_state = {state}\n" + (f"    Exit_status = {exit_status}\n" if exit_status is not None else ""))
                    self.assertEqual(job.outcome, outcome)
                    self.assertEqual(job.to_dict()["raw_state"], state)
                    self.assertEqual(job.to_dict()["chain_status"], "unknown")
        job = self.parse("    job_state = X\n    Exit_status = 271\n    comment = Job deleted by user\n")
        self.assertEqual(job.outcome, "cancelled")
        self.assertEqual(replace(job, exit_status=None).outcome, "unknown")
        self.assertEqual(replace(job, state="R").outcome, "")

    def test_dependency_hold_with_wrapped_predecessors(self):
        job = self.parse("    job_state = H\n    depend = afterok:40.pbs:\n\t41.pbs\n    Hold_Types = s\n")
        self.assertEqual(job.to_dict()["status_label"], "Waiting for dependency")
        self.assertEqual(job.dependency_job_ids, ["40.pbs", "41.pbs"])

    def test_array_counts_and_unknown_resources(self):
        output = "Job Id: 42[].pbs\n    job_state = B\n    project = lab\n"
        for index, (state, code) in enumerate((("X", "0"), ("X", "2"), ("X", ""), ("R", ""), ("Q", ""), ("H", ""))):
            output += f"Job Id: 42[{index}].pbs\n    job_state = {state}\n"
            if code:
                output += f"    Exit_status = {code}\n"
        jobs = _parse_qstat_output(output, self.cluster)
        self.assertEqual(len(jobs), 6)
        self.assertTrue(all(job.project == "lab" for job in jobs))
        summary = summarize_jobs(jobs)
        for category in ("successful", "failed", "unknown", "running", "queued", "held"):
            self.assertEqual(summary["array_counts"][0][category], 1)
        self.assertIsNone(summary["running_cpu_total"])
        self.assertIsNone(summary["running_gpu_total"])
        explicit_zero = self.parse("    job_state = R\n    Resource_List.ncpus = 0\n    Resource_List.select = 1:ngpus=0\n")
        self.assertEqual(summarize_jobs([explicit_zero])["running_gpu_total"], 0)
