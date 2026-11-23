from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from backend.designer import DesignerService
from backend.designer_core.model import ImageLibraryEntry, Project, WidgetNode
from backend.lvgl_merge import MergeError, choose_merge_base, merge_project_into_yaml
from backend.yaml_strict import load_yaml_strict


def project_with_button() -> Project:
    project = Project()
    project.display_id_placeholder = "my_display"
    button = WidgetNode(id="button_1", widget_type="button")
    button.properties = {"text": "New Button"}
    project.widgets.append(button)
    return project


def test_merge_replaces_only_the_existing_lvgl_block() -> None:
    existing = (
        "esphome:\n"
        "  name: test-device\n"
        "\n"
        "wifi:\n"
        "  ssid: !secret wifi_ssid\n"
        "\n"
        "lvgl:\n"
        "  displays:\n"
        "  - my_display\n"
        "  widgets:\n"
        "  - label:\n"
        "      id: old_label\n"
        "      text: Old\n"
        "\n"
        "api:\n"
        "  encryption:\n"
        "    key: !secret api_key\n"
    )

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == ["lvgl"]
    assert result.appended_keys == []
    assert "esphome:\n  name: test-device" in result.content
    assert "wifi:\n  ssid: !secret wifi_ssid" in result.content
    assert "api:\n  encryption:\n    key: !secret api_key" in result.content
    assert "old_label" not in result.content
    assert "button_1" in result.content
    assert "New Button" in result.content


def test_merge_appends_a_missing_top_level_key_without_copying_the_file() -> None:
    existing = (
        "esphome:\n"
        "  name: test-device\n"
        "\n"
        "lvgl:\n"
        "  widgets:\n"
        "  - label:\n"
        "      id: old_label\n"
        "      text: Old\n"
    )
    project = Project()
    project.display_id_placeholder = "my_display"
    image = ImageLibraryEntry(id="my_icon")
    image.file_path = "images/my_icon.png"
    image.external = False
    project.images.append(image)
    widget = WidgetNode(id="icon_widget", widget_type="image")
    widget.properties = {"src": "my_icon"}
    project.widgets.append(widget)

    result = merge_project_into_yaml(project, existing)

    assert result.replaced_keys == ["lvgl"]
    assert result.appended_keys == ["image"]
    assert "image:\n- platform: file\n  id: my_icon\n  file: images/my_icon.png" in result.content
    assert "esphome:\n  name: test-device" in result.content


def test_merge_leaves_a_key_the_project_has_nothing_for_untouched() -> None:
    existing = (
        "color:\n"
        "- id: existing_color\n"
        "  hex: FF0000\n"
        "\n"
        "lvgl:\n"
        "  widgets: []\n"
    )

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == ["lvgl"]
    assert "existing_color" in result.content
    assert "color:" in result.content


def test_merge_appends_lvgl_when_the_target_has_none_yet() -> None:
    existing = "esphome:\n  name: test-device\n"

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == []
    assert result.appended_keys == ["lvgl"]
    assert "esphome:\n  name: test-device" in result.content
    assert "button_1" in result.content


def test_merging_the_same_project_twice_in_a_row_does_not_duplicate_entries() -> None:
    """The bug this regresses: a top-level key whose value is a bare list
    (color:/font:/image: - never lvgl:, whose own lists like widgets: are
    always nested under another key and therefore genuinely indented)
    dumps its list items starting at column 0 with "-", not indented.
    _find_top_level_block() only recognised whitespace-indented
    continuation lines, so it measured a list-valued block as just its own
    "key:" line - a *replace* (the key already existed, e.g. from a
    previous merge) then only overwrote that one line, leaving every old
    entry sitting right after the freshly-inserted new ones. Saving the
    same project as a draft twice in a row silently duplicated every
    image:/font: entry."""
    existing = "esphome:\n  name: test-device\n"
    project = project_with_button()
    image = ImageLibraryEntry(id="img_x")
    image.file_path = "images/x.png"
    image.external = True
    project.images.append(image)

    first = merge_project_into_yaml(project, existing)
    second = merge_project_into_yaml(project, first.content)
    third = merge_project_into_yaml(project, second.content)

    assert second.replaced_keys == ["image", "lvgl"]
    assert third.content.count("id: img_x") == 1
    assert third.content.count("- platform: file") == 1


def test_merge_flags_a_background_image_id_colliding_with_a_real_image() -> None:
    """The bug this regresses: the reference-image background exports its
    own synthetic image: entry using project.background.image_id - unless
    that id is checked against the project's real images too, it can
    silently collide and the merged image: block ends up defining the same
    id twice, which ESPHome rejects at compile time with "ID ... redefined!"."""
    existing = "esphome:\n  name: test-device\n"
    project = project_with_button()
    image = ImageLibraryEntry(id="img_flow_00")
    image.file_path = "images/flow_00.png"
    project.images.append(image)
    project.background.path = "https://example.invalid/mockup.png"
    project.background.export_as_lvgl_image = True
    project.background.image_id = "img_flow_00"

    result = merge_project_into_yaml(project, existing)

    assert any("img_flow_00" in issue.message for issue in result.issues)


def test_merge_rejects_a_duplicate_top_level_key() -> None:
    existing = "lvgl:\n  widgets: []\nlvgl:\n  widgets: []\n"

    with pytest.raises(MergeError):
        merge_project_into_yaml(project_with_button(), existing)


# --- block boundaries from the YAML structure (A1) ------------------------------

