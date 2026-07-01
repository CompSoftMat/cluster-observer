from __future__ import annotations

from cluster_observer.config import ClusterConfig
from cluster_observer.models import JobGroup, JobRecord


def matches_filters(job: JobRecord, filters: dict[str, tuple[str, ...]]) -> bool:
    job_data = job.to_dict()
    for key, allowed_values in filters.items():
        if job_data.get(key) not in allowed_values:
            return False
    return True


def build_job_groups(
    cluster: ClusterConfig, jobs: list[JobRecord]
) -> tuple[list[JobGroup], list[JobRecord]]:
    groups: list[JobGroup] = []
    seen_job_ids: set[str] = set()
    unique_jobs: list[JobRecord] = []
    for group_name, filters in cluster.filter_groups.items():
        matching_jobs = tuple(job for job in jobs if matches_filters(job, filters))
        for job in matching_jobs:
            if job.job_id not in seen_job_ids:
                seen_job_ids.add(job.job_id)
                unique_jobs.append(job)
        groups.append(JobGroup(name=group_name, filters=filters, jobs=matching_jobs))
    return groups, unique_jobs
