from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.designer import DesignerService
from backend.designer_core.yamlimport import LvglImportError, load_lvgl_yaml
from backend.settings import Settings
from backend.viewer_scenarios import normalise_viewer_scenarios, parse_viewer_scenarios

from .test_designer import project_with_button
from .test_project_store import make_store

SCENARIOS = """\
# Board detected - in the device, an interval lambda reads this over SPI.
- name: Board erkannt
  actions:
    - lvgl.label.update: {id: version_label, text: "1.0.18", bg_color: 0x00FF00}
    - lvgl.widget.show: [start_button, stop_button]
- name: Ergebnis
  actions:
    - lvgl.page.show: result_page
    - lambda: !lambda return;
"""


def test_scenarios_parse_into_viewer_actions() -> None:
    scenarios = parse_viewer_scenarios(SCENARIOS)

    assert [s["name"] for s in scenarios] == ["Board erkannt", "Ergebnis"]
    assert scenarios[0]["actions"][0] == {"lvgl.label.update": {
        "id": "version_label", "text": "1.0.18", "bg_color": "0x00FF00"}}
    assert scenarios[0]["actions"][1] == {"lvgl.widget.show": ["start_button", "stop_button"]}
    # Tags take the portable form the rest of the payload uses.
    assert scenarios[1]["actions"][1] == {"lambda": {"__esphome_lambda__": "return;"}}


def test_an_empty_text_means_no_scenarios() -> None:
    assert parse_viewer_scenarios("  \n# nothing yet\n") == []


@pytest.mark.parametrize(("text", "message"), [
    ("name: x", "YAML list"),
    ("- actions: [{lvgl.page.next: {}}]", "needs a 'name:'"),
    ("- name: x\n  actions: 5", "must be a list"),
    ("- name: x\n  actions: [{a: 1, b: 2}]", "action 1"),
    ("- name: [unclosed", "not valid YAML"),
])
def test_malformed_scenarios_name_the_problem(text: str, message: str) -> None:
    with pytest.raises(LvglImportError, match=message):
        parse_viewer_scenarios(text)


def test_unusable_stored_values_are_dropped_not_fatal() -> None:
    empty = {"yaml": "", "scenarios": [], "suggestions": ""}
    assert normalise_viewer_scenarios(None) == empty
    assert normalise_viewer_scenarios({"yaml": 3}) == empty
    assert normalise_viewer_scenarios({"yaml": "x", "scenarios": "y", "suggestions": 1}) == {
        "yaml": "x", "scenarios": [], "suggestions": ""}


def test_scenarios_are_saved_and_read_back_with_the_project(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    project = project_with_button()
    scenarios = parse_viewer_scenarios(SCENARIOS)
    project["viewer_scenarios"] = {"yaml": SCENARIOS, "scenarios": scenarios, "suggestions": "- name: s"}

    store.save("display.lvgldesign", project, None)
    loaded = store.read("display.lvgldesign")["project"]

    assert loaded["viewer_scenarios"] == {
        "yaml": SCENARIOS, "scenarios": scenarios, "suggestions": "- name: s"}


def test_scenarios_are_never_exported(tmp_path: Path) -> None:
    project = project_with_button()
    project["viewer_scenarios"] = {"yaml": SCENARIOS, "scenarios": parse_viewer_scenarios(SCENARIOS)}

    exported = DesignerService(tmp_path).export_yaml(project)["yaml"]

    assert "Board erkannt" not in exported and "version_label" not in exported


def test_validate_endpoint(tmp_path: Path) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    settings = Settings(
        access_level="write", max_file_size=1024 * 1024, protect_sensitive_paths=True,
        config_root=config_root, data_root=tmp_path / "data", default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False))

    ok = client.post("/api/v1/designer/viewer-scenarios/validate", json={"content": SCENARIOS})
    bad = client.post("/api/v1/designer/viewer-scenarios/validate", json={"content": "name: x"})

    assert ok.status_code == 200 and len(ok.json()["scenarios"]) == 2
    assert bad.status_code == 422