FIXTURES = sorted((Path(__file__).parent / "data").glob("*.yaml"))


def _widget_ids(value: Any) -> list[str]:
    """Ids of widget *definitions* - actions reference ids too, so counting
    ``id:`` text would see every referenced widget twice."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "widgets" and isinstance(child, list):
                for item in child:
                    if isinstance(item, dict) and len(item) == 1:
                        (body,) = item.values()
                        if isinstance(body, dict) and isinstance(body.get("id"), str):
                            found.append(body["id"])
            found.extend(_widget_ids(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_widget_ids(child))
    return found


def _imported(tmp_path: Path, source: str) -> Project:
    service = DesignerService(tmp_path)
    payload = json.loads(json.dumps(service.import_yaml(source)["project"]))
    project, _issues = service.validate(payload)
    return project


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda path: path.name)
def test_an_unchanged_import_merges_back_byte_for_byte(
    tmp_path: Path, fixture: Path, newline: str
) -> None:
    source = fixture.read_text(encoding="utf-8").replace("\n", newline)

    merged = merge_project_into_yaml(_imported(tmp_path, source), source,
                                     display_takeover="comment")

    document = load_yaml_strict(merged.content)  # a repeated key raises
    ids = _widget_ids(document.get("lvgl"))
    assert len(ids) == len(set(ids))
    assert ids == _widget_ids(load_yaml_strict(source).get("lvgl"))
    # Glyph order and escapes, spelled-out defaults and absent empty widget
    # lists all survive: nothing changed, so nothing is rewritten.
    assert merged.content == source


def test_a_patch_that_leaves_old_text_behind_falls_back_to_a_whole_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole-document check is the safety net for what the per-block
    patch check cannot see."""
    def leave_a_duplicate_behind(lines, key, value):
        return [*lines, "  widgets: []\n"]

    monkeypatch.setattr("backend.lvgl_merge.patch_top_level_block", leave_a_duplicate_behind)
    existing = "lvgl:\n  widgets:\n  - label:\n      id: old\n"

    result = merge_project_into_yaml(project_with_button(), existing)

    load_yaml_strict(result.content)
    assert "button_1" in result.content and "old" not in result.content
    assert any(issue.severity == "C" and "'lvgl:'" in issue.message for issue in result.issues)


def test_a_merge_that_cannot_be_verified_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.lvgl_merge.patch_top_level_block",
                        lambda lines, key, value: [*lines, "  widgets: []\n"])
    monkeypatch.setattr("backend.lvgl_merge._dump_lines",
                        lambda key, value, newline: [f"{key}:\n", "  widgets: []\n", "  widgets: []\n"])

    with pytest.raises(MergeError, match="did not come out as intended"):
        merge_project_into_yaml(project_with_button(), "lvgl:\n  widgets: []\n")


def test_a_target_with_a_repeated_key_is_refused_with_its_line() -> None:
    existing = "sensor:\n  - platform: template\n    id: a\n    id: b\n"

    with pytest.raises(MergeError, match="duplicate key"):
        merge_project_into_yaml(project_with_button(), existing)


def test_a_broken_draft_is_replaced_by_a_merge_into_the_active_file() -> None:
    broken = "lvgl:\n  widgets: []\n  widgets: []\n"
    active = "esphome:\n  name: device\n"

    assert choose_merge_base(None, active) == (active, [])
    assert choose_merge_base(active + "# edited\n", active) == (active + "# edited\n", [])
    base, issues = choose_merge_base(broken, active)
    assert base == active
    assert [issue.severity for issue in issues] == ["B"]


def test_a_whole_block_rewrite_keeps_crlf_line_endings() -> None:
    existing = "esphome:\r\n  name: device\r\nlvgl: {widgets: []}\r\n"

    result = merge_project_into_yaml(project_with_button(), existing)

    assert "\n" not in result.content.replace("\r\n", "")
    assert "button_1" in result.content


GLYPH_SOURCE = """\
font:
  - file:
      type: web
      url: "https://github.com/Templarian/MaterialDesign-Webfont/raw/master/fonts/materialdesignicons-webfont.ttf"
    id: icons
    size: 24
    glyphs:
      - "\U000F0335"   # mdi:lightbulb
      - "\U000F02DC"   # mdi:home
lvgl:
  widgets:
    - label:
        id: a
        align: TOP_LEFT
        x: 0
        text: A
    - label:
        id: b
        align: CENTER
        text: B
  bottom_layer:
    bg_opa: COVER
"""


def test_a_moved_widget_keeps_its_spelled_out_defaults(tmp_path: Path) -> None:
    project = _imported(tmp_path, GLYPH_SOURCE)
    project.widgets[0].y = 12

    merged = merge_project_into_yaml(project, GLYPH_SOURCE).content

    assert "        align: TOP_LEFT\n        x: 0\n" in merged
    assert "y: 12" in merged
    assert '"\U000F0335"   # mdi:lightbulb' in merged
    assert "bottom_layer:\n    bg_opa: COVER\n" in merged
    assert merged.count("widgets:") == 1


def test_a_default_the_user_chose_replaces_the_source_value(tmp_path: Path) -> None:
    project = _imported(tmp_path, GLYPH_SOURCE)
    project.widgets[1].align = "TOP_LEFT"

    merged = merge_project_into_yaml(project, GLYPH_SOURCE).content

    assert "CENTER" not in merged
    assert load_yaml_strict(merged)["lvgl"]["widgets"][1]["label"].get("align", "TOP_LEFT") == "TOP_LEFT"
