from __future__ import annotations

from pathlib import Path

import yaml

from backend.version import APP_VERSION


APP_ROOT = Path(__file__).resolve().parents[1]


def test_container_starts_without_s6_overlay() -> None:
    """run.sh is PID 1 directly. Going through the base image's S6 `/init`
    fails under Supervisor's read-only container filesystem, because S6 needs
    a writable and executable /run to build its runtime state."""
    config = yaml.safe_load((APP_ROOT / "config.yaml").read_text(encoding="utf-8"))
    dockerfile = (APP_ROOT / "Dockerfile").read_text(encoding="utf-8")
    run_sh = (APP_ROOT / "run.sh").read_text(encoding="utf-8")

    assert config["init"] is False
    assert "ENTRYPOINT []" in dockerfile
    assert run_sh.startswith("#!/bin/sh")
    assert "with-contenv" not in run_sh
    assert "bashio" not in run_sh


def test_container_start_script_is_executable_in_image() -> None:
    dockerfile = (APP_ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert "RUN chmod 0755 /run.sh" in dockerfile
    assert 'CMD ["/run.sh"]' in dockerfile


def test_apparmor_allows_listing_the_app_directory() -> None:
    """/app is a sys.path entry, so Python scans the directory itself to find
    the `backend` package. `/app/** r,` alone covers only its contents and
    surfaces as a baffling ModuleNotFoundError."""
    apparmor = (APP_ROOT / "apparmor.txt").read_text(encoding="utf-8")

    assert "/app/ r," in apparmor
    assert "/app/** r," in apparmor


def test_app_remains_ingress_only_and_protected() -> None:
    config = yaml.safe_load((APP_ROOT / "config.yaml").read_text(encoding="utf-8"))

    assert config["ingress"] is True
    assert config["ports"] == {}
    assert config["apparmor"] is True
    assert config.get("host_network", False) is False
    assert config.get("full_access", False) is False
    assert config["options"]["default_role"] == "viewer"


def test_container_includes_native_api_and_websocket_runtimes() -> None:
    requirements = (APP_ROOT / "requirements.txt").read_text(encoding="utf-8")

    assert "aioesphomeapi" in requirements
    assert "websockets" in requirements


def test_release_version_is_consistent() -> None:
    config = yaml.safe_load((APP_ROOT / "config.yaml").read_text(encoding="utf-8"))
    changelog = (APP_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

    assert config["version"] == APP_VERSION
    assert f"## {APP_VERSION}\n" in changelog


def test_default_access_level_has_fail_closed_builder_options() -> None:
    config = yaml.safe_load((APP_ROOT / "config.yaml").read_text(encoding="utf-8"))

    assert config["options"]["access_level"] != "write_with_builder"
    assert "write_with_builder" in config["schema"]["access_level"]
