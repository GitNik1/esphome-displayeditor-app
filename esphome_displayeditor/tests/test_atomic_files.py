from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from backend.atomic_files import NEW_FILE_MODE, write_atomic
from backend.filesystem import FilesystemBackend
from backend.settings import Settings

POSIX_ONLY = pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_write_atomic_replaces_the_content_without_leftovers(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "file.yaml"
    write_atomic(target, b"one\n")
    write_atomic(target, b"two\n")

    assert target.read_bytes() == b"two\n"
    assert [p.name for p in target.parent.iterdir()] == ["file.yaml"]


def test_a_failed_write_keeps_the_old_file(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "file.yaml"
    target.write_bytes(b"old\n")

    def broken_replace(_source, _destination):
        raise OSError("disk full")

    monkeypatch.setattr("backend.atomic_files.os.replace", broken_replace)
    with pytest.raises(OSError):
        write_atomic(target, b"new\n")

    assert target.read_bytes() == b"old\n"
    assert [p.name for p in tmp_path.iterdir()] == ["file.yaml"]


@POSIX_ONLY
def test_write_atomic_keeps_the_mode_of_the_replaced_file(tmp_path: Path) -> None:
    target = tmp_path / "display.yaml"
    target.write_bytes(b"old\n")
    target.chmod(0o644)

    write_atomic(target, b"new\n")

    assert _mode(target) == 0o644


@POSIX_ONLY
def test_new_files_and_secrets_get_private_modes(tmp_path: Path) -> None:
    fresh = tmp_path / "fresh.json"
    secret = tmp_path / "secret.json"
    secret.write_bytes(b"{}")
    secret.chmod(0o644)

    write_atomic(fresh, b"{}")
    write_atomic(secret, b"{}", mode=0o600)

    assert _mode(fresh) == NEW_FILE_MODE
    assert _mode(secret) == 0o600


@POSIX_ONLY
def test_publishing_keeps_the_configuration_readable(tmp_path: Path) -> None:
    """Publishing used to leave the user's ESPHome YAML at mode 0600."""
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    active = config_root / "display.yaml"
    active.write_text("esphome:\n  name: display\n", encoding="utf-8")
    active.chmod(0o644)
    filesystem = FilesystemBackend(Settings(
        access_level="write", max_file_size=1024 * 1024, protect_sensitive_paths=True,
        config_root=config_root, data_root=tmp_path / "data", default_role="administrator",
    ))
    revision = filesystem.read_config("display.yaml")["revision"]
    filesystem.save_draft("display.yaml", "esphome:\n  name: published\n")

    filesystem.publish("display.yaml", revision)

    assert _mode(active) == 0o644
