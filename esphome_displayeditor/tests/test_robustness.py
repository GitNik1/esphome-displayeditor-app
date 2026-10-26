"""Regression tests from a hardening pass over import, merge and scenarios.

Each test pins a failure that was reproduced first: lambdas in widget
properties lost their tag on save, a trailing blank after ``lvgl:`` produced a
second ``lvgl:`` key, a 466-byte YAML alias bomb hung the parsers, and
triggers written as automation lists were missed by the scenario suggestions.
The fuzz test at the end guards the structural patcher as a whole.
"""

from __future__ import annotations

import copy
import json
import random
from pathlib import Path

import pytest

import backend.lvgl_merge  # noqa: F401 - registers the tagged-scalar representer
from backend.designer import DesignerService
from backend.designer_core.model import Project, WidgetNode
from backend.designer_core.yamlimport import (
    LvglImportError,
    TaggedScalar,
    load_lvgl_yaml,
)
from backend.entity_bindings import parse_custom_binding_yaml
from backend.lvgl_merge import MergeError, _find_top_level_block, merge_project_into_yaml
from backend.viewer_scenario_suggestions import suggest_viewer_scenarios
from backend.viewer_scenarios import parse_viewer_scenarios
from backend.yaml_patch import _dump, patch_top_level_block, same_yaml_value

FIXTURE = Path(__file__).parent / "data" / "transmitter_tester.yaml"

LAMBDA_TEXT = """\
display:
  - platform: sdl
    id: d
    dimensions: {width: 320, height: 240}
lvgl:
  widgets:
    - label:
        id: clock
        text: !lambda 'return id(t).now().strftime("%H:%M");'
        text_color: !lambda return lv_color_hex(0xFF0000);
"""


def _roundtrip(tmp_path: Path, source: str) -> str:
    service = DesignerService(tmp_path)
    payload = json.loads(json.dumps(service.import_yaml(source)["project"]))
    project, _issues = service.validate(payload)
    return merge_project_into_yaml(project, source).content


# --- lambdas in widget properties ----------------------------------------------

def test_lambda_properties_survive_import_and_save(tmp_path: Path) -> None:
    merged = _roundtrip(tmp_path, LAMBDA_TEXT)

    assert "        text: !lambda 'return id(t).now().strftime(\"%H:%M\");'\n" in merged
    assert "        text_color: !lambda return lv_color_hex(0xFF0000);\n" in merged


def test_lambda_properties_are_preserved_not_editable(tmp_path: Path) -> None:
    imported = DesignerService(tmp_path).import_yaml(LAMBDA_TEXT)
    widget = imported["project"]["widgets"][0]

    assert "text" not in widget["properties"]
    assert widget["extra"]["text"] == {"__esphome_lambda__": 'return id(t).now().strftime("%H:%M");'}
    assert any("computed at runtime (!lambda)" in issue["message"] for issue in imported["issues"])


def test_lambda_properties_survive_the_standalone_export(tmp_path: Path) -> None:
    service = DesignerService(tmp_path)
    payload = json.loads(json.dumps(service.import_yaml(LAMBDA_TEXT)["project"]))

    exported = service.export_yaml(payload)["yaml"]

    assert "text: !lambda 'return id(t).now().strftime(\"%H:%M\");'" in exported


# --- top-level block detection ---------------------------------------------------

def _label_project() -> Project:
    project = Project()
    project.display_id_placeholder = ""
    label = WidgetNode(id="neu", widget_type="label")
    label.properties = {"text": "x"}
    project.widgets.append(label)
    return project


@pytest.mark.parametrize("header", ["lvgl: \n", "lvgl:   # meine UI\n"])
def test_a_decorated_lvgl_line_is_still_the_lvgl_block(header: str) -> None:
    content = header + "  widgets:\n    - label: {id: alt}\n"

    merged = merge_project_into_yaml(_label_project(), content)

    assert merged.replaced_keys == ["lvgl"] and merged.appended_keys == []
    assert merged.content.count("lvgl:") == 1


