from __future__ import annotations

import yaml

from backend.designer_core.model import Project, WidgetNode
from backend.designer import DesignerService
from backend.designer_core.yamlimport import load_lvgl_yaml
from backend.entity_bindings import (
    compile_bindings,
    discover_entities,
    validate_project_bindings,
)
from backend.lvgl_merge import merge_project_into_yaml
from backend.project_store import ProjectStore


def meter() -> WidgetNode:
    return WidgetNode(
        id="temperature_meter",
        widget_type="meter",
        width=120,
        height=120,
        properties={
            "scales": [
                {
                    "range_from": 0,
                    "range_to": 100,
                    "indicators": [
                        {"line": {"id": "temperature_needle", "value": 0, "width": 3}},
                    ],
                }
            ]
        },
    )


def test_import_discovers_all_supported_entity_domains(tmp_path) -> None:
    text = """
sensor:
  - platform: template
    id: temperature
    name: Temperature
    unit_of_measurement: °C
switch:
  - platform: template
    id: heater
select:
  - platform: template
    id: mode
lvgl:
  widgets: []
"""
    imported = DesignerService(tmp_path).import_yaml(text)["project"]
    assert [(e["domain"], e["id"]) for e in imported["entities"]] == [
        ("select", "mode"),
        ("sensor", "temperature"),
        ("switch", "heater"),
    ]
    sensor = next(e for e in imported["entities"] if e["id"] == "temperature")
    assert sensor["data_type"] == "number"
    assert sensor["unit"] == "°C"
    assert sensor["readable"] is True and sensor["writable"] is False


def test_catalog_finds_nested_platform_entities() -> None:
    document = yaml.safe_load("""
sensor:
  - platform: dht
    temperature:
      id: room_temperature
    humidity:
      id: room_humidity
""")
    assert {e["id"] for e in discover_entities(document)} == {
        "room_temperature",
        "room_humidity",
    }


def test_catalog_ignores_ids_referenced_inside_automations() -> None:
    document = load_lvgl_yaml("""
sensor:
  - platform: template
    id: temperature
    on_value:
      then:
        - lvgl.indicator.update:
            id: temperature_needle
            value: !lambda return int(x);
""")
    assert [entity["id"] for entity in discover_entities(document)] == ["temperature"]


def test_validates_missing_entity_widget_capability_and_meter_indicator() -> None:
    project = Project(widgets=[meter()])
    project.entities = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project.bindings = [
        {
            "id": "bad",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {
                "widget_id": "temperature_meter",
                "property": "indicator_value",
                "indicator_id": "missing",
            },
        }
    ]
    assert any(
        "indicator" in issue.message.lower()
        for issue in validate_project_bindings(project)
    )


def test_compiles_widget_to_actor_and_bidirectional_events() -> None:
    switch_widget = WidgetNode(
        id="heater_switch", widget_type="switch", width=50, height=25
    )
    project = Project(widgets=[switch_widget])
    project.entities = [
        {
            "domain": "switch",
            "id": "heater",
            "readable": True,
            "writable": True,
            "data_type": "boolean",
            "trigger": "on_state",
            "commands": ["turn_on", "turn_off", "toggle"],
        }
    ]
    project.bindings = [
        {
            "id": "heater_binding",
            "direction": "bidirectional",
            "source": {"domain": "switch", "id": "heater", "command": "toggle"},
            "target": {
                "widget_id": "heater_switch",
                "property": "checked",
                "event": "value",
            },
        }
    ]
    compiled = compile_bindings(project)
    assert compiled.issues == []
    assert compiled.entity_actions[0]["trigger"] == "on_state"
    assert compiled.project.widgets[0].events["on_value"] == [
        {"switch.toggle": "heater"}
    ]


def test_merge_adds_sensor_binding_preserves_actions_and_is_idempotent() -> None:
    existing = """esphome:
  name: panel
sensor:
  - platform: template
    id: temperature
    on_value:
      then:
        - logger.log: existing
lvgl:
  widgets: []
"""
    project = Project(widgets=[meter()])
    project.entities = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project.bindings = [
        {
            "id": "temperature_binding",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {
                "widget_id": "temperature_meter",
                "property": "indicator_value",
                "indicator_id": "temperature_needle",
            },
            "transform": {
                "input_min": 0,
                "input_max": 50,
                "output_min": 0,
                "output_max": 100,
                "clamp": True,
                "round": 0,
            },
        }
    ]
    first = merge_project_into_yaml(project, existing)
    second = merge_project_into_yaml(project, first.content)
    assert first.content == second.content
    parsed = load_lvgl_yaml(first.content)
    actions = parsed["sensor"][0]["on_value"]["then"]
    assert actions[0] == {"logger.log": "existing"}
    assert sum("lvgl.indicator.update" in action for action in actions) == 1
    assert "sensor" in first.replaced_keys


