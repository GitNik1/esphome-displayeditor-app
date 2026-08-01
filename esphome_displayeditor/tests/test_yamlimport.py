"""Importing a real, hand-written ESPHome config.

The fixture is an excerpt of a 1048-line device config (the display, font,
image and lvgl blocks of p4-86-panel.yaml). It is deliberately not a file this
designer produced: it uses grid layout, per-state styles, a theme, automations
and a widget type with no editor support, which is exactly the surface an
importer has to survive.

No test here reads from the Home Assistant host.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
import yaml

from backend.designer_core.model import STATES_KEY, Project
from backend.designer_core.yamlexport import build_font_block, export_project
from backend.designer_core.yamlimport import (
    LvglImportError,
    import_esphome_yaml,
    load_lvgl_yaml,
    probe_esphome_yaml,
)

FIXTURE = Path(__file__).parent / "data" / "p4_86_panel.yaml"


@pytest.fixture(scope="module")
def source_text() -> str:
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def imported(source_text: str):
    return import_esphome_yaml(source_text, source_name="p4-86-panel.yaml")


def _all(project: Project):
    return list(project.all_widgets())


def _walk_colors(tree: dict, prefix: str = "") -> list[str]:
    """Every *_color key whose value is still an int - i.e. was not converted
    back from the ``0xRRGGBB`` an unquoted YAML scalar decays into."""
    bad = []
    for key, value in tree.items():
        if isinstance(value, dict):
            bad += _walk_colors(value, f"{prefix}{key}.")
        elif key.endswith("_color") and isinstance(value, int) and not isinstance(value, bool):
            bad.append(f"{prefix}{key}")
    return bad


# --- structure --------------------------------------------------------------

def test_the_whole_widget_tree_is_imported(imported) -> None:
    counts: dict[str, int] = {}
    for node in _all(imported.project):
        counts[node.widget_type] = counts.get(node.widget_type, 0) + 1

    assert counts == {"obj": 11, "button": 6, "label": 13, "animimg": 1}


def test_grid_placement_lands_on_the_child_and_defaults_on_the_container(imported) -> None:
    """``grid_cell_*`` means two different things depending on where it sits:
    on a widget it places that widget, inside a ``layout:`` block it is the
    container's default for all its cells."""
    nodes = _all(imported.project)
    placements = sum(len(n.grid_cell) for n in nodes)
    container_defaults = sum(
        1 for n in nodes for k in n.layout if k.startswith("grid_cell_")
    )

    assert placements == 40
    assert container_defaults == 5


def test_grid_tracks_keep_their_written_form(imported) -> None:
    """FR(1) and CONTENT are not numbers; parsing them here would lose the
    distinction the layout engine needs."""
    status_bar = imported.project.find_widget("status_bar")

    assert status_bar.layout["type"] == "GRID"
    assert status_bar.layout["grid_rows"] == ["FR(1)"]
    assert status_bar.layout["grid_columns"] == [200, "FR(1)", 200]
    # A grid_cell_* key inside layout: is the container's default for its
    # cells, not a placement of the container itself.
    assert status_bar.layout["grid_cell_y_align"] == "CENTER"
    assert "grid_cell_y_align" not in status_bar.grid_cell


def test_flex_layout_is_imported_as_a_mapping(imported) -> None:
    left_menu = imported.project.find_widget("left_menu")

    assert left_menu.layout == {
        "type": "FLEX", "flex_flow": "COLUMN",
        "flex_align_main": "START", "flex_align_cross": "STRETCH",
        "flex_align_track": "START",
    }


def test_the_screens_own_grid_belongs_to_the_lvgl_block(imported) -> None:
    """The root grid here is declared on ``lvgl:`` itself, not on a widget -
    it lays out the top-level widgets. Nothing in the model represents the
    screen, so it is preserved rather than attributed to a widget."""
    screen_layout = imported.project.extra_lvgl["layout"]

    assert screen_layout["type"] == "GRID"
    assert screen_layout["grid_columns"] == [80, 560, 80]
    assert screen_layout["grid_rows"] == [40, 680]


