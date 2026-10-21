"""Saving an imported, hand-written config back must not lose anything.

The fixture is an excerpt of a real device config. It states no
``displays:``, gives its fonts no ``bpp:``, uses a multi-line ``!lambda``
action and keeps commented-out widgets inside ``lvgl:`` - each of which a
whole-block re-dump used to break or drop. Every test goes through the same
path as the editor: import, JSON round trip (the browser), validate, merge.
"""

from __future__ import annotations

import copy
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from backend.designer import DesignerService
from backend.designer_core.yamlimport import TaggedScalar, import_esphome_yaml, load_lvgl_yaml
from backend.lvgl_merge import merge_project_into_yaml
from backend.yaml_patch import patch_top_level_block

FIXTURE = Path(__file__).parent / "data" / "transmitter_tester.yaml"


@pytest.fixture(scope="module")
def source() -> str:
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture
def service(tmp_path: Path) -> DesignerService:
    return DesignerService(tmp_path)


@pytest.fixture
def payload(service: DesignerService, source: str) -> dict[str, Any]:
    imported = service.import_yaml(source, source_name="transmitter_tester.yaml")
    return json.loads(json.dumps(imported["project"]))


def _save(service: DesignerService, payload: dict[str, Any], source: str) -> str:
    project, issues = service.validate(copy.deepcopy(payload))
    assert not [i for i in issues if i["severity"] == "error"]
    return merge_project_into_yaml(project, source).content


#: What the designer always states in lvgl: - ESPHome defaults, harmless.
DEFAULT_LINES = ["  color_depth: 16", "  widgets: []", "  page_wrap: true"]


def _changed(before: str, after: str) -> tuple[list[str], list[str]]:
    """Lines removed and added, as multisets - unlike a positional diff this
    does not depend on how difflib aligns the many repeated lines. The
    always-present lvgl defaults are left out of ``added``."""
    old, new = Counter(before.splitlines()), Counter(after.splitlines())
    added = new - old - Counter(DEFAULT_LINES)
    return sorted((old - new).elements()), sorted(added.elements())


def _widget(payload: dict[str, Any], widget_id: str) -> dict[str, Any]:
    def walk(nodes):
        for node in nodes:
            yield node
            yield from walk(node.get("children", []))
    return next(w for page in payload["pages"] for w in walk(page["widgets"])
                if w["id"] == widget_id)


def _page_widgets(payload: dict[str, Any], page_id: str) -> list[dict[str, Any]]:
    return next(page for page in payload["pages"] if page["id"] == page_id)["widgets"]


def _comments(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.lstrip().startswith("#")]


# --- unchanged save -----------------------------------------------------------

def test_saving_an_unchanged_import_keeps_every_original_line(service, payload, source) -> None:
    merged = _save(service, payload, source)

    # Nothing removed; at most the defaults added - never a display id the
    # source does not define.
    assert _changed(source, merged) == ([], [])
    assert all(line in merged.splitlines() for line in DEFAULT_LINES)


def test_commented_out_widgets_survive_a_save(service, payload, source) -> None:
    merged = _save(service, payload, source)

    assert _comments(merged) == _comments(source)
    assert "        #     id: tr1_button" in merged


def test_saving_twice_is_stable(service, payload, source) -> None:
    once = _save(service, payload, source)
    again = service.import_yaml(once)["project"]

    assert _save(service, json.loads(json.dumps(again)), once) == once


# --- displays / bpp -----------------------------------------------------------

def test_a_config_without_displays_gets_none_written(service, payload, source) -> None:
    assert payload["display_id_placeholder"] == ""
    assert "displays" not in load_lvgl_yaml(_save(service, payload, source))["lvgl"]


@pytest.mark.parametrize(("written", "expected"), [
    ("  displays:\n  - main_display\n", ["main_display"]),
    ("  displays: main_display\n", ["main_display"]),
    ("  displays:\n  - left\n  - right\n", ["left", "right"]),
])
def test_stated_displays_are_kept(written: str, expected: list[str]) -> None:
    text = f"lvgl:\n{written}  widgets:\n  - label:\n      id: l1\n"
    project = import_esphome_yaml(text).project

    merged = merge_project_into_yaml(project, text).content

    assert load_lvgl_yaml(merged)["lvgl"]["displays"] == expected


