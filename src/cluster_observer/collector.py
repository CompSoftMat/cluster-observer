from __future__ import annotations

import logging
from threading import Lock
import time

from cluster_observer.config import AppConfig
from cluster_observer.qstat import collect_all_clusters


LOGGER = logging.getLogger(__name__)
CACHE_MAX_AGE_SECONDS = 15 * 60


class SnapshotCollector:
    """Collect scheduler state independently of dashboard requests."""

    def __init__(self, config: AppConfig, max_age_seconds: int = CACHE_MAX_AGE_SECONDS) -> None:
        self.config = config
        self.max_age_seconds = max_age_seconds
        self._snapshot: dict | None = None
        self._last_success: dict[str, dict] = {}
        self._lock = Lock()
        self._refresh_lock = Lock()

    def refresh(self) -> dict:
        with self._refresh_lock:
            return self._refresh_unlocked()

    def get_snapshot(self, force: bool = False) -> dict:
        with self._lock:
            current = self._snapshot
            observed_epoch = current["generated_at_epoch"] if current else None
            current_age = (
                time.time() - observed_epoch if observed_epoch is not None else None
            )
        if not force and current is not None and current_age is not None and current_age < self.max_age_seconds:
            LOGGER.info("serving cached snapshot age_seconds=%d", int(current_age))
            return current

        reason = "manual" if force else ("initial" if current is None else "expired")
        LOGGER.info("refresh required reason=%s", reason)
        with self._refresh_lock:
            with self._lock:
                latest = self._snapshot
                latest_epoch = latest["generated_at_epoch"] if latest else None
                latest_age = time.time() - latest_epoch if latest_epoch is not None else None
                # Another request may have refreshed while this request waited.
                if observed_epoch != latest_epoch and latest is not None:
                    if force or (latest_age is not None and latest_age < self.max_age_seconds):
                        LOGGER.info("using snapshot refreshed by another request")
                        return latest
                if not force and latest is not None and latest_age is not None and latest_age < self.max_age_seconds:
                    return latest
            return self._refresh_unlocked()

    def _refresh_unlocked(self) -> dict:
        started = time.monotonic()
        LOGGER.info("collection started clusters=%d", len(self.config.clusters))
        fresh = collect_all_clusters(self.config)
        merged_clusters: list[dict] = []

        with self._lock:
            for result in fresh["clusters"]:
                cluster_name = result["cluster"]
                if result["ok"]:
                    current = dict(result)
                    current["stale"] = False
                    current["last_success_epoch"] = fresh["generated_at_epoch"]
                    self._last_success[cluster_name] = current
                    merged_clusters.append(current)
                    continue

                previous = self._last_success.get(cluster_name)
                if previous is None:
                    current = dict(result)
                    current["stale"] = False
                    current["last_success_epoch"] = None
                    merged_clusters.append(current)
                    continue

                stale = dict(previous)
                stale.update(
                    ok=False,
                    stale=True,
                    error=result["error"],
                    duration_seconds=result["duration_seconds"],
                )
                merged_clusters.append(stale)
                LOGGER.warning(
                    "serving last successful snapshot cluster=%s age_seconds=%d",
                    cluster_name,
                    fresh["generated_at_epoch"] - stale["last_success_epoch"],
                )

            snapshot = dict(fresh)
            snapshot["clusters"] = merged_clusters
            snapshot["total_jobs"] = sum(item["job_count"] for item in merged_clusters)
            snapshot["stale_clusters"] = sum(
                1 for item in merged_clusters if item.get("stale", False)
            )
            self._snapshot = snapshot

        LOGGER.info(
            "collection cycle finished duration_seconds=%.2f ok=%d stale=%d jobs=%d",
            time.monotonic() - started,
            snapshot["ok_clusters"],
            snapshot["stale_clusters"],
            snapshot["total_jobs"],
        )
        return snapshot

    def snapshot(self) -> dict | None:
        with self._lock:
            return self._snapshot