def test_automations_are_preserved_verbatim(imported) -> None:
    with_events = [n for n in _all(imported.project) if n.events]

    assert len(with_events) == 6
    actions = imported.project.find_widget("button_home").events["on_click"]
    assert actions[0]["lvgl.widget.hide"] == [
        "content_home", "content_light", "content_climate",
        "content_info", "content_setup", "content_power",
    ]


def test_state_styles_are_nested_under_the_reserved_key(imported) -> None:
    node = imported.project.find_widget("button_power")

    assert node.style_tree[STATES_KEY]["pressed"]["bg_color"] == "B84242"


def test_theme_block_is_imported(imported) -> None:
    theme = imported.project.theme

    assert theme["button"]["radius"] == 8
    assert theme["button"][STATES_KEY]["pressed"]["bg_color"] == "3A4552"


@pytest.mark.parametrize("literal, expected", [
    ("500ms", 500),
    ("1s", 1000),
    ("2min", 120_000),
    ("1h", 3_600_000),
    ("1.5s", 1500),
])
def test_normalise_duration_parses_time_literals(literal: str, expected) -> None:
    from backend.designer_core.yamlimport import _normalise_duration
    assert _normalise_duration(literal) == expected


@pytest.mark.parametrize("value", [500, "forever", "not_a_duration", None])
def test_normalise_duration_leaves_non_time_literals_alone(value) -> None:
    from backend.designer_core.yamlimport import _normalise_duration
    assert _normalise_duration(value) == value


def test_duration_time_literal_is_converted_to_milliseconds(imported) -> None:
    """``duration: 500ms`` is a plain string to any YAML parser - ESPHome's
    own time-literal shorthand, not a bare number. Left as a string, anything
    expecting a number (a numeric property-panel input, a future validator)
    would misbehave."""
    node = imported.project.find_widget("sprinterbg_linie1_anim")

    assert node.properties["duration"] == 500


def test_web_font_reexports_its_preserved_file_level_keys(imported) -> None:
    """`icons_44`'s `file: {type: web, url: ..., refresh: never}` has one
    key (`refresh`) with no modeled field - it's stashed in extra["file"] on
    import specifically so export can restore it, per model.py's own "kept
    verbatim" comment. build_font_block's dict-merge used to skip it: `file`
    was already a top-level key of the built entry, so the generic
    extra-merge (`k not in entry`) never looked inside it."""
    block = build_font_block(imported.project)
    icons = next(entry for entry in block if entry["id"] == "icons_44")

    assert icons["file"] == {
        "type": "web",
        "url": "https://github.com/Templarian/MaterialDesign-Webfont/raw/master/fonts/materialdesignicons-webfont.ttf",
        "refresh": "never",
    }


def test_colors_are_converted_back_from_integers(imported) -> None:
    """An unquoted ``0x101318`` is just an int to any YAML parser. Left alone,
    every imported colour would be wrong."""
    offenders = [
        f"{node.id}:{key}"
        for node in _all(imported.project)
        for key in _walk_colors(node.style_tree)
    ]
    offenders += [f"theme.{k}:{c}" for k, t in imported.project.theme.items()
                  for c in _walk_colors(t)]

    assert offenders == []
    assert imported.project.find_widget("left_menu").style_tree["bg_color"] == "181D23"


def test_percentage_sizes_stay_strings(imported) -> None:
    node = imported.project.find_widget("button_home")

    assert node.width == "100%"
    assert node.height == 180


def test_sizes_absent_from_the_source_stay_absent(imported) -> None:
    """A grid child usually states no size. Substituting the schema default
    would pin a size the author never wrote and break the layout on export."""
    node = imported.project.find_widget("active_view_label")

    assert node.width is None
    assert node.height is None


