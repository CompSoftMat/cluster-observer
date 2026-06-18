from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
import shlex
import subprocess
import time

from cluster_observer.config import AppConfig, ClusterConfig


@dataclass(frozen=True)
class JobRecord:
    cluster: str
    job_id: str
    user: str
    state: str
    submitted_at: str
    queue: str
    gpu: str
    used_walltime: str
    requested_walltime: str
    scheduled_start_time: str


def _masked_host(host: str) -> str:
    parts = host.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        return f"...{parts[-1]}"
    digits = "".join(ch for ch in host if ch.isdigit())
    if digits:
        return f"...{digits[-1]}"
    return "hidden"


def _sanitize_message(message: str, cluster: ClusterConfig) -> str:
    return message.replace(cluster.host, _masked_host(cluster.host))


def _parse_qstat_output(output: str, cluster: ClusterConfig) -> list[JobRecord]:
    jobs: list[JobRecord] = []
    current: dict[str, str] = {}
    interesting_project = cluster.project

    def flush() -> None:
        if current.get("project") != interesting_project:
            current.clear()
            return
        if "job_id" not in current:
            current.clear()
            return
        jobs.append(
            JobRecord(
                cluster=cluster.name,
                job_id=current.get("job_id", ""),
                user=current.get("user", ""),
                state=current.get("state", ""),
                submitted_at=current.get("submitted_at", ""),
                queue=current.get("queue", ""),
                gpu=current.get("gpu", ""),
                used_walltime=current.get("used_walltime", ""),
                requested_walltime=current.get("requested_walltime", ""),
                scheduled_start_time=current.get("scheduled_start_time", ""),
            )
        )
        current.clear()

    for raw_line in output.splitlines():
        if not raw_line.strip():
            continue
        if raw_line.startswith("Job Id:"):
            flush()
            current["job_id"] = raw_line.split(":", 1)[1].strip()
            continue
        if "=" not in raw_line:
            continue
        key, value = (part.strip() for part in raw_line.split("=", 1))
        if key == "Job_Owner":
            current["user"] = value.split("@", 1)[0]
        elif key == "job_state":
            current["state"] = value
        elif key in {"qtime", "ctime", "etime"}:
            current.setdefault("submitted_at", value)
        elif key == "queue":
            current["queue"] = value
        elif key == "resources_used.walltime":
            current["used_walltime"] = value
        elif key == "Resource_List.walltime":
            current["requested_walltime"] = value
        elif key == "Resource_List.ngpus":
            current["gpu"] = value
        elif key in {"estimated.start_time", "estimated.exec_time", "schedstart"}:
            current["scheduled_start_time"] = value
        elif key == "project":
            current["project"] = value

    flush()
    return jobs


def _ssh_command(cluster: ClusterConfig) -> list[str]:
    destination = f"{cluster.user}@{cluster.host}"
    remote_command = f"{shlex.quote(cluster.qstat_path)} -f"
    return ["ssh", *cluster.ssh_options, destination, remote_command]


def collect_cluster_jobs(cluster: ClusterConfig, timeout_seconds: int) -> dict:
    started = time.time()
    masked_host = _masked_host(cluster.host)
    try:
        proc = subprocess.run(
            _ssh_command(cluster),
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        jobs = _parse_qstat_output(proc.stdout, cluster)
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": True,
            "jobs": [asdict(job) for job in jobs],
            "job_count": len(jobs),
            "duration_seconds": round(time.time() - started, 2),
        }
    except subprocess.TimeoutExpired:
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": False,
            "error": f"ssh command timed out after {timeout_seconds}s",
            "jobs": [],
            "job_count": 0,
            "duration_seconds": round(time.time() - started, 2),
        }
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or exc.stdout.strip() or "ssh/qstat failed"
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": False,
            "error": _sanitize_message(message, cluster),
            "jobs": [],
            "job_count": 0,
            "duration_seconds": round(time.time() - started, 2),
        }


def collect_all_clusters(config: AppConfig) -> dict:
    clusters: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(config.clusters)) as executor:
        futures = {
            executor.submit(collect_cluster_jobs, cluster, config.request_timeout_seconds): cluster
            for cluster in config.clusters
        }
        for future in as_completed(futures):
            clusters.append(future.result())

    clusters.sort(key=lambda item: item["cluster"])
    total_jobs = sum(item["job_count"] for item in clusters)
    ok_clusters = sum(1 for item in clusters if item["ok"])
    return {
        "dashboard_title": config.dashboard_title,
        "generated_at_epoch": int(time.time()),
        "refresh_seconds": config.refresh_seconds,
        "total_jobs": total_jobs,
        "ok_clusters": ok_clusters,
        "total_clusters": len(clusters),
        "clusters": clusters,
    }
