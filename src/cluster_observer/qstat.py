from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
import re
import shlex
import subprocess
import time

from cluster_observer.config import AppConfig, ClusterConfig
from cluster_observer.filters import build_job_groups, summarize_jobs
from cluster_observer.models import JobRecord


LOGGER = logging.getLogger(__name__)


def _parse_select_resources(value: str) -> dict[str, str]:
    totals = {"cpu": 0, "gpu": 0}
    for chunk in value.split("+"):
        parts = chunk.split(":")
        multiplier = int(parts[0]) if parts and parts[0].isdigit() else 1
        for part in parts[1:] if parts and parts[0].isdigit() else parts:
            key, separator, raw_count = part.partition("=")
            if not separator or not raw_count.isdigit():
                continue
            if key == "ncpus":
                totals["cpu"] += multiplier * int(raw_count)
            elif key == "ngpus":
                totals["gpu"] += multiplier * int(raw_count)
    return {key: str(count) for key, count in totals.items() if count}


def _format_select_resources(value: str) -> str:
    chunks: list[str] = []
    for chunk in value.split("+"):
        parts = chunk.split(":")
        multiplier = int(parts[0]) if parts and parts[0].isdigit() else 1
        resource_parts = parts[1:] if parts and parts[0].isdigit() else parts
        resources: list[str] = []
        for part in resource_parts:
            key, separator, raw_count = part.partition("=")
            if not separator or not raw_count.isdigit() or int(raw_count) == 0:
                continue
            if key == "ncpus":
                resources.append(f"{raw_count} CPU")
            elif key == "ngpus":
                resources.append(f"{raw_count} GPU")
        if not resources:
            continue
        label = " / ".join(resources)
        chunks.append(f"{multiplier}x ({label})" if multiplier > 1 else label)
    return " + ".join(chunks)


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


def _job_id_base(job_id: str) -> str:
    return job_id.split(".", 1)[0].split("[", 1)[0]


def _drop_batched_parent_rows(jobs: list[JobRecord]) -> list[JobRecord]:
    child_bases = {
        _job_id_base(job.job_id)
        for job in jobs
        if "[" in job.job_id and "]" in job.job_id
    }
    if not child_bases:
        return jobs
    return [
        job
        for job in jobs
        if not (job.state == "B" and _job_id_base(job.job_id) in child_bases)
    ]