def test_unmodelled_lvgl_keys_are_preserved(imported) -> None:
    assert set(imported.project.extra_lvgl) == {"bg_color", "bg_opa", "pad_all", "layout"}


def test_assets_are_marked_external_and_keep_their_paths(imported) -> None:
    images = {i.id: i for i in imported.project.images}

    assert len(images) == 13
    assert images["top_bg"].file_path == "images/topbg.png"
    assert all(i.external for i in images.values())
    # `type: RGB565` has no model field; it must survive anyway.
    assert images["top_bg"].extra == {"type": "RGB565"}

    font = imported.project.fonts[0]
    assert font.id == "icons_44"
    assert font.source_kind == "web"
    assert font.external


def test_no_blocking_issues_on_a_real_config(imported) -> None:
    blocking = [i for i in imported.issues if i.severity == "A"]

    assert blocking == [], [i.message for i in blocking]


def test_passthrough_is_limited_to_the_keys_we_expect(imported) -> None:
    """Asserted as a sorted name list, not a count: anything newly falling
    through to passthrough shows up as a readable diff rather than silently
    inflating a number."""
    preserved = sorted({key for node in _all(imported.project) for key in node.extra})

    assert preserved == []


# --- canvas detection -------------------------------------------------------

def test_canvas_size_comes_from_the_display_model(imported) -> None:
    """The config states no pixel size anywhere - ``display:`` only names a
    board, and ESPHome resolves the geometry from its own definitions."""
    assert (imported.project.canvas_width, imported.project.canvas_height) == (720, 720)
    assert imported.project.canvas_source == "display_model"


def test_an_explicit_canvas_size_wins(source_text: str) -> None:
    result = import_esphome_yaml(source_text, canvas_size=(480, 320))

    assert (result.project.canvas_width, result.project.canvas_height) == (480, 320)
    assert result.project.canvas_source == "user"


def test_canvas_size_falls_back_to_the_root_grid() -> None:
    """Independent of the model table: a single root laying out a fixed grid
    describes the panel it was drawn for."""
    text = """
lvgl:
  widgets:
    - obj:
        id: root
        layout:
          type: GRID
          grid_rows: [40, 680]
          grid_columns: [80, 560, 80]
"""
    result = import_esphome_yaml(text)

    assert (result.project.canvas_width, result.project.canvas_height) == (720, 720)
    assert result.project.canvas_source == "root_grid"


def test_canvas_size_falls_back_to_a_warned_default() -> None:
    result = import_esphome_yaml("lvgl:\n  widgets: []\n")

    assert result.project.canvas_source == "default"
    assert any(i.severity == "B" for i in result.issues)


# --- classification edge cases ---------------------------------------------

def test_angle_and_zoom_stay_content_on_an_image() -> None:
    """As style keys the exporter renames these to rotation/scale, which is a
    one-way mapping - so the content/style decision has to be made first."""
    result = import_esphome_yaml(
        "lvgl:\n  widgets:\n    - image:\n        id: i\n        angle: 900\n        zoom: 2.0\n")
    node = result.project.widgets[0]

    assert node.properties["angle"] == 900
    assert node.properties["zoom"] == 2.0
    assert "angle" not in node.style_tree


def test_styles_accepts_both_a_scalar_and_a_list() -> None:
    scalar = import_esphome_yaml(
        "lvgl:\n  widgets:\n    - obj:\n        styles: base\n").project.widgets[0]
    listed = import_esphome_yaml(
        "lvgl:\n  widgets:\n    - obj:\n        styles: [a, b]\n").project.widgets[0]

    assert scalar.style_refs == ["base"] and scalar.style_mode == "named"
    assert listed.style_refs == ["a", "b"]


def test_anonymous_widgets_get_distinct_generated_ids() -> None:
    result = import_esphome_yaml(
        "lvgl:\n  widgets:\n    - label: {text: a}\n    - label: {text: b}\n")
    first, second = result.project.widgets

    assert first.id != second.id
    assert first.synthetic_id and second.synthetic_id


