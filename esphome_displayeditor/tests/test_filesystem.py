from __future__ import annotations

from pathlib import Path

import pytest

from backend.errors import ApiError
from backend.filesystem import FilesystemBackend, revision_for
from backend.settings import Settings


def make_backend(tmp_path: Path, *, read_only: bool = False) -> FilesystemBackend:
    config_root = tmp_path / "homeassistant" / "esphome"
    config_root.mkdir(parents=True)
    data_root = tmp_path / "data"
    settings = Settings(
        access_level="read" if read_only else "write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=data_root,
    )
    return FilesystemBackend(settings)


def test_list_read_and_hide_secrets(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    (backend.root / "living-room.yaml").write_text("esphome:\n  name: living-room\n", encoding="utf-8", newline="")
    (backend.root / "secrets.yaml").write_text("password: secret\n", encoding="utf-8", newline="")

    listed = backend.list_configs()

    assert [item["name"] for item in listed] == ["living-room.yaml"]
    document = backend.read_config("living-room.yaml")
    assert document["revision"] == revision_for(document["content"])
    with pytest.raises(ApiError, match="protected"):
        backend.read_config("secrets.yaml")


def test_list_configs_excludes_subfolders(tmp_path: Path) -> None:
    """Only top-level YAML files are listed - not files in subfolders like
    ``archive/`` (ESPHome's own dashboard archives deleted/renamed devices
    there), so old/inactive configs don't clutter the import picker."""
    backend = make_backend(tmp_path)
    (backend.root / "living-room.yaml").write_text("esphome:\n  name: living-room\n", encoding="utf-8", newline="")
    archive = backend.root / "archive"
    archive.mkdir()
    (archive / "old-device.yaml").write_text("esphome:\n  name: old-device\n", encoding="utf-8", newline="")

    listed = backend.list_configs()

    assert [item["name"] for item in listed] == ["living-room.yaml"]
    # The subfolder file is still readable directly - only the listing is narrowed.
    document = backend.read_config("archive/old-device.yaml")
    assert "old-device" in document["content"]


@pytest.mark.parametrize(
    "name",
    ["../configuration.yaml", "/etc/passwd.yaml", "folder\\file.yaml", ".hidden.yaml", "file.txt"],
)
def test_rejects_unsafe_paths(tmp_path: Path, name: str) -> None:
    backend = make_backend(tmp_path)
    with pytest.raises(ApiError) as raised:
        backend.read_config(name)
    assert raised.value.error == "invalid_path"


def test_rejects_symlink(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    outside = tmp_path / "outside.yaml"
    outside.write_text("secret: value\n", encoding="utf-8", newline="")
    link = backend.root / "linked.yaml"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Symbolic links are unavailable on this platform")
    with pytest.raises(ApiError) as raised:
        backend.read_config("linked.yaml")
    assert raised.value.error == "invalid_path"


def test_draft_diff_yaml_and_publish(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    active = "esphome:\n  name: display\napi:\n  encryption:\n    key: !secret api_key\n"
    changed = "esphome:\n  name: display-new\napi:\n  encryption:\n    key: !secret api_key\n"
    (backend.root / "display.yaml").write_text(active, encoding="utf-8", newline="")

    saved = backend.save_draft("display.yaml", changed)
    assert saved["revision"] == revision_for(changed)
    assert "+  name: display-new" in backend.diff("display.yaml")["diff"]
    assert backend.check_yaml("display.yaml")["valid"] is True

    result = backend.publish("display.yaml", revision_for(active))
    assert result["revision"] == revision_for(changed)
    assert (backend.root / "display.yaml").read_text(encoding="utf-8") == changed
    assert not (backend.drafts / "display.yaml").exists()


def test_publish_detects_revision_conflict(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    path = backend.root / "display.yaml"
    path.write_text("value: one\n", encoding="utf-8", newline="")
    original_revision = revision_for(path.read_text(encoding="utf-8"))
    backend.save_draft("display.yaml", "value: draft\n")
    path.write_text("value: changed-elsewhere\n", encoding="utf-8", newline="")

    with pytest.raises(ApiError) as raised:
        backend.publish("display.yaml", original_revision)
    assert raised.value.error == "revision_conflict"
    assert raised.value.status_code == 409
    assert path.read_text(encoding="utf-8") == "value: changed-elsewhere\n"


def test_publish_rejects_invalid_and_duplicate_yaml(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    path = backend.root / "display.yaml"
    active = "esphome:\n  name: display\n"
    path.write_text(active, encoding="utf-8", newline="")

    for invalid in ("esphome: [\n", "esphome:\n  name: one\n  name: two\n"):
        backend.save_draft("display.yaml", invalid)
        assert backend.check_yaml("display.yaml")["valid"] is False
        with pytest.raises(ApiError) as raised:
            backend.publish("display.yaml", revision_for(active))
        assert raised.value.error == "invalid_yaml"
        assert path.read_text(encoding="utf-8") == active


def test_interrupted_atomic_draft_and_publish_preserve_previous_files(
    tmp_path: Path, monkeypatch
) -> None:
    backend = make_backend(tmp_path)
    active_path = backend.root / "display.yaml"
    active = "esphome:\n  name: active\n"
    old_draft = "esphome:\n  name: old-draft\n"
    new_draft = "esphome:\n  name: new-draft\n"
    active_path.write_text(active, encoding="utf-8", newline="")
    backend.save_draft("display.yaml", old_draft)

    def interrupted_replace(_source, _target) -> None:
        raise OSError("simulated interrupted atomic replace")

    monkeypatch.setattr("backend.filesystem.os.replace", interrupted_replace)
    with pytest.raises(OSError, match="interrupted"):
        backend.save_draft("display.yaml", new_draft)
    assert backend.read_draft("display.yaml")["content"] == old_draft
    assert not list(backend.drafts.glob(".display.yaml.*.tmp"))

    with pytest.raises(OSError, match="interrupted"):
        backend.publish("display.yaml", revision_for(active))
    assert active_path.read_text(encoding="utf-8") == active
    assert backend.read_draft("display.yaml")["content"] == old_draft
    assert not list(backend.root.glob(".display.yaml.*.tmp"))


def test_protected_directories_are_read_only(tmp_path: Path) -> None:
    backend = make_backend(tmp_path)
    package_dir = backend.root / "packages"
    package_dir.mkdir()
    (package_dir / "common.yaml").write_text("logger:\n", encoding="utf-8", newline="")
    assert backend.read_config("packages/common.yaml")["content"] == "logger:\n"
    with pytest.raises(ApiError) as raised:
        backend.save_draft("packages/common.yaml", "logger:\n  level: DEBUG\n")
    assert raised.value.error == "permission_denied"
