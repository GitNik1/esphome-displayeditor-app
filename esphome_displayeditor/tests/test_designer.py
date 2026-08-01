from __future__ import annotations

from pathlib import Path

import pytest
import yaml

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
    assert {"bar", "arc"} <= keys
    assert "chart" not in keys


def test_addon_bar_and_arc_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "load_bar", "widget_type": "bar", "x": 10, "y": 10,
            "width": 180, "height": 24,
            "properties": {
                "value": 65, "start_value": 20, "min_value": 0,
                "max_value": 100, "mode": "RANGE", "animated": True,
            },
            "style_tree": {"indicator": {"bg_color": "20C7B7"}}, "children": [],
        },
        {
            "id": "temperature_arc", "widget_type": "arc", "x": 20, "y": 60,
            "width": 120, "height": 120,
            "properties": {
                "value": 42, "min_value": -20, "max_value": 80,
                "start_angle": 135, "end_angle": 45, "rotation": 0,
                "adjustable": True, "change_rate": 720,
            },
            "style_tree": {
                "arc_color": "445566", "arc_width": 10,
                "indicator": {"arc_color": "20C7B7", "arc_width": 12},
            },
            "children": [],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "bar:" in exported and "arc:" in exported
    assert "start_value: 20" in exported
    assert "adjustable: true" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    widgets = {item["id"]: item for item in imported["project"]["widgets"]}
    assert widgets["load_bar"]["properties"]["mode"] == "RANGE"
    assert widgets["temperature_arc"]["properties"]["value"] == 42


def test_project_exports_esphome_yaml(tmp_path: Path) -> None:
    result = DesignerService(tmp_path).export_yaml(project_with_button())
    assert "lvgl:" in result["yaml"]
    assert "button_1" in result["yaml"]
    assert "0x20C7B7" in result["yaml"]


def test_legacy_button_text_with_children_is_exported_as_child_label(tmp_path: Path) -> None:
    project = project_with_button()
    project["widgets"][0]["properties"]["checkable"] = True
    project["widgets"][0]["children"] = [{
        "id": "picture",
        "widget_type": "image",
        "width": 64,
        "height": 64,
        "properties": {"src": "button_normal"},
        "children": [],
    }]

    result = DesignerService(tmp_path).export_yaml(project)

    button = yaml.safe_load(result["yaml"])["lvgl"]["widgets"][0]["button"]
    assert "text" not in button
    assert button["widgets"] == [
        {"image": {"id": "picture", "width": 64, "height": 64, "src": "button_normal"}},
        {"label": {"align": "CENTER", "text": "Light"}},
    ]
    assert any(
        issue["severity"] == "C"
        and issue["widget_id"] == "button_1"
        and "child label" in issue["message"]
        for issue in result["issues"]
    )
    # The compatibility guard must not mutate the saved project payload.
    assert project["widgets"][0]["properties"]["text"] == "Light"


def test_font_glyphs_are_auto_collected_from_widget_text(tmp_path: Path) -> None:
    """`glyphs:` is no longer manually curated in the Font Library editor -
    the exporter must derive it from what widgets actually display, unioned
    with anything an imported YAML already restricted it to (never narrowed
    automatically)."""
    project = project_with_button()
    project["fonts"] = [
        {
            "id": "icons_mdi", "source_kind": "web",
            "web_url": "https://example.invalid/materialdesignicons-webfont.ttf",
            "size": 24, "bpp": 4, "glyphs": ["A"],
        },
    ]
    project["widgets"] = [
        {
            "id": "label_1", "widget_type": "label", "x": 0, "y": 0,
            "width": 40, "height": 20,
            "properties": {"text": "Hi"},
            "style_tree": {"text_font": "icons_mdi"},
            "children": [],
        },
        {
            "id": "label_2", "widget_type": "label", "x": 0, "y": 30,
            "width": 40, "height": 20,
            "properties": {"text": "!"},
            "style_tree": {"text_font": "icons_mdi"},
            "children": [],
        },
    ]
    exported = DesignerService(tmp_path).export_yaml(project)["yaml"]
    glyphs_block = exported.split("glyphs:", 1)[1].split("lvgl:", 1)[0]
    # The pre-existing "A" (from an imported config) plus every character
    # actually typed into the two labels' text - nothing lost, nothing missing.
    for char in ("A", "H", "i", "!"):
        assert char in glyphs_block


def test_font_glyphs_follow_theme_default_font(tmp_path: Path) -> None:
    """A widget with no explicit ``text_font`` still contributes its
    characters to whichever font the theme (or project default) assigns it,
    matching ESPHome's own style precedence - here the MDI font, the only
    one glyph automation applies to."""
    project = project_with_button()
    project["fonts"] = [
        {
            "id": "icons_mdi", "source_kind": "web",
            "web_url": "https://example.invalid/materialdesignicons-webfont.ttf",
            "size": 16, "bpp": 4,
        },
    ]
    project["theme"] = {"label": {"text_font": "icons_mdi"}}
    project["widgets"] = [
        {
            "id": "label_1", "widget_type": "label", "x": 0, "y": 0,
            "width": 40, "height": 20,
            "properties": {"text": "Zw"},
            "style_tree": {},
            "children": [],
        },
    ]
    exported = DesignerService(tmp_path).export_yaml(project)["yaml"]
    glyphs_block = exported.split("glyphs:", 1)[1].split("lvgl:", 1)[0]
    assert "Z" in glyphs_block and "w" in glyphs_block


def test_non_mdi_fonts_are_never_glyph_restricted(tmp_path: Path) -> None:
    """Glyph automation is scoped to the MDI icon font only - every other
    library font (Google Fonts, a plain uploaded/linked TTF, ...) must
    always export complete, even if it already carried an explicit
    ``glyphs:`` restriction from an imported YAML and is heavily used in
    static widget text. Restricting an ordinary text font is exactly the
    risk this scoping exists to avoid."""
    project = project_with_button()
    project["fonts"] = [
        {
            "id": "body_font", "source_kind": "gfonts",
            "gfonts_family": "Roboto", "size": 16, "bpp": 4,
            "glyphs": ["A"],  # a pre-existing restriction from an import
        },
    ]
    project["widgets"] = [
        {
            "id": "label_1", "widget_type": "label", "x": 0, "y": 0,
            "width": 40, "height": 20,
            "properties": {"text": "Hello"},
            "style_tree": {"text_font": "body_font"},
            "children": [],
        },
    ]
    exported = DesignerService(tmp_path).export_yaml(project)["yaml"]
    font_block = exported.split("font:", 1)[1].split("lvgl:", 1)[0]
    assert "glyphs" not in font_block


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


def test_confined_asset_folder_paths_pass_validation(tmp_path: Path) -> None:
    """A non-external local path normally fails validation (see
    test_local_asset_paths_are_blocked), but a path inside the add-on's own
    images/fonts asset folders is exactly what write_image_asset/
    write_font_asset (manual upload, the MDI webfont quick-add) confine
    themselves to - validation must not treat that the same as an arbitrary
    host path a user typed by hand. (Actually copying the image file at
    export time is a separate concern with its own file-existence check;
    this test isolates the validation rule itself.)"""
    project = project_with_button()
    project["images"] = [{"id": "logo", "file_path": "images/logo.png"}]
    project["fonts"] = [
        {"id": "icons_mdi", "source_kind": "file", "file_path": "fonts/icons_mdi-abc123.ttf", "size": 24, "bpp": 4},
    ]
    _parsed, issues = DesignerService(tmp_path).validate(project)
    assert not any(issue["severity"] == "error" for issue in issues)


def test_confined_asset_path_traversal_still_fails_validation(tmp_path: Path) -> None:
    project = project_with_button()
    project["images"] = [{"id": "logo", "file_path": "images/../../etc/passwd"}]
    _parsed, issues = DesignerService(tmp_path).validate(project)
    assert any(issue["severity"] == "error" for issue in issues)