def test_an_inline_lvgl_value_is_replaced_not_duplicated() -> None:
    merged = merge_project_into_yaml(_label_project(), "lvgl: {widgets: []}\n")

    assert merged.content.count("lvgl:") == 1
    assert load_lvgl_yaml(merged.content)["lvgl"]["widgets"][0]["label"]["id"] == "neu"


@pytest.mark.parametrize("header", ["lvgl: !include ui.yaml\n", "lvgl: &ui\n  widgets: []\n",
                                    "lvgl: *shared\n"])
def test_a_referenced_lvgl_block_is_refused(header: str) -> None:
    with pytest.raises(MergeError, match="another file or anchor"):
        merge_project_into_yaml(_label_project(), header)


def test_a_file_yaml_cannot_read_is_refused_with_its_position() -> None:
    """A tab after ``lvgl:`` is not YAML that PyYAML/libyaml (and so ESPHome
    and the publish check) can read; the merge says where instead of
    guessing block boundaries from indentation."""
    content = "lvgl:\t\n  widgets:\n    - label: {id: alt}\n"

    with pytest.raises(MergeError, match=r"line 1, column 6"):
        merge_project_into_yaml(_label_project(), content)


def test_block_detection_ignores_lookalikes() -> None:
    lines = ["lvgl_extra:\n", "  - x\n", "# lvgl:\n", "other:\n", "  lvgl: 1\n"]

    assert _find_top_level_block(lines, "lvgl") is None


def test_a_column_zero_comment_stays_inside_its_block() -> None:
    """The regression behind duplicated widgets: a commented-out property at
    column 0 inside ``lvgl:`` ended the block for the old line scanner."""
    lines = ["lvgl:\n", "  widgets:\n", "    - obj:\n", "        id: a\n",
             "#        pad_left: 6\n", "        radius: 0\n", "# trailing note\n",
             "\n", "wifi:\n", "  ssid: x\n"]

    assert _find_top_level_block(lines, "lvgl") == (0, 6)


# --- YAML alias bombs -----------------------------------------------------------------

def _bomb(indent: str) -> str:
    levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]']
    previous = "a"
    for name in "bcdefgh":
        levels.append(f"{name}: &{name} [" + ",".join([f"*{previous}"] * 9) + "]")
        previous = name
    return "\n".join(indent + line for line in levels)


@pytest.mark.parametrize("parse", [
    lambda: parse_viewer_scenarios(
        "- name: bomb\n  actions:\n    - lvgl.label.update:\n        id: l\n        anchors:\n"
        + _bomb("          ") + "\n        text: *h\n"),
    lambda: parse_custom_binding_yaml(
        "lvgl.label.update:\n  anchors:\n" + _bomb("    ") + "\n  text: *h\n"),
    lambda: load_lvgl_yaml("lvgl:\n  anchors:\n" + _bomb("    ") + "\n  widgets: *h\n"),
])
def test_alias_bombs_are_refused_quickly(parse) -> None:
    with pytest.raises(LvglImportError, match="too many nodes"):
        parse()


def test_recursive_aliases_are_refused() -> None:
    with pytest.raises(LvglImportError, match="recursive"):
        parse_viewer_scenarios("- &a\n  name: x\n  actions: [*a]\n")


def test_ordinary_anchors_still_work() -> None:
    scenarios = parse_viewer_scenarios(
        "- name: a\n  actions:\n    - lvgl.label.update: &u {id: l, text: x}\n"
        "- name: b\n  actions:\n    - lvgl.label.update: *u\n")

    assert scenarios[1]["actions"] == [{"lvgl.label.update": {"id": "l", "text": "x"}}]


# --- scenario suggestions: every way ESPHome spells a trigger ------------------------

def test_suggestions_cover_automation_lists_and_single_actions() -> None:
    config = load_lvgl_yaml("""\
binary_sensor:
  - platform: gpio
    id: taste
    on_press:
      - then:
          - lvgl.page.next:
      - min_length: 1s
        then:
          - lvgl.page.show: setup
    on_release:
      then:
        lvgl.widget.show: info
lvgl:
  widgets: []
""")

    names = {s["name"]: s["actions"] for s in suggest_viewer_scenarios(config)}

    assert names["binary_sensor taste: on_press #1"] == [{"lvgl.page.next": None}]
    assert names["binary_sensor taste: on_press (min_length: 1s)"] == [{"lvgl.page.show": "setup"}]
    assert names["binary_sensor taste: on_release"] == [{"lvgl.widget.show": "info"}]


