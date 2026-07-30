from __future__ import annotations

from pathlib import Path

import yaml


APP_ROOT = Path(__file__).resolve().parents[1]


def test_s6_init_is_enabled_and_allowed_by_apparmor() -> None:
    config = yaml.safe_load((APP_ROOT / "config.yaml").read_text(encoding="utf-8"))
    apparmor = (APP_ROOT / "apparmor.txt").read_text(encoding="utf-8")

    assert config["init"] is False
    assert "/init ix," in apparmor
    assert "/run/{s6,s6-rc*,service}/** ix," in apparmor
    assert "/usr/lib/bashio/** ix," in apparmor


def test_container_start_script_is_executable_in_image() -> None:
    dockerfile = (APP_ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert "RUN chmod 0755 /run.sh" in dockerfile
    assert 'CMD ["/run.sh"]' in dockerfile
