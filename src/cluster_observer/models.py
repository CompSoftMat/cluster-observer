from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
import re


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
    exit_status: int | None = None
    depend: str = ""
    hold_types: str = ""
    comment: str = ""

    @property
    def outcome(self) -> str:
        if self.state.upper() not in {"X", "F", "C"}:
            return ""
        if self.exit_status == 0:
            return "successful"
        if self.exit_status is not None and re.search(r"\b(cancelled|canceled|deleted by|job deleted)\b", self.comment, re.I):
            return "cancelled"
        return "failed" if self.exit_status is not None else "unknown"

    @property
    def dependency_job_ids(self) -> list[str]:
        return list(dict.fromkeys(
            job_id.strip()
            for dependency in self.depend.split(",")
            if dependency.strip().split(":", 1)[0].startswith("after")
            for job_id in dependency.split(":")[1:]
            if job_id.strip()
        ))

    def to_dict(self, user_aliases: Mapping[str, str] | None = None) -> dict:
        payload = asdict(self)
        payload["user_alias"] = (user_aliases or {}).get(self.user, "")
        payload["raw_state"] = self.state
        payload["outcome"] = self.outcome
        payload["dependency_job_ids"] = self.dependency_job_ids
        payload["status_label"] = {
            "successful": "Completed successfully",
            "failed": "Failed",
            "cancelled": "Cancelled",
            "unknown": "Finished — outcome unknown",
        }.get(self.outcome, {"R": "Running", "Q": "Queued", "H": "Held"}.get(self.state.upper(), self.state))
        if self.state.upper() == "H" and self.dependency_job_ids:
            payload["status_label"] = "Waiting for dependency"
        payload["completion_scope"] = "job_segment"
        payload["chain_status"] = "unknown"
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