# --- the structural patcher, fuzzed ---------------------------------------------------

def _mutate(rng: random.Random, value) -> None:
    spots = []

    def collect(node):
        if isinstance(node, (dict, list)) and node:
            spots.append(node)
            for child in (node.values() if isinstance(node, dict) else node):
                collect(child)

    collect(value)
    target = rng.choice(spots)
    kind = rng.choice(["scalar", "delete", "add", "reorder", "lambda"])
    if isinstance(target, dict):
        key = rng.choice(list(target))
        if kind == "scalar":
            target[key] = rng.choice([42, "neu", True, "TR0\nNEXT", "a: b", ""])
        elif kind == "delete" and len(target) > 1:
            del target[key]
        elif kind == "add":
            target[f"fuzz_{rng.randint(0, 999)}"] = rng.choice([1, "x", [1, 2], {"a": 1}])
        elif kind == "lambda":
            target[key] = TaggedScalar("return 1;", "!lambda")
    else:
        index = rng.randrange(len(target))
        if kind == "delete" and len(target) > 1:
            del target[index]
        elif kind == "add":
            target.insert(rng.randrange(len(target) + 1), {"label": {"id": f"f{rng.randint(0, 9999)}"}})
        elif kind == "reorder" and len(target) > 1:
            other = rng.randrange(len(target))
            target[index], target[other] = target[other], target[index]


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_random_edits_are_always_applied_exactly(seed: int) -> None:
    lines = FIXTURE.read_text(encoding="utf-8").splitlines(keepends=True)
    start, end = _find_top_level_block(lines, "lvgl")
    block = lines[start:end]
    original = load_lvgl_yaml("".join(block))["lvgl"]
    rng = random.Random(seed)

    assert patch_top_level_block(block, "lvgl", copy.deepcopy(original)) == block
    for _ in range(25):
        value = copy.deepcopy(original)
        for _ in range(rng.randint(1, 3)):
            _mutate(rng, value)
        patched = patch_top_level_block(block, "lvgl", value)
        if patched is None:
            continue  # a safe full rewrite - allowed, just rare
        target = load_lvgl_yaml("".join(_dump({"lvgl": value})))["lvgl"]
        assert same_yaml_value(load_lvgl_yaml("".join(patched))["lvgl"], target)


# --- device bindings edit only their entity ------------------------------------------

def test_a_device_binding_leaves_the_rest_of_its_domain_untouched(tmp_path: Path) -> None:
    source = """\
switch:
  - platform: template
    id: relay
    turn_on_action:
      # bleibt stehen
      - logger.log: "an"
  - platform: template
    id: board_detected
    optimistic: true
lvgl:
  widgets:
    - label:
        id: status
        text: "?"
"""
    service = DesignerService(tmp_path)
    payload = json.loads(json.dumps(service.import_yaml(source)["project"]))
    payload["bindings"].append({
        "id": "board_status", "kind": "custom_yaml", "origin": "created",
        "direction": "entity_to_widget",
        "source": {"domain": "switch", "id": "board_detected"},
        "target": {"widget_id": "status", "property": "value"},
        "raw_action": {"lvgl.label.update": {"id": "status", "text": "Board da"}},
        "raw_yaml": "lvgl.label.update:\n  id: status\n  text: Board da",
        "read_only": False, "deleted": False,
    })
    project, _issues = service.validate(payload)

    merged = merge_project_into_yaml(project, source)

    assert "switch" in merged.replaced_keys
    assert merged.content.endswith("lvgl:" + source.split("lvgl:")[1])
    # Only the bound entity grows; the comment and the quoting elsewhere stay,
    # and the new list is indented the way the file indents lists.
    assert merged.content.startswith(source.split("lvgl:")[0].split("    optimistic: true\n")[0])
    assert ("    optimistic: true\n    on_state:\n      then:\n        - lvgl.label.update:\n"
            "            id: status\n            text: Board da\n") in merged.content