def _parse_qstat_output(output: str, cluster: ClusterConfig) -> list[JobRecord]:
    jobs: list[JobRecord] = []
    current: dict[str, str] = {}

    def flush() -> None:
        if "job_id" not in current:
            current.clear()
            return
        jobs.append(
            JobRecord(
                cluster=cluster.name,
                job_id=current.get("job_id", ""),
                user=current.get("user", ""),
                state=current.get("state", ""),
                project=current.get("project", ""),
                submitted_at=current.get("submitted_at", ""),
                queue=current.get("queue", ""),
                cpu=current.get("cpu", ""),
                gpu=current.get("gpu", ""),
                used_walltime=current.get("used_walltime", ""),
                requested_walltime=current.get("requested_walltime", ""),
                scheduled_start_time=current.get("scheduled_start_time", ""),
                resource_shape=current.get("resource_shape", ""),
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
        elif key == "Resource_List.ncpus":
            current["cpu"] = value
        elif key == "Resource_List.select":
            current["resource_shape"] = _format_select_resources(value)
            for resource, count in _parse_select_resources(value).items():
                current.setdefault(resource, count)
        elif key in {"estimated.start_time", "estimated.exec_time", "schedstart"}:
            current["scheduled_start_time"] = value
        elif key == "project":
            current["project"] = value

    flush()
    return _drop_batched_parent_rows(jobs)


def _ssh_command(cluster: ClusterConfig, qstat_args: tuple[str, ...] | None = None) -> list[str]:
    destination = f"{cluster.user}@{cluster.host}"
    command_parts = [cluster.qstat_path, *(qstat_args if qstat_args is not None else cluster.qstat_args)]
    remote_command = " ".join(shlex.quote(part) for part in command_parts)
    return ["ssh", *cluster.ssh_options, destination, remote_command]


def _configured_projects(cluster: ClusterConfig) -> set[str]:
    return {
        project
        for filters in cluster.filter_groups.values()
        for project in filters.get("project", ())
    }


def _parse_project_quotas(output: str, projects: set[str]) -> dict[str, dict[str, int]]:
    quotas: dict[str, dict[str, int]] = {}
    pattern = re.compile(
        r"max_run_res\.(?P<resource>ncpus|ngpus|cpu|gpu)\s*=\s*\[(?P<values>[^\]]*)\]"
    )
    entry_pattern = re.compile(r"p:(?P<project>[^=,\s]+)=(?P<limit>\d+)")
    for match in pattern.finditer(output):
        resource = "cpu" if match.group("resource") in {"cpu", "ncpus"} else "gpu"
        for entry in entry_pattern.finditer(match.group("values")):
            project = entry.group("project")
            if project not in projects:
                continue
            quotas.setdefault(project, {})[resource] = int(entry.group("limit"))
    return quotas


def _collect_project_quotas(cluster: ClusterConfig, timeout_seconds: int) -> dict[str, dict[str, int]]:
    projects = _configured_projects(cluster)
    if not projects:
        return {}
    try:
        proc = subprocess.run(
            _ssh_command(cluster, ("-Bf",)),
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        quotas = _parse_project_quotas(proc.stdout, projects)
        LOGGER.info("project quotas collected cluster=%s projects=%d", cluster.name, len(quotas))
        return quotas
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
        LOGGER.warning("project quota collection failed cluster=%s error=%s", cluster.name, exc)
        return {}


def _quota_group_matches(group: dict[str, object], job: JobRecord) -> bool:
    projects = group.get("projects", ())
    if group.get("project"):
        projects = (*projects, group["project"])
    queues = group.get("queues", ())
    if group.get("queue"):
        queues = (*queues, group["queue"])
    if projects and job.project not in projects:
        return False
    if queues and job.queue not in queues:
        return False
    return True


def _build_quota_group(
    group: dict[str, object],
    jobs: list[JobRecord],
    own_projects: set[str] | None = None,
) -> dict:
    own_projects = own_projects or set(group.get("own_projects", ()))
    used_cpu = 0
    used_gpu = 0
    own_used_cpu = 0
    own_used_gpu = 0
    for job in jobs:
        if (job.state or "").upper() != "R" or not _quota_group_matches(group, job):
            continue
        cpu = 0
        try:
            cpu = int(job.cpu or "0")
        except ValueError:
            pass
        used_cpu += cpu
        gpu = 0
        try:
            gpu = int(job.gpu or "0")
        except ValueError:
            pass
        used_gpu += gpu
        if job.project in own_projects:
            own_used_cpu += cpu
            own_used_gpu += gpu
    return {
        "name": str(group["name"]),
        "label": str(group.get("label", group["name"])),
        "source": str(group.get("source", "configured")),
        "color": str(group.get("color", "manual")),
        "cpu": group.get("cpu"),
        "gpu": group.get("gpu"),
        "used_cpu": used_cpu,
        "used_gpu": used_gpu,
        "own_projects": sorted(own_projects),
        "own_used_cpu": own_used_cpu,
        "own_used_gpu": own_used_gpu,
    }


def _build_quota_groups(
    cluster: ClusterConfig,
    jobs: list[JobRecord],
    project_quotas: dict[str, dict[str, int]],
) -> list[dict]:
    configured_projects = _configured_projects(cluster)
    groups = [
        _build_quota_group(group, jobs, configured_projects)
        for group in cluster.quota_groups
    ]
    covered_projects = {
        project
        for group in cluster.quota_groups
        for project in (
            (*group.get("covers_projects", ()), *group.get("projects", ()), group["project"])
            if group.get("project")
            else (*group.get("covers_projects", ()), *group.get("projects", ()))
        )
    }
    for project, limits in sorted(project_quotas.items()):
        if project in covered_projects:
            continue
        groups.append(
            _build_quota_group(
                {
                    "name": f"pbs:{project}",
                    "label": project,
                    "source": "pbs",
                    "color": "pbs",
                    "project": project,
                    **limits,
                },
                jobs,
            )
        )
    return groups


def collect_cluster_jobs(
    cluster: ClusterConfig,
    timeout_seconds: int,
    user_aliases: dict[str, str] | None = None,
) -> dict:
    started = time.time()
    masked_host = _masked_host(cluster.host)
    LOGGER.info("cluster collection started cluster=%s", cluster.name)
    try:
        proc = subprocess.run(
            _ssh_command(cluster),
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        parsed_jobs = _parse_qstat_output(proc.stdout, cluster)
        job_groups, jobs = build_job_groups(cluster, parsed_jobs)
        project_quotas = _collect_project_quotas(cluster, timeout_seconds)
        quota_groups = _build_quota_groups(cluster, parsed_jobs, project_quotas)
        result = {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": True,
            "jobs": [job.to_dict(user_aliases) for job in jobs],
            "job_groups": [group.to_dict(user_aliases) for group in job_groups],
            "summary": summarize_jobs(jobs, cluster, user_aliases),
            "project_quotas": project_quotas,
            "quota_groups": quota_groups,
            "job_count": len(jobs),
            "duration_seconds": round(time.time() - started, 2),
        }
        LOGGER.info(
            "cluster collection succeeded cluster=%s jobs=%d duration_seconds=%.2f",
            cluster.name,
            result["job_count"],
            result["duration_seconds"],
        )
        return result
    except subprocess.TimeoutExpired:
        LOGGER.warning(
            "cluster collection timed out cluster=%s timeout_seconds=%d",
            cluster.name,
            timeout_seconds,
        )
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": False,
            "error": f"ssh command timed out after {timeout_seconds}s",
            "jobs": [],
            "job_groups": [],
            "summary": summarize_jobs([], cluster, user_aliases),
            "job_count": 0,
            "duration_seconds": round(time.time() - started, 2),
        }
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or exc.stdout.strip() or "ssh/qstat failed"
        LOGGER.warning(
            "cluster collection failed cluster=%s returncode=%s error=%s",
            cluster.name,
            exc.returncode,
            _sanitize_message(message, cluster),
        )
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": False,
            "error": _sanitize_message(message, cluster),
            "jobs": [],
            "job_groups": [],
            "summary": summarize_jobs([], cluster, user_aliases),
            "job_count": 0,
            "duration_seconds": round(time.time() - started, 2),
        }
    except OSError as exc:
        message = _sanitize_message(str(exc), cluster)
        LOGGER.warning("cluster collection could not start cluster=%s error=%s", cluster.name, message)
        return {
            "cluster": cluster.name,
            "host": masked_host,
            "ok": False,
            "error": message,
            "jobs": [],
            "job_groups": [],
            "summary": summarize_jobs([], cluster, user_aliases),
            "job_count": 0,
            "duration_seconds": round(time.time() - started, 2),
        }


def collect_all_clusters(config: AppConfig) -> dict:
    clusters: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(config.clusters)) as executor:
        futures = {
            executor.submit(
                collect_cluster_jobs,
                cluster,
                config.request_timeout_seconds,
                config.user_aliases,
            ): cluster
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
