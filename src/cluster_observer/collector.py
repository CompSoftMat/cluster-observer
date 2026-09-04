from __future__ import annotations

import logging
from threading import Event, Lock, Thread
import time

from cluster_observer.config import AppConfig
from cluster_observer.qstat import collect_all_clusters


LOGGER = logging.getLogger(__name__)


class SnapshotCollector:
    """Collect scheduler state independently of dashboard requests."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self._snapshot: dict | None = None
        self._last_success: dict[str, dict] = {}
        self._lock = Lock()
        self._stop = Event()
        self._thread: Thread | None = None

    def refresh(self) -> dict:
        started = time.monotonic()
        LOGGER.info("collection cycle started clusters=%d", len(self.config.clusters))
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

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(
            target=self._run,
            name="cluster-observer-collector",
            daemon=True,
        )
        self._thread.start()
        LOGGER.info("background collector started interval_seconds=%d", self.config.refresh_seconds)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        LOGGER.info("background collector stopped")

    def _run(self) -> None:
        while not self._stop.wait(self.config.refresh_seconds):
            try:
                self.refresh()
            except Exception:
                # A bad cycle must not kill future refreshes or discard the cache.
                LOGGER.exception("collection cycle failed unexpectedly; keeping cached snapshot")
