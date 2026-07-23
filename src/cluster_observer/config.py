from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import tomllib


DEFAULT_CONFIG_PATH = Path.home() / ".config" / "cluster-observer" / "config.toml"


@dataclass(frozen=True)
class ClusterConfig:
    name: str
    host: str
    user: str
    filter_groups: dict[str, dict[str, tuple[str, ...]]]
    ssh_options: tuple[str, ...] = ()
    qstat_path: str = "qstat"
    qstat_args: tuple[str, ...] = ("-f",)


@dataclass(frozen=True)
class AppConfig:
    dashboard_title: str
    host: str
    port: int
    refresh_seconds: int
    request_timeout_seconds: int
    clusters: tuple[ClusterConfig, ...]


def _load_file(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _normalize_filter_map(raw: dict) -> dict[str, tuple[str, ...]]:
    filters: dict[str, tuple[str, ...]] = {}
    for key, raw_value in raw.items():
        if isinstance(raw_value, list):
            values = tuple(str(item) for item in raw_value if str(item))
        else:
            value = str(raw_value)
            values = (value,) if value else ()
        if values:
            filters[str(key)] = values
    return filters


def _cluster_from_dict(raw: dict) -> ClusterConfig:
    name = str(raw["name"])
    host = str(raw["host"])
    user = str(raw.get("user") or os.environ.get("USER", ""))
    filters_raw = raw.get("filters")
    filter_groups_raw = raw.get("filter_groups")
    ssh_options = tuple(str(item) for item in raw.get("ssh_options", []))
    qstat_path = str(raw.get("qstat_path", "qstat"))
    qstat_args = tuple(str(item) for item in raw.get("qstat_args", ["-f"]))
    if not user:
        raise ValueError(f"cluster {name!r} is missing user")
    filter_groups: dict[str, dict[str, tuple[str, ...]]] = {}
    if isinstance(filter_groups_raw, dict):
        for group_name, group_raw in filter_groups_raw.items():
            if isinstance(group_raw, dict):
                normalized = _normalize_filter_map(group_raw)
                if normalized:
                    filter_groups[str(group_name)] = normalized
    if isinstance(filters_raw, dict):
        normalized = _normalize_filter_map(filters_raw)
        if normalized:
            filter_groups.setdefault("matching jobs", normalized)
    project_raw = raw.get("project")
    if project_raw:
        legacy_group = dict(filter_groups.get("matching jobs", {}))
        legacy_group.setdefault("project", (str(project_raw),))
        filter_groups["matching jobs"] = legacy_group
    if not filter_groups:
        filter_groups["all jobs"] = {}
    return ClusterConfig(
        name=name,
        host=host,
        user=user,
        filter_groups=filter_groups,
        ssh_options=ssh_options,
        qstat_path=qstat_path,
        qstat_args=qstat_args,
    )


def load_config(config_path: str | None = None) -> AppConfig:
    path = Path(config_path).expanduser() if config_path else DEFAULT_CONFIG_PATH
    raw = _load_file(path)
    server = raw.get("server", {})
    clusters = tuple(_cluster_from_dict(item) for item in raw.get("clusters", []))
    if not clusters:
        raise ValueError(f"no clusters configured in {path}")
    return AppConfig(
        dashboard_title=str(server.get("dashboard_title", "Cluster Status")),
        host=str(server.get("host", "0.0.0.0")),
        port=int(server.get("port", 8080)),
        refresh_seconds=int(server.get("refresh_seconds", 30)),
        request_timeout_seconds=int(server.get("request_timeout_seconds", 20)),
        clusters=clusters,
    )
