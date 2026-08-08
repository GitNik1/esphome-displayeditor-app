from __future__ import annotations

import io
import zipfile
from pathlib import Path

from backend.designer_core.model import FontLibraryEntry, ImageLibraryEntry, Project, WidgetNode
from backend.filesystem import FilesystemBackend
from backend.lvgl_bundle import build_project_zip, collect_local_asset_paths
from backend.settings import Settings


def _filesystem(tmp_path: Path) -> FilesystemBackend:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    return FilesystemBackend(settings)


def test_collect_local_asset_paths_excludes_external_and_remote() -> None:
    project = Project()
    local = ImageLibraryEntry(id="local_icon")
    local.file_path = "images/local_icon.png"
    project.images.append(local)
    external = ImageLibraryEntry(id="imported_icon", external=True)
    external.file_path = "images/imported_icon.png"
    project.images.append(external)
    remote = ImageLibraryEntry(id="remote_icon")
    remote.file_path = "https://example.com/icon.png"
    project.images.append(remote)
    local_font = FontLibraryEntry(id="local_font", source_kind="file")
    local_font.file_path = "fonts/Custom.ttf"
    project.fonts.append(local_font)
    gfont = FontLibraryEntry(id="google_font", source_kind="gfonts")
    project.fonts.append(gfont)

    paths = collect_local_asset_paths(project)

    assert paths == ["images/local_icon.png", "fonts/Custom.ttf"]


def test_build_project_zip_bundles_yaml_and_local_assets(tmp_path: Path) -> None:
    filesystem = _filesystem(tmp_path)
    (filesystem.root / "images").mkdir()
    (filesystem.root / "images" / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\nfakepngdata")

    project = Project()
    image = ImageLibraryEntry(id="my_icon")
    image.file_path = "images/icon.png"
    project.images.append(image)
    project.widgets.append(WidgetNode(id="button_1", widget_type="button"))

    result = build_project_zip("lvgl:\n  widgets: []\n", project, filesystem)

    assert result.missing_assets == []
    with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
        names = archive.namelist()
        assert "ui.yaml" in names
        assert "images/icon.png" in names
        assert archive.read("ui.yaml") == b"lvgl:\n  widgets: []\n"
        assert archive.read("images/icon.png") == b"\x89PNG\r\n\x1a\nfakepngdata"


def test_build_project_zip_reports_a_missing_local_asset_without_failing(tmp_path: Path) -> None:
    filesystem = _filesystem(tmp_path)
    project = Project()
    image = ImageLibraryEntry(id="ghost_icon")
    image.file_path = "images/does_not_exist.png"
    project.images.append(image)

    result = build_project_zip("lvgl:\n  widgets: []\n", project, filesystem)

    assert result.missing_assets == ["images/does_not_exist.png"]
    with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
        assert archive.namelist() == ["ui.yaml"]
