from __future__ import annotations

from pathlib import Path

import pytest

from backend.designer import DesignerService
from backend.errors import ApiError


def project_with_button() -> dict:
    return {
        "format": "esphome-lvgl-designer-project",
        "format_version": 1,
        "canvas": {"width": 480, "height": 320},
        "background": {},
        "display_id_placeholder": "my_display",
        "widgets": [
            {
                "id": "button_1",
                "widget_type": "button",
                "x": 12,
                "y": 24,
                "width": 120,
                "height": 50,
                "properties": {"text": "Light"},
                "style_tree": {"bg_color": "20C7B7"},
                "children": [],
            }
        ],
        "styles": [],
        "fonts": [],
        "images": [],
        "colors": [],
    }


def test_schema_exposes_desktop_widget_set(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    schemas = service.schemas("de")
    keys = {widget["type_key"] for widget in schemas["widgets"]}
    assert {"obj", "container", "label", "button", "switch", "slider", "image"} <= keys
    assert "chart" not in keys


def test_project_exports_esphome_yaml(tmp_path: Path) -> None:
    result = DesignerService(tmp_path).export_yaml(project_with_button())
    assert "lvgl:" in result["yaml"]
    assert "button_1" in result["yaml"]
    assert "0x20C7B7" in result["yaml"]


def test_duplicate_ids_fail_validation(tmp_path: Path) -> None:
    project = project_with_button()
    project["widgets"].append(dict(project["widgets"][0]))
    _parsed, issues = DesignerService(tmp_path).validate(project)
    assert any("Duplicate id" in issue["message"] for issue in issues)


def test_local_asset_paths_are_blocked(tmp_path: Path) -> None:
    project = project_with_button()
    project["images"] = [{"id": "logo", "file_path": "/etc/passwd"}]
    with pytest.raises(ApiError) as raised:
        DesignerService(tmp_path).export_yaml(project)
    assert raised.value.error == "invalid_project"


def test_external_asset_paths_are_allowed(tmp_path: Path) -> None:
    """Assets belonging to the ESPHome config a project was imported from are
    only ever written back out as text - the add-on never opens them - so the
    rule above must not apply. Without this, importing any real config would
    produce a project that can be neither saved nor exported."""
    project = project_with_button()
    project["images"] = [
        {"id": "logo", "file_path": "images/logo.png", "external": True}
    ]

    result = DesignerService(tmp_path).export_yaml(project)

    assert "images/logo.png" in result["yaml"]


def test_external_flag_does_not_whitelist_editor_assets(tmp_path: Path) -> None:
    project = project_with_button()
    project["images"] = [
        {"id": "logo", "file_path": "/etc/passwd", "external": False}
    ]

    with pytest.raises(ApiError):
        DesignerService(tmp_path).export_yaml(project)

