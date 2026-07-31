"""Format version 2: the fields an imported ESPHome config needs.

These cover the model round trip and the exporter behaviour that the importer
(S2) will rely on, so a regression here surfaces before it looks like an
importer bug.
"""

from __future__ import annotations

import yaml

from backend.designer_core.model import (
    PROJECT_FORMAT_VERSION,
    STATES_KEY,
    ImageLibraryEntry,
    Project,
    WidgetNode,
)
from backend.designer_core.yamlexport import export_project


def _export(project: Project, tmp_path) -> dict:
    result = export_project(project, str(tmp_path / "ui.yaml"))
    return yaml.safe_load(result.yaml_text)


def _widget(**kwargs) -> WidgetNode:
    node = WidgetNode(id=kwargs.pop("id", "w1"), widget_type=kwargs.pop("widget_type", "obj"))
    for key, value in kwargs.items():
        setattr(node, key, value)
    return node


# --- model round trip -------------------------------------------------------

def test_new_widget_fields_survive_a_round_trip() -> None:
    node = _widget(
        layout={"type": "GRID", "grid_rows": [40, "FR(1)", "CONTENT"]},
        grid_cell={"row_pos": 1, "column_pos": 2, "x_align": "CENTER"},
        extra={"multiple_widgets_per_cell": True},
        source="imported",
        synthetic_id=True,
    )

    restored = WidgetNode.from_dict(node.to_dict())

    assert restored.layout == {"type": "GRID", "grid_rows": [40, "FR(1)", "CONTENT"]}
    assert restored.grid_cell == {"row_pos": 1, "column_pos": 2, "x_align": "CENTER"}
    assert restored.extra == {"multiple_widgets_per_cell": True}
    assert restored.source == "imported"
    assert restored.synthetic_id is True


def test_new_project_fields_survive_a_round_trip() -> None:
    project = Project()
    project.theme = {"button": {"bg_color": "272D36"}}
    project.extra_lvgl = {"pages": [{"id": "page_1"}]}
    project.canvas_source = "display_model"
    project.export_sections = ["lvgl"]
    project.import_source = {"name": "p4-86-panel.yaml"}

    restored = Project.from_dict(project.to_dict())

    assert restored.theme == {"button": {"bg_color": "272D36"}}
    assert restored.extra_lvgl == {"pages": [{"id": "page_1"}]}
    assert restored.canvas_source == "display_model"
    assert restored.export_sections == ["lvgl"]
    assert restored.import_source == {"name": "p4-86-panel.yaml"}


def test_version_1_projects_still_load_and_are_upgraded() -> None:
    """Only *newer* versions are refused; existing saves must keep working."""
    old = {"format_version": 1, "canvas": {"width": 320, "height": 240}, "widgets": []}

    project = Project.from_dict(old)

    assert project.canvas_width == 320
    assert project.to_dict()["format_version"] == PROJECT_FORMAT_VERSION


def test_version_1_layout_style_props_migrate_into_layout() -> None:
    """v1 stored these as flat style keys, which ESPHome never accepted."""
    old = _widget(style_tree={"layout_type": "FLEX", "flex_flow": "COLUMN",
                              "bg_color": "101318"}).to_dict()
    old.pop("layout")

    node = WidgetNode.from_dict(old)

    assert node.layout == {"type": "FLEX", "flex_flow": "COLUMN"}
    assert node.style_tree == {"bg_color": "101318"}, "style keys must not be swallowed"


def test_migration_leaves_a_plain_widget_without_a_layout() -> None:
    """layout_type defaulted to NONE, so migrating it verbatim would give
    every untouched v1 widget a layout mapping it never had."""
    old = _widget(style_tree={"layout_type": "NONE", "bg_color": "101318"}).to_dict()
    old.pop("layout")

    assert WidgetNode.from_dict(old).layout == {}


# --- exporter ---------------------------------------------------------------

