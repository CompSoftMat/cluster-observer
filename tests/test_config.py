from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path

from cluster_observer.config import load_config


class ConfigTests(unittest.TestCase):
    def test_loads_named_filter_groups(self) -> None:
        config_text = textwrap.dedent(
            """
            [server]
            dashboard_title = "Test"

            [[clusters]]
            name = "gaas"
            host = "gaas.example"
            user = "alice"

            [clusters.filter_groups.project]
            project = ["abc"]

            [clusters.filter_groups.free_queue]
            queue = ["gpu_free"]
            """
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "config.toml"
            path.write_text(config_text)
            config = load_config(str(path))

        self.assertEqual(config.dashboard_title, "Test")
        self.assertEqual(
            config.clusters[0].filter_groups,
            {
                "project": {"project": ("abc",)},
                "free_queue": {"queue": ("gpu_free",)},
            },
        )

    def test_legacy_project_maps_to_default_group(self) -> None:
        config_text = textwrap.dedent(
            """
            [[clusters]]
            name = "wildfly"
            host = "wildfly.example"
            user = "alice"
            project = "legacy-project"
            """
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "config.toml"
            path.write_text(config_text)
            config = load_config(str(path))

        self.assertEqual(
            config.clusters[0].filter_groups,
            {"matching jobs": {"project": ("legacy-project",)}},
        )
