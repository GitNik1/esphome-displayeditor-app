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
    assert {"bar", "arc", "checkbox", "dropdown", "roller", "textarea", "keyboard"} <= keys
    assert {"tileview", "tile"} <= keys
    assert {"tabview", "tab"} <= keys
    assert {"led", "spinner", "qrcode", "spinbox"} <= keys
    assert "chart" not in keys
    assert not {"buttonmatrix", "msgboxes", "line", "canvas"} & keys


def test_tile_is_a_stub_not_offered_standalone_in_the_palette(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    schemas = service.schemas("de")
    by_key = {widget["type_key"]: widget for widget in schemas["widgets"]}
    assert by_key["tile"]["is_stub"] is True
    assert by_key["tileview"]["is_stub"] is False
    assert by_key["tileview"]["child_role"] == "tile"
    assert by_key["tab"]["is_stub"] is True
    assert by_key["tabview"]["is_stub"] is False
    assert by_key["tabview"]["child_role"] == "tab"


def test_schema_widgets_are_categorised_input_or_display(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    schemas = service.schemas("de")
    categories = {widget["type_key"]: widget["category"] for widget in schemas["widgets"]}
    assert categories["button"] == "input"
    assert categories["switch"] == "input"
    assert categories["slider"] == "input"
    assert categories["checkbox"] == "input"
    assert categories["arc"] == "input"
    assert categories["dropdown"] == "input"
    assert categories["roller"] == "input"
    assert categories["textarea"] == "input"
    assert categories["keyboard"] == "input"
    assert categories["label"] == "display"
    assert categories["image"] == "display"
    assert categories["bar"] == "display"
    assert categories["spinbox"] == "input"
    assert categories["led"] == "display"
    assert categories["spinner"] == "display"
    assert categories["qrcode"] == "display"
    assert set(categories.values()) <= {"input", "display"}


def test_schema_exposes_extended_paint_and_text_style_properties(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    schemas = service.schemas("de")
    by_key = {widget["type_key"]: widget for widget in schemas["widgets"]}
    button_keys = {prop["key"] for prop in by_key["button"]["properties"] if prop["category"] == "style"}
    assert {
        "pad_top", "pad_bottom", "pad_left", "pad_right",
        "margin_top", "margin_bottom", "margin_left", "margin_right",
        "border_opa", "border_side", "text_opa",
    } <= button_keys
    border_side_prop = next(p for p in by_key["button"]["properties"] if p["key"] == "border_side")
    assert border_side_prop["kind"] == "text_list"


def test_addon_extended_style_properties_export_and_import_without_changing_core(
    tmp_path: Path,
) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"][0]["style_tree"] = {
        "bg_color": "20C7B7",
        "pad_top": 4, "pad_bottom": 6, "pad_left": 8, "pad_right": 10,
        "margin_top": 2, "margin_bottom": 2, "margin_left": 0, "margin_right": 0,
        "border_opa": "50%",
        "border_side": ["TOP", "BOTTOM"],
        "text_opa": "80%",
    }

    exported = service.export_yaml(project)["yaml"]
    assert "pad_top: 4" in exported
    assert "pad_bottom: 6" in exported
    assert "pad_left: 8" in exported
    assert "pad_right: 10" in exported
    assert "margin_top: 2" in exported
    assert "border_opa: 50%" in exported
    assert "border_side:" in exported and "- TOP" in exported and "- BOTTOM" in exported
    assert "text_opa: 80%" in exported

    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    button = imported["project"]["widgets"][0]
    assert button["style_tree"]["pad_top"] == 4
    assert button["style_tree"]["pad_right"] == 10
    assert button["style_tree"]["margin_top"] == 2
    assert button["style_tree"]["border_opa"] == "50%"
    assert button["style_tree"]["border_side"] == ["TOP", "BOTTOM"]
    assert button["style_tree"]["text_opa"] == "80%"


def test_addon_checkbox_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "night_mode", "widget_type": "checkbox", "x": 10, "y": 10,
            "width": 150, "height": 24,
            "properties": {"text": "Night mode", "state_checked": True},
            "style_tree": {"indicator": {"bg_color": "20C7B7"}}, "children": [],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "checkbox:" in exported
    assert "text: Night mode" in exported
    assert "state_checked: true" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    widgets = {item["id"]: item for item in imported["project"]["widgets"]}
    assert widgets["night_mode"]["properties"]["text"] == "Night mode"
    assert widgets["night_mode"]["properties"]["state_checked"] is True
    assert widgets["night_mode"]["style_tree"]["indicator"]["bg_color"] == "20C7B7"


def test_addon_dropdown_and_roller_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "room_select", "widget_type": "dropdown", "x": 10, "y": 10,
            "width": 150, "height": 40,
            "properties": {
                "options": ["Living room", "Kitchen", "Bedroom"],
                "selected_index": 1, "dir": "UP",
            },
            "style_tree": {"selected": {"bg_color": "20C7B7"}}, "children": [],
        },
        {
            "id": "hour_roller", "widget_type": "roller", "x": 10, "y": 60,
            "width": 100, "height": 90,
            "properties": {
                "options": ["00", "01", "02", "03"],
                "selected_index": 2, "visible_row_count": 3, "mode": "INFINITE",
            },
            "style_tree": {}, "children": [],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "dropdown:" in exported and "roller:" in exported
    assert "- Living room" in exported and "- Kitchen" in exported
    assert "selected_index: 1" in exported
    assert "mode: INFINITE" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    widgets = {item["id"]: item for item in imported["project"]["widgets"]}
    assert widgets["room_select"]["properties"]["options"] == ["Living room", "Kitchen", "Bedroom"]
    assert widgets["room_select"]["properties"]["selected_index"] == 1
    assert widgets["room_select"]["style_tree"]["selected"]["bg_color"] == "20C7B7"
    assert widgets["hour_roller"]["properties"]["options"] == ["00", "01", "02", "03"]
    assert widgets["hour_roller"]["properties"]["visible_row_count"] == 3


def test_addon_textarea_and_keyboard_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "name_field", "widget_type": "textarea", "x": 10, "y": 10,
            "width": 200, "height": 40,
            "properties": {
                "text": "", "placeholder_text": "Enter name", "one_line": True,
                "max_length": 32,
            },
            "style_tree": {}, "children": [],
        },
        {
            "id": "on_screen_keyboard", "widget_type": "keyboard", "x": 10, "y": 60,
            "width": 320, "height": 160,
            "properties": {"textarea": "name_field", "mode": "TEXT_UPPER"},
            "style_tree": {}, "children": [],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "textarea:" in exported and "keyboard:" in exported
    assert "placeholder_text: Enter name" in exported
    assert "one_line: true" in exported
    assert "textarea: name_field" in exported
    assert "mode: TEXT_UPPER" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    widgets = {item["id"]: item for item in imported["project"]["widgets"]}
    assert widgets["name_field"]["properties"]["placeholder_text"] == "Enter name"
    assert widgets["name_field"]["properties"]["one_line"] is True
    assert widgets["on_screen_keyboard"]["properties"]["textarea"] == "name_field"
    assert widgets["on_screen_keyboard"]["properties"]["mode"] == "TEXT_UPPER"


def test_addon_tileview_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "main_tileview", "widget_type": "tileview", "x": 0, "y": 0,
            "width": 300, "height": 300,
            "properties": {}, "style_tree": {},
            "children": [
                {
                    "id": "home_tile", "widget_type": "tile",
                    "tile_row": 0, "tile_col": 0, "tile_dir": "ALL",
                    "properties": {}, "style_tree": {},
                    "children": [
                        {
                            "id": "home_label", "widget_type": "label",
                            "properties": {"text": "Home"}, "style_tree": {},
                            "children": [],
                        },
                    ],
                },
                {
                    "id": "settings_tile", "widget_type": "tile",
                    "tile_row": 0, "tile_col": 1, "tile_dir": "LEFT",
                    "properties": {}, "style_tree": {},
                    "children": [],
                },
            ],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "tileview:" in exported
    assert "tiles:" in exported and "widgets:" in exported
    assert "column: 1" in exported
    assert "dir: LEFT" in exported
    assert "id: settings_tile" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    tileview = imported["project"]["widgets"][0]
    assert tileview["widget_type"] == "tileview"
    tiles = {t["id"]: t for t in tileview["children"]}
    assert tiles["home_tile"]["tile_row"] == 0
    assert tiles["home_tile"]["tile_col"] == 0
    assert tiles["home_tile"]["children"][0]["id"] == "home_label"
    assert tiles["settings_tile"]["tile_col"] == 1
    assert tiles["settings_tile"]["tile_dir"] == "LEFT"
    assert tiles["settings_tile"]["children"] == []


def test_addon_tabview_export_and_import_without_changing_core(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "main_tabview", "widget_type": "tabview", "x": 0, "y": 0,
            "width": 300, "height": 300,
            "properties": {"position": "TOP", "size": "10%"}, "style_tree": {},
            "children": [
                {
                    "id": "home_tab", "widget_type": "tab", "tab_title": "Home",
                    "properties": {}, "style_tree": {},
                    "children": [
                        {
                            "id": "home_label", "widget_type": "label",
                            "properties": {"text": "Home"}, "style_tree": {},
                            "children": [],
                        },
                    ],
                },
                {
                    "id": "settings_tab", "widget_type": "tab", "tab_title": "Settings",
                    "properties": {}, "style_tree": {},
                    "children": [],
                },
            ],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "tabview:" in exported
    assert "tabs:" in exported and "widgets:" in exported
    assert "name: Home" in exported
    assert "name: Settings" in exported
    assert "id: settings_tab" in exported
    assert "position: TOP" in exported
    assert "size: 10%" in exported
    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    tabview = imported["project"]["widgets"][0]
    assert tabview["widget_type"] == "tabview"
    tabs = {t["id"]: t for t in tabview["children"]}
    assert tabs["home_tab"]["tab_title"] == "Home"
    assert tabs["home_tab"]["children"][0]["id"] == "home_label"
    assert tabs["settings_tab"]["tab_title"] == "Settings"
    assert tabs["settings_tab"]["children"] == []


def test_addon_led_spinner_qrcode_spinbox_export_and_import_without_changing_core(
    tmp_path: Path,
) -> None:
    service = DesignerService(tmp_path)
    project = project_with_button()
    project["widgets"] = [
        {
            "id": "status_led", "widget_type": "led", "x": 10, "y": 10,
            "width": 20, "height": 20,
            "properties": {"color": "FF0000", "brightness": "70%"},
            "style_tree": {}, "children": [],
        },
        {
            "id": "busy_spinner", "widget_type": "spinner", "x": 40, "y": 10,
            "width": 40, "height": 40,
            "properties": {
                "arc_length": 60, "spin_time": "500ms",
                "arc_color": "18BCF2", "arc_rounded": True,
            },
            "style_tree": {"indicator": {"arc_color": "31DE70"}}, "children": [],
        },
        {
            "id": "lv_qr", "widget_type": "qrcode", "x": 90, "y": 10,
            "width": 100, "height": 100,
            "properties": {"text": "esphome.io", "size": 100, "dark_color": "steelblue"},
            "style_tree": {}, "children": [],
        },
        {
            "id": "spinbox_id", "widget_type": "spinbox", "x": 200, "y": 10,
            "width": 120, "height": 40,
            "properties": {"range_from": -10, "range_to": 40, "digits": 3, "decimal_places": 1},
            "style_tree": {}, "children": [],
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    assert "led:" in exported
    assert "brightness: 70%" in exported
    assert "spinner:" in exported
    assert "arc_length: 60" in exported
    assert "indicator:" in exported and "31DE70" in exported.upper()
    assert "qrcode:" in exported
    assert "text: esphome.io" in exported
    assert "spinbox:" in exported
    assert "range_from: -10" in exported

    imported = service.import_yaml(f"lvgl:\n{exported.split('lvgl:', 1)[1]}")
    assert imported["valid"]
    by_id = {w["id"]: w for w in imported["project"]["widgets"]}
    assert by_id["status_led"]["properties"]["brightness"] == "70%"
    assert by_id["busy_spinner"]["properties"]["arc_length"] == 60
    assert by_id["busy_spinner"]["properties"]["arc_rounded"] is True
    assert by_id["busy_spinner"]["style_tree"]["indicator"]["arc_color"].upper() == "31DE70"
    assert by_id["lv_qr"]["properties"]["text"] == "esphome.io"
    assert by_id["spinbox_id"]["properties"]["digits"] == 3
    assert by_id["spinbox_id"]["properties"]["range_from"] == -10


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


def test_widget_id_colliding_with_a_reserved_id_fails_validation(tmp_path: Path) -> None:
    """``reserved_ids`` records ids used by hardware entities elsewhere in an
    imported source config (binary_sensor:, button:, ...) that this designer
    never models. A widget reusing one of those ids - e.g. the designer
    auto-generating "button_1" for a new button, unaware a `binary_sensor:`
    already claimed it - must fail validation just like any other duplicate
    id, not silently produce a config ESPHome can't compile."""
    project = project_with_button()
    project["reserved_ids"] = ["button_1"]
    project["widgets"][0]["id"] = "button_1"
    _parsed, issues = DesignerService(tmp_path).validate(project)
    assert any(
        "Duplicate id" in issue["message"] and "button_1" in issue["message"]
        for issue in issues
    )


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
