from __future__ import annotations

from collections.abc import Mapping
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
    cpu: str = ""
    resource_shape: str = ""

    def to_dict(self, user_aliases: Mapping[str, str] | None = None) -> dict[str, str]:
        payload = asdict(self)
        payload["user_alias"] = (user_aliases or {}).get(self.user, "")
        return payload


@dataclass(frozen=True)
class JobGroup:
    name: str
    filters: dict[str, tuple[str, ...]]
    jobs: tuple[JobRecord, ...]

    def to_dict(self, user_aliases: Mapping[str, str] | None = None) -> dict:
        return {
            "name": self.name,
            "filters": {key: list(values) for key, values in self.filters.items()},
            "jobs": [job.to_dict(user_aliases) for job in self.jobs],
            "job_count": len(self.jobs),
        }