def test_esphome_tags_do_not_break_the_parse() -> None:
    doc = load_lvgl_yaml("wifi:\n  password: !secret wifi_password\nlvgl:\n  widgets: []\n")

    assert str(doc["wifi"]["password"]) == "wifi_password"
    assert doc["wifi"]["password"].tag == "!secret"


def test_a_file_without_an_lvgl_block_is_rejected() -> None:
    with pytest.raises(LvglImportError):
        import_esphome_yaml("esphome:\n  name: test\n")


def test_probe_reports_what_an_import_would_do(source_text: str) -> None:
    stats = probe_esphome_yaml(source_text)

    assert stats["widget_count"] == 31
    assert stats["unsupported_types"] == []
    assert stats["canvas"] == {"width": 720, "height": 720, "source": "display_model"}


# --- round trip -------------------------------------------------------------

#: Differences the exporter introduces on purpose. ``align: TOP_LEFT`` is
#: LVGL's default placement, so omitting it is semantically identical.
#: ``duration: 500ms -> 500`` is the time-literal normalisation - a bare
#: int is milliseconds to ESPHome, so `500` and `500ms` compile identically.
ACCEPTED_DIFFS = {
    ".widgets[content_climate].obj.widgets[sprinterbg_linie1_anim].animimg.align",
    ".widgets[content_climate].obj.widgets[sprinterbg_linie1_anim].animimg.duration: '500ms' -> 500",
}


def test_import_export_round_trip_preserves_the_lvgl_block(imported, source_text) -> None:
    with tempfile.TemporaryDirectory() as directory:
        exported = export_project(imported.project, str(Path(directory) / "ui.yaml"))

    source = load_lvgl_yaml(source_text)["lvgl"]
    result = yaml.safe_load(exported.yaml_text)["lvgl"]
    diffs: list[str] = []
    _diff(source, result, "", diffs)

    assert [d for d in diffs if d.split(" ", 1)[1].strip() not in ACCEPTED_DIFFS] == []


#: Keys the exporter always writes, whether or not the source had them.
_EXPORTER_ADDS = {"displays", "color_depth"}


def _is_widget_list(value) -> bool:
    return all(isinstance(e, dict) and len(e) == 1
               and isinstance(next(iter(e.values())), (dict, type(None))) for e in value)


def _widget_key(entry):
    widget_type, body = next(iter(entry.items()))
    return widget_type, (body or {}).get("id")


def _diff(a, b, path: str, out: list[str]) -> None:
    """Compare semantically: key order and formatting are lost in any YAML
    dump, and so are the source's comments. Only content is asserted."""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            if not path and key in _EXPORTER_ADDS and key not in a:
                continue
            if key not in a:
                out.append(f"ADDED   {path}.{key}")
            elif key not in b:
                out.append(f"DROPPED {path}.{key}")
            else:
                _diff(a[key], b[key], f"{path}.{key}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if a and b and path.endswith("widgets") and _is_widget_list(a) and _is_widget_list(b):
            left = {_widget_key(e): e for e in a}
            right = {_widget_key(e): e for e in b}
            for key in sorted(set(left) | set(right), key=str):
                label = key[1] or key[0]
                if key not in left:
                    out.append(f"ADDED   {path}[{label}]")
                elif key not in right:
                    out.append(f"DROPPED {path}[{label}]")
                else:
                    _diff(left[key], right[key], f"{path}[{label}]", out)
        else:
            if len(a) != len(b):
                out.append(f"LENGTH  {path}: {len(a)} -> {len(b)}")
            for index, (x, y) in enumerate(zip(a, b)):
                _diff(x, y, f"{path}[{index}]", out)
    elif a != b:
        out.append(f"CHANGED {path}: {a!r} -> {b!r}")