def test_changed_conditional_binding_replaces_previous_nested_target() -> None:
    existing = (
        "sensor:\n- platform: template\n  id: temperature\nlvgl:\n  widgets: []\n"
    )
    project = Project(widgets=[meter()])
    project.entities = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    binding = {
        "id": "visibility",
        "direction": "entity_to_widget",
        "source": {"domain": "sensor", "id": "temperature"},
        "target": {"widget_id": "temperature_meter", "property": "visible"},
        "conditions": [{"operator": "gte", "value": 20}],
    }
    project.bindings = [binding]
    first = merge_project_into_yaml(project, existing).content
    binding["conditions"][0]["value"] = 30
    second = merge_project_into_yaml(project, first).content
    actions = load_lvgl_yaml(second)["sensor"][0]["on_value"]["then"]
    assert len(actions) == 1
    assert "x >= 30" in str(actions[0])


def test_transform_generates_scaling_clamping_and_rounding_lambda() -> None:
    project = Project(widgets=[meter()])
    project.entities = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project.bindings = [
        {
            "id": "scaled",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {
                "widget_id": "temperature_meter",
                "property": "indicator_value",
                "indicator_id": "temperature_needle",
            },
            "transform": {
                "input_min": -20,
                "input_max": 80,
                "output_min": 0,
                "output_max": 100,
                "clamp": True,
            },
        }
    ]
    action = compile_bindings(project).entity_actions[0]["action"]
    code = action["lvgl.indicator.update"]["value"]["__esphome_lambda__"]
    assert "std::max" in code and "std::round" in code and "100f / 100f" in code


def test_project_store_round_trips_addon_entity_catalog_and_bindings(tmp_path) -> None:
    service = DesignerService(tmp_path)
    payload = service.project_payload(Project(widgets=[meter()]))
    payload["entities"] = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    payload["bindings"] = [
        {
            "id": "temperature_binding",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {
                "widget_id": "temperature_meter",
                "property": "indicator_value",
                "indicator_id": "temperature_needle",
            },
        }
    ]
    store = ProjectStore(tmp_path, service, 1024 * 1024)
    store.save("panel.lvgldesign", payload, None)
    restored = store.read("panel.lvgldesign")["project"]
    assert restored["entities"] == payload["entities"]
    assert restored["bindings"] == payload["bindings"]


def test_conditions_compile_to_guarded_update() -> None:
    project = Project(widgets=[meter()])
    project.entities = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project.bindings = [
        {
            "id": "warning",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {"widget_id": "temperature_meter", "property": "visible"},
            "conditions": [
                {"operator": "gte", "value": 30},
                {"operator": "lt", "value": 80},
            ],
        }
    ]
    action = compile_bindings(project).entity_actions[0]["action"]
    assert "if" in action
    condition = action["if"]["condition"]["lambda"]["__esphome_lambda__"]
    assert "x >= 30" in condition and "x < 80" in condition


def test_all_actor_domains_compile_an_allowlisted_command() -> None:
    cases = {
        "switch": "toggle",
        "light": "brightness",
        "number": "set",
        "select": "set",
        "button": "press",
        "fan": "speed",
        "cover": "position",
        "climate": "target_temperature",
        "lock": "lock",
        "media_player": "volume",
        "alarm_control_panel": "arm_away",
        "script": "execute",
    }
    for domain, command in cases.items():
        widget = WidgetNode(id="control", widget_type="button", width=80, height=30)
        project = Project(widgets=[widget])
        project.entities = [
            {
                "domain": domain,
                "id": "target",
                "readable": domain != "button",
                "writable": True,
                "data_type": "event",
                "trigger": "on_state",
                "commands": [command],
            }
        ]
        project.bindings = [
            {
                "id": f"bind_{domain}",
                "direction": "widget_to_entity",
                "source": {"widget_id": "control", "event": "click"},
                "target": {"domain": domain, "id": "target", "command": command},
            }
        ]
        compiled = compile_bindings(project)
        assert compiled.issues == [], (domain, compiled.issues)
        assert compiled.project.widgets[0].events["on_click"], domain