def test_fonts_without_bpp_are_saved_without_bpp(service, payload, source) -> None:
    assert [font["bpp"] for font in payload["fonts"]] == [None, None, None]
    fonts = load_lvgl_yaml(_save(service, payload, source))["font"]

    assert all("bpp" not in font for font in fonts)


def test_a_stated_bpp_is_kept() -> None:
    text = ("font:\n  - file: \"gfonts://Roboto\"\n    id: f\n    size: 20\n    bpp: 2\n"
            "lvgl:\n  widgets:\n  - label:\n      id: l1\n      text_font: f\n")
    project = import_esphome_yaml(text).project

    assert load_lvgl_yaml(merge_project_into_yaml(project, text).content)["font"][0]["bpp"] == 2


# --- !lambda ------------------------------------------------------------------

def test_lambda_tags_in_actions_survive_the_json_round_trip(service, payload, source) -> None:
    action = _widget(payload, "msgbox_ok")["events"]["on_release"][0]
    assert set(action["lambda"]) == {"__esphome_lambda__"}

    merged = load_lvgl_yaml(_save(service, payload, source))
    page = merged["lvgl"]["pages"][1]
    button = next(w["button"] for w in page["widgets"]
                  if w.get("button", {}).get("id") == "msgbox_ok")
    code = button["on_release"][0]["lambda"]
    assert isinstance(code, TaggedScalar) and code.tag == "!lambda"


def test_an_edited_lambda_is_written_as_a_block(service, payload, source) -> None:
    action = _widget(payload, "msgbox_ok")["events"]["on_release"][0]
    action["lambda"]["__esphome_lambda__"] += "\nid(test_result).publish_state(false);"

    removed, added = _changed(source, _save(service, payload, source))

    assert "id(test_result).publish_state(false);" in [line.strip() for line in added]
    assert not any('\\n' in line for line in added)
    assert "- lambda: !lambda |-" not in removed


# --- edits --------------------------------------------------------------------

def test_an_edit_touches_only_its_own_lines(service, payload, source) -> None:
    _widget(payload, "msgbox_title")["properties"]["text"] = "Neu"
    _widget(payload, "msgbox_ok")["style_tree"]["bg_color"] = "0x00AA00"

    removed, added = _changed(source, _save(service, payload, source))

    assert [line.strip() for line in removed] == [
        "bg_color: 0x0bff00", r'text: "Transmitter \nTest:"']
    assert [line.strip() for line in added] == ["bg_color: 0x00AA00", "text: Neu"]


def test_deleting_a_widget_removes_only_its_lines(service, payload, source) -> None:
    widgets = _page_widgets(payload, "main_page")
    widgets[:] = [w for w in widgets if w["id"] != "sensortext_label"]

    merged = _save(service, payload, source)
    removed, _added = _changed(source, merged)

    assert len(removed) == 12 and _added == []
    assert "sensortext_label" not in merged
    assert _comments(merged) == _comments(source)


def test_a_new_widget_uses_the_files_sequence_indentation(service, payload, source) -> None:
    widgets = _page_widgets(payload, "main_page")
    template = next(w for w in widgets if w["id"] == "mode_button")
    clone = copy.deepcopy(template)
    clone["id"] = "extra_button"
    clone["children"][0]["id"] = "extra_button_label"
    widgets.append(clone)

    merged = _save(service, payload, source)

    assert "        - button:\n            id: extra_button\n" in merged
    assert "            widgets:\n              - label:\n" in merged
    assert _comments(merged) == _comments(source)


def test_reordering_moves_the_original_text(service, payload, source) -> None:
    widgets = _page_widgets(payload, "main_page")
    widgets.insert(0, widgets.pop(3))

    merged = _save(service, payload, source)
    removed, added = _changed(source, merged)

    assert removed == added == []
    assert merged.index("id: sensortext_label") < merged.index("id: version_1_label")


# --- fallback -----------------------------------------------------------------

def test_an_unpatchable_edit_falls_back_to_a_full_rewrite() -> None:
    # Dropping the first key of a `- key:` item would take its dash along.
    lines = "lvgl:\n  pages:\n    - skip: true\n      bg_opa: 50%\n".splitlines(keepends=True)

    assert patch_top_level_block(lines, "lvgl", {"pages": [{"bg_opa": "50%"}]}) is None
