from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class JobRecord:
    cluster: str
    job_id: str
    user: str
    state: str
    project: str
    submitted_at: str
    queue: str
    gpu: str
    used_walltime: str
    requested_walltime: str
    scheduled_start_time: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class JobGroup:
    name: str
    filters: dict[str, tuple[str, ...]]
    jobs: tuple[JobRecord, ...]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "filters": {key: list(values) for key, values in self.filters.items()},
            "jobs": [job.to_dict() for job in self.jobs],
            "job_count": len(self.jobs),
        }