# --- triggers and transition tables ----------------------------------------------

def test_triggers_and_transition_tables_parse() -> None:
    scenarios = parse_viewer_scenarios("""\
- name: AUTO
- name: TR0
  actions:
    - lvgl.label.update: {id: next_label, text: "TR0"}
- name: Eingang NEXT
  on:
    state_machine.transition: NEXT
  transitions: {AUTO: TR0, TR0: AUTO}
  initial: AUTO
- name: Script
  on: script.execute
  actions:
    - lvgl.page.next: {}
""")

    by_name = {s["name"]: s for s in scenarios}
    assert by_name["AUTO"]["actions"] == []
    assert by_name["Eingang NEXT"]["on"] == {"name": "state_machine.transition", "payload": "NEXT"}
    assert by_name["Eingang NEXT"]["transitions"] == {"AUTO": "TR0", "TR0": "AUTO"}
    assert by_name["Script"]["on"] == {"name": "script.execute", "payload": None}


@pytest.mark.parametrize(("text", "message"), [
    ("- name: a\n- name: a", "unique"),
    ("- name: a\n  on: x\n  transitions: {a: b}", "unknown scenario"),
    ("- name: a\n  transitions: {a: a}", "needs an 'on:'"),
    ("- name: a\n  colour: red", "unknown key"),
])
def test_inconsistent_tables_are_rejected(text: str, message: str) -> None:
    with pytest.raises(LvglImportError, match=message):
        parse_viewer_scenarios(text)


# --- suggestions -----------------------------------------------------------------

CONFIG = """\
esphome:
  name: tester
  on_boot:
    then:
      - script.execute: wake
switch:
  - platform: template
    id: board_detected
    turn_on_action:
      - lvgl.widget.show: start_button
    turn_off_action:
      - lvgl.widget.hide: start_button
  - platform: template
    id: relay
    turn_on_action:
      - logger.log: "no display change"
script:
  - id: wake
    then:
      - switch.turn_on: board_detected
state_machine:
  - name: Ablauf
    initial_state: AUTO
    states:
      - name: AUTO
        on_enter:
          - lvgl.label.update: {id: next_label, text: START}
      - name: TR0
        on_enter:
          - lvgl.label.update: {id: next_label, text: "TR0"}
    inputs:
      - name: NEXT
        transitions:
          - AUTO -> TR0
          - TR0 -> AUTO
lvgl:
  widgets:
    - button: {id: start_button}
    - label: {id: next_label}
"""


def test_suggestions_cover_display_changing_automations() -> None:
    import backend.lvgl_merge  # noqa: F401 - registers the !lambda representer
    from backend.viewer_scenario_suggestions import suggest_viewer_scenarios_yaml

    text = suggest_viewer_scenarios_yaml(load_lvgl_yaml(CONFIG), "tester.yaml")
    scenarios = {s["name"]: s for s in parse_viewer_scenarios(text)}

    assert text.startswith("# Vorschläge aus tester.yaml")
    assert scenarios["Eingang NEXT"]["transitions"] == {"AUTO": "TR0", "TR0": "AUTO"}
    assert scenarios["Eingang NEXT"]["initial"] == "AUTO"
    assert scenarios["switch board_detected: turn_on_action"]["on"] == {
        "name": "switch.turn_on", "payload": "board_detected"}
    # Kept because it switches a switch that changes the display.
    assert scenarios["script wake"]["on"] == {"name": "script.execute", "payload": "wake"}
    assert "esphome tester: on_boot" in scenarios
    # No display change anywhere down the line: not suggested.
    assert not any("relay" in name for name in scenarios)


def test_import_offers_the_suggestions(tmp_path: Path) -> None:
    imported = DesignerService(tmp_path).import_yaml(CONFIG, source_name="tester.yaml")

    stored = imported["project"]["viewer_scenarios"]
    assert stored["yaml"] == "" and stored["scenarios"] == []
    assert "Eingang NEXT" in stored["suggestions"]
