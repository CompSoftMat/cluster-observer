from __future__ import annotations

from argparse import ArgumentParser
import json
import logging
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files

from cluster_observer.config import AppConfig, load_config
from cluster_observer.collector import SnapshotCollector


STATIC_FILES = files("cluster_observer").joinpath("static")
LOGGER = logging.getLogger(__name__)


def _read_static_file(name: str) -> bytes:
    return STATIC_FILES.joinpath(name).read_bytes()


class DashboardHandler(BaseHTTPRequestHandler):
    collector: SnapshotCollector

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            self._send_bytes(_read_static_file("index.html"), "text/html; charset=utf-8")
            return
        if self.path == "/static/style.css":
            self._send_bytes(_read_static_file("style.css"), "text/css; charset=utf-8")
            return
        if self.path == "/static/app.js":
            self._send_bytes(_read_static_file("app.js"), "application/javascript; charset=utf-8")
            return
        if self.path == "/api/jobs":
            payload = self.collector.snapshot()
            if payload is None:
                self._send_bytes(
                    json.dumps({"error": "initial collection is not ready"}).encode("utf-8"),
                    "application/json; charset=utf-8",
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            self._send_bytes(
                json.dumps(payload).encode("utf-8"),
                "application/json; charset=utf-8",
            )
            return
        self.send_error(HTTPStatus.NOT_FOUND, "not found")

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        LOGGER.info("http client=%s %s", self.client_address[0], format % args)

    def _send_bytes(
        self,
        payload: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(description="Cluster observer dashboard")
    parser.add_argument("--config", help="Path to TOML config file")
    parser.add_argument("--host", help="Override server bind host")
    parser.add_argument("--port", type=int, help="Override server bind port")
    parser.add_argument(
        "--log-level",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        default="INFO",
        help="Logging verbosity (default: INFO)",
    )
    return parser


def _override_config(config: AppConfig, host: str | None, port: int | None) -> AppConfig:
    return AppConfig(
        dashboard_title=config.dashboard_title,
        host=host or config.host,
        port=port or config.port,
        refresh_seconds=config.refresh_seconds,
        request_timeout_seconds=config.request_timeout_seconds,
        clusters=config.clusters,
        user_aliases=config.user_aliases,
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    config = _override_config(load_config(args.config), args.host, args.port)

    collector = SnapshotCollector(config)
    LOGGER.info("performing initial collection before accepting requests")
    collector.refresh()
    collector.start()
    DashboardHandler.collector = collector
    server = ThreadingHTTPServer((config.host, config.port), DashboardHandler)
    LOGGER.info("cluster-observer listening on http://%s:%d", config.host, config.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        collector.stop()
    return 0