def test_layout_and_grid_cell_are_emitted_the_way_esphome_nests_them(tmp_path) -> None:
    project = Project()
    project.widgets = [_widget(
        layout={"type": "GRID", "grid_rows": [40, "FR(1)"]},
        grid_cell={"row_pos": 1, "column_pos": 2, "row_span": 2},
    )]

    body = _export(project, tmp_path)["lvgl"]["widgets"][0]["obj"]

    assert body["layout"] == {"type": "GRID", "grid_rows": [40, "FR(1)"]}
    assert body["grid_cell_row_pos"] == 1
    assert body["grid_cell_column_pos"] == 2
    assert body["grid_cell_row_span"] == 2


def test_named_style_and_inline_overrides_are_both_emitted(tmp_path) -> None:
    """Hand-written configs routinely set `styles:` and override individual
    properties on top; treating them as exclusive dropped the overrides."""
    project = Project()
    project.widgets = [_widget(
        style_mode="named", style_refs=["base"], style_tree={"bg_color": "FF0000"},
    )]

    body = _export(project, tmp_path)["lvgl"]["widgets"][0]["obj"]

    assert body["styles"] == "base"
    assert body["bg_color"] == 0xFF0000


def test_state_styles_are_flattened_back_alongside_parts(tmp_path) -> None:
    project = Project()
    project.widgets = [_widget(widget_type="slider", style_tree={
        "bg_color": "101318",
        "knob": {"bg_color": "FFFFFF"},
        STATES_KEY: {"pressed": {"bg_color": "3A4552"}},
    })]

    body = _export(project, tmp_path)["lvgl"]["widgets"][0]["slider"]

    assert body["pressed"] == {"bg_color": 0x3A4552}
    assert body["knob"] == {"bg_color": 0xFFFFFF}
    assert STATES_KEY not in body


def test_unmodelled_keys_are_written_back_unchanged(tmp_path) -> None:
    project = Project()
    project.widgets = [_widget(extra={"bg_image_tiled": True, "scroll_dir": "VER"})]

    body = _export(project, tmp_path)["lvgl"]["widgets"][0]["obj"]

    assert body["bg_image_tiled"] is True
    assert body["scroll_dir"] == "VER"


def test_passthrough_never_overwrites_an_edited_value(tmp_path) -> None:
    project = Project()
    project.widgets = [_widget(width=200, extra={"width": 999})]

    result = export_project(project, str(tmp_path / "ui.yaml"))
    body = yaml.safe_load(result.yaml_text)["lvgl"]["widgets"][0]["obj"]

    assert body["width"] == 200
    assert any(i.severity == "C" and "width" in i.message for i in result.issues)


def test_unknown_widget_type_is_fatal_only_for_editor_nodes(tmp_path) -> None:
    imported = Project()
    imported.widgets = [_widget(widget_type="animimg_future", source="imported")]

    result = export_project(imported, str(tmp_path / "ui.yaml"))

    assert "animimg_future" in yaml.safe_load(result.yaml_text)["lvgl"]["widgets"][0]
    assert any(i.severity == "B" for i in result.issues)


def test_theme_block_is_emitted_inside_lvgl(tmp_path) -> None:
    project = Project()
    project.theme = {"button": {"bg_color": "272D36",
                                STATES_KEY: {"pressed": {"bg_color": "3A4552"}}}}

    theme = _export(project, tmp_path)["lvgl"]["theme"]

    assert theme["button"]["bg_color"] == 0x272D36
    assert theme["button"]["pressed"] == {"bg_color": 0x3A4552}


def test_export_sections_can_restrict_the_output_to_lvgl(tmp_path) -> None:
    """An imported project must not redefine the source config's assets -
    every id would collide."""
    project = Project()
    project.images = [ImageLibraryEntry(id="img_a", file_path="images/a.png", external=True)]
    project.export_sections = ["lvgl"]

    doc = _export(project, tmp_path)

    assert "image" not in doc
    assert "lvgl" in doc


def test_external_assets_keep_their_path_and_are_not_copied(tmp_path) -> None:
    project = Project()
    project.images = [ImageLibraryEntry(
        id="img_a", file_path="images/a.png", external=True, extra={"type": "RGB565"})]

    result = export_project(project, str(tmp_path / "ui.yaml"))
    entry = yaml.safe_load(result.yaml_text)["image"][0]

    assert entry["file"] == "images/a.png", "an external path must not be rewritten"
    assert entry["type"] == "RGB565"
    assert result.assets_copied == []
    assert not (tmp_path / "assets").exists()
