from __future__ import annotations

from collections import Counter

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


def _sorted_counts(counter: Counter[str]) -> list[dict[str, str | int]]:
    return [
        {"value": value, "count": count}
        for value, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]


def _gpu_count(job: JobRecord) -> int:
    try:
        return int(job.gpu or "0")
    except ValueError:
        return 0


def _configured_project_values(cluster: ClusterConfig) -> tuple[str, ...]:
    values: list[str] = []
    seen: set[str] = set()
    for filters in cluster.filter_groups.values():
        for value in filters.get("project", ()):
            if value not in seen:
                seen.add(value)
                values.append(value)
    return tuple(values)


def summarize_jobs(jobs: list[JobRecord], cluster: ClusterConfig | None = None) -> dict:
    state_counts = Counter((job.state or "").upper() or "-" for job in jobs)
    user_counts = Counter(job.user or "-" for job in jobs)
    queue_counts = Counter(job.queue or "-" for job in jobs)
    project_counts = Counter(job.project or "-" for job in jobs)
    configured_projects = set(_configured_project_values(cluster)) if cluster else set()
    if configured_projects:
        project_counts = Counter(
            {
                project: count
                for project, count in project_counts.items()
                if project in configured_projects
            }
        )
    running_gpu_by_user = Counter()
    for job in jobs:
        if (job.state or "").upper() == "R":
            running_gpu_by_user[job.user or "-"] += _gpu_count(job)
    return {
        "total_jobs": len(jobs),
        "running_jobs": state_counts.get("R", 0),
        "queued_jobs": state_counts.get("Q", 0),
        "held_jobs": state_counts.get("H", 0),
        "other_jobs": sum(
            count for state, count in state_counts.items() if state not in {"R", "Q", "H"}
        ),
        "users_count": len(user_counts),
        "queues_count": len(queue_counts),
        "projects_count": len(project_counts),
        "running_gpu_total": sum(running_gpu_by_user.values()),
        "state_counts": _sorted_counts(state_counts),
        "user_counts": _sorted_counts(user_counts),
        "queue_counts": _sorted_counts(queue_counts),
        "project_counts": _sorted_counts(project_counts),
        "running_gpu_by_user": [
            {"value": value, "count": count}
            for value, count in sorted(
                running_gpu_by_user.items(),
                key=lambda item: (-item[1], item[0]),
            )
        ],
    }
