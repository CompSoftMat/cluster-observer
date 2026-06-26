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
    project: str
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


def _cluster_from_dict(raw: dict) -> ClusterConfig:
    name = str(raw["name"])
    host = str(raw["host"])
    user = str(raw.get("user") or os.environ.get("USER", ""))
    project_raw = raw.get("project")
    ssh_options = tuple(str(item) for item in raw.get("ssh_options", []))
    qstat_path = str(raw.get("qstat_path", "qstat"))
    qstat_args = tuple(str(item) for item in raw.get("qstat_args", ["-f"]))
    if not user:
        raise ValueError(f"cluster {name!r} is missing user")
    if not project_raw:
        raise ValueError(f"cluster {name!r} is missing project")
    project = str(project_raw)
    return ClusterConfig(
        name=name,
        host=host,
        user=user,
        project=project,
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
