"""Typed ESPHome entity/widget bindings and automation compilation.

Bindings deliberately live in the designer project while entity definitions
remain in the user's ESPHome YAML.  The compiler has two outputs: widget
events that become part of the generated ``lvgl:`` tree and entity trigger
actions that are merged into the matching component by id.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .designer_core.model import Project

ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

ENTITY_CAPABILITIES: dict[str, dict[str, Any]] = {
    "sensor": {"type": "number", "read": "on_value", "commands": []},
    "binary_sensor": {"type": "boolean", "read": "on_state", "commands": []},
    "text_sensor": {"type": "text", "read": "on_value", "commands": []},
    "switch": {
        "type": "boolean",
        "read": "on_state",
        "commands": ["set_state", "turn_on", "turn_off", "toggle"],
    },
    "light": {
        "type": "light",
        "read": "on_state",
        "commands": ["set_state", "turn_on", "turn_off", "toggle", "brightness"],
    },
    "number": {"type": "number", "read": "on_value", "commands": ["set"]},
    "select": {
        "type": "choice",
        "read": "on_value",
        "commands": ["set", "next", "previous"],
    },
    "button": {"type": "event", "read": None, "commands": ["press"]},
    "fan": {
        "type": "fan",
        "read": "on_state",
        "commands": ["set_state", "turn_on", "turn_off", "toggle", "speed"],
    },
    "cover": {
        "type": "cover",
        "read": "on_state",
        "commands": ["open", "close", "stop", "toggle", "position"],
    },
    "climate": {
        "type": "climate",
        "read": "on_state",
        "commands": ["mode", "target_temperature"],
    },
    "lock": {
        "type": "lock",
        "read": "on_state",
        "commands": ["lock", "unlock", "open"],
    },
    "media_player": {
        "type": "media",
        "read": "on_state",
        "commands": ["play", "pause", "stop", "toggle", "volume"],
    },
    "alarm_control_panel": {
        "type": "alarm",
        "read": "on_state",
        "commands": ["arm_away", "arm_home", "arm_night", "disarm", "trigger"],
    },
    "script": {"type": "event", "read": None, "commands": ["execute", "stop"]},
}

WIDGET_CAPABILITIES: dict[str, dict[str, list[str]]] = {
    "label": {"inputs": ["text", "visible", "opacity", "color"], "outputs": ["click"]},
    "textarea": {"inputs": ["text", "visible"], "outputs": ["value"]},
    "meter": {
        "inputs": [
            "indicator_value",
            "indicator_start",
            "indicator_end",
            "visible",
            "opacity",
        ],
        "outputs": [],
    },
    "bar": {"inputs": ["value", "visible", "opacity", "color"], "outputs": []},
    "led": {"inputs": ["value", "visible", "opacity", "color"], "outputs": ["click"]},
    "image": {"inputs": ["image", "visible", "opacity"], "outputs": ["click"]},
    "animimg": {"inputs": ["visible", "opacity"], "outputs": ["click"]},
    "button": {
        "inputs": ["text", "checked", "visible", "opacity", "color"],
        "outputs": ["click", "press", "release", "value"],
    },
    "switch": {"inputs": ["checked", "visible"], "outputs": ["value"]},
    "checkbox": {"inputs": ["checked", "text", "visible"], "outputs": ["value"]},
    "slider": {"inputs": ["value", "visible"], "outputs": ["value", "release"]},
    "arc": {"inputs": ["value", "visible", "color"], "outputs": ["value", "release"]},
    "dropdown": {"inputs": ["selected", "visible"], "outputs": ["value"]},
    "roller": {"inputs": ["selected", "visible"], "outputs": ["value"]},
    "spinbox": {"inputs": ["value", "visible"], "outputs": ["value"]},
    "qrcode": {"inputs": ["text", "visible"], "outputs": ["click"]},
    "tabview": {"inputs": ["selected", "visible"], "outputs": ["value"]},
    "tileview": {"inputs": ["selected", "visible"], "outputs": ["value"]},
    "obj": {
        "inputs": ["visible", "opacity", "color"],
        "outputs": ["click", "press", "release"],
    },
    "container": {
        "inputs": ["visible", "opacity", "color"],
        "outputs": ["click", "press", "release"],
    },
}


@dataclass
class BindingIssue:
    severity: str
    message: str
    binding_id: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "message": self.message,
            "binding": self.binding_id,
        }


@dataclass
class CompiledBindings:
    project: Project
    entity_actions: list[dict[str, Any]] = field(default_factory=list)
    issues: list[BindingIssue] = field(default_factory=list)


def discover_entities(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Build a stable catalog of id-bearing entities from supported domains."""
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def visit(value: Any, domain: str, path: str) -> None:
        if isinstance(value, dict):
            entity_id = value.get("id")
            if isinstance(entity_id, str) and ID_RE.fullmatch(entity_id):
                key = (domain, entity_id)
                if key not in seen:
                    cap = ENTITY_CAPABILITIES[domain]
                    found.append(
                        {
                            "domain": domain,
                            "id": entity_id,
                            "data_type": cap["type"],
                            "readable": bool(cap["read"]),
                            "writable": bool(cap["commands"]),
                            "trigger": cap["read"],
                            "commands": list(cap["commands"]),
                            "path": path,
                            "name": str(value.get("name", entity_id)),
                            "unit": str(value.get("unit_of_measurement", "")),
                        }
                    )
                    seen.add(key)
            for key, child in value.items():
                # IDs inside automations are references to widgets/actors,
                # never further entities belonging to this platform domain.
                if str(key).startswith("on_") or key in {
                    "then",
                    "else",
                    "condition",
                    "lambda",
                    "automation",
                }:
                    continue
                visit(child, domain, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, domain, f"{path}[{index}]")

    for domain in ENTITY_CAPABILITIES:
        if domain in document:
            visit(document[domain], domain, domain)
    return sorted(found, key=lambda item: (item["domain"], item["id"]))


def _widget_index(project: Project) -> dict[str, Any]:
    return {widget.id: widget for widget in project.all_widgets()}


def _indicator_ids(widget: Any) -> set[str]:
    result: set[str] = set()
    for scale in widget.properties.get("scales", []) if widget else []:
        for entry in scale.get("indicators", []) if isinstance(scale, dict) else []:
            if isinstance(entry, dict):
                for payload in entry.values():
                    if isinstance(payload, dict) and isinstance(payload.get("id"), str):
                        result.add(payload["id"])
    return result


def validate_project_bindings(project: Project) -> list[BindingIssue]:
    issues: list[BindingIssue] = []
    project_entities = getattr(project, "entities", [])
    project_bindings = getattr(project, "bindings", [])
    entities = {
        (e.get("domain"), e.get("id")): e
        for e in project_entities
        if isinstance(e, dict)
    }
    widgets = _widget_index(project)
    seen: set[str] = set()
    if len(project_bindings) > 512:
        return [
            BindingIssue("error", "A project may contain at most 512 device bindings.")
        ]
    for index, binding in enumerate(project_bindings):
        binding_id = (
            str(binding.get("id", f"binding_{index}"))
            if isinstance(binding, dict)
            else f"binding_{index}"
        )
        if not isinstance(binding, dict):
            issues.append(
                BindingIssue("error", "Binding must be an object.", binding_id)
            )
            continue
        if not ID_RE.fullmatch(binding_id) or binding_id in seen:
            issues.append(
                BindingIssue(
                    "error", "Binding id is invalid or duplicated.", binding_id
                )
            )
        seen.add(binding_id)
        direction = binding.get("direction")
        if direction not in ("entity_to_widget", "widget_to_entity", "bidirectional"):
            issues.append(
                BindingIssue("error", "Unknown binding direction.", binding_id)
            )
            continue
        source, target = binding.get("source", {}), binding.get("target", {})
        entity_side = (
            source if direction in ("entity_to_widget", "bidirectional") else target
        )
        widget_side = (
            target if direction in ("entity_to_widget", "bidirectional") else source
        )
        entity = entities.get((entity_side.get("domain"), entity_side.get("id")))
        widget = widgets.get(widget_side.get("widget_id"))
        if not entity:
            issues.append(
                BindingIssue(
                    "error",
                    "Bound ESPHome entity does not exist in the imported configuration.",
                    binding_id,
                )
            )
        if not widget:
            issues.append(
                BindingIssue("error", "Bound widget does not exist.", binding_id)
            )
            continue
        prop = str(widget_side.get("property", widget_side.get("event", "")))
        caps = WIDGET_CAPABILITIES.get(
            widget.widget_type, {"inputs": [], "outputs": []}
        )
        required = (
            caps["inputs"]
            if direction in ("entity_to_widget", "bidirectional")
            else caps["outputs"]
        )
        if prop not in required:
            issues.append(
                BindingIssue(
                    "error",
                    f"Widget type '{widget.widget_type}' does not support binding '{prop}'.",
                    binding_id,
                )
            )
        if entity:
            if direction in ("widget_to_entity", "bidirectional"):
                command = str(entity_side.get("command", ""))
                if command not in entity.get("commands", []):
                    issues.append(
                        BindingIssue(
                            "error",
                            f"Entity '{entity_side.get('id')}' does not support command '{command}'.",
                            binding_id,
                        )
                    )
            if direction in ("entity_to_widget", "bidirectional"):
                allowed_types = {
                    "text": {"text", "choice", "number", "boolean"},
                    "selected": {"choice", "number"},
                    "checked": {"boolean", "light", "fan", "lock", "alarm"},
                    "visible": {"boolean", "number", "light", "fan", "lock", "alarm"},
                    "value": {"number"},
                    "indicator_value": {"number"},
                    "indicator_start": {"number"},
                    "indicator_end": {"number"},
                }
                accepted = allowed_types.get(prop)
                if accepted and entity.get("data_type") not in accepted:
                    issues.append(
                        BindingIssue(
                            "error",
                            f"Entity type '{entity.get('data_type')}' is incompatible with widget property '{prop}'.",
                            binding_id,
                        )
                    )
        if prop.startswith("indicator_"):
            indicator_id = widget_side.get("indicator_id")
            if indicator_id not in _indicator_ids(widget):
                issues.append(
                    BindingIssue(
                        "error", "Meter indicator id does not exist.", binding_id
                    )
                )
        if direction == "bidirectional":
            if not entity.get("readable") or not entity.get("writable"):
                issues.append(
                    BindingIssue(
                        "error",
                        "Bidirectional binding requires a readable and writable entity.",
                        binding_id,
                    )
                )
            output_event = str(widget_side.get("event", "value"))
            if output_event not in caps["outputs"]:
                issues.append(
                    BindingIssue(
                        "error",
                        f"Widget type '{widget.widget_type}' cannot emit '{output_event}'.",
                        binding_id,
                    )
                )
        transform = binding.get("transform", {})
        if transform is not None and not isinstance(transform, dict):
            issues.append(
                BindingIssue(
                    "error", "Binding transform must be an object.", binding_id
                )
            )
        conditions = binding.get("conditions", [])
        if not isinstance(conditions, list) or any(
            not isinstance(condition, dict)
            or condition.get("operator") not in {"eq", "ne", "gt", "gte", "lt", "lte"}
            for condition in conditions
        ):
            issues.append(
                BindingIssue("error", "Binding conditions are invalid.", binding_id)
            )
    return issues


def _lambda_value(transform: dict[str, Any], expression: str = "x") -> str:
    factor = float(transform.get("factor", 1) or 1)
    offset = float(transform.get("offset", 0) or 0)
    input_min, input_max = transform.get("input_min"), transform.get("input_max")
    output_min, output_max = transform.get("output_min"), transform.get("output_max")
    code = (
        f"float value = float({expression}); value = value * {factor:g}f + {offset:g}f;"
    )
    if (
        all(
            isinstance(v, (int, float))
            for v in (input_min, input_max, output_min, output_max)
        )
        and input_max != input_min
    ):
        code += f" value = {float(output_min):g}f + (value - {float(input_min):g}f) * {float(output_max - output_min):g}f / {float(input_max - input_min):g}f;"
    if transform.get("clamp"):
        low = (
            output_min if isinstance(output_min, (int, float)) else transform.get("min")
        )
        high = (
            output_max if isinstance(output_max, (int, float)) else transform.get("max")
        )
        if isinstance(low, (int, float)) and isinstance(high, (int, float)):
            code += f" value = std::max({float(low):g}f, std::min({float(high):g}f, value));"
    decimals = int(transform.get("round", 0) or 0)
    if decimals <= 0:
        code += " return int(std::round(value));"
    else:
        scale = 10 ** min(decimals, 6)
        code += f" return std::round(value * {scale}.0f) / {scale}.0f;"
    return code


def _incoming_action(
    binding: dict[str, Any], entity: dict[str, Any], widget: Any
) -> dict[str, Any]:
    target = binding["target"]
    prop = target.get("property")
    target_id = (
        target.get("indicator_id")
        if str(prop).startswith("indicator_")
        else target.get("widget_id")
    )
    transform = (
        binding.get("transform", {})
        if isinstance(binding.get("transform"), dict)
        else {}
    )
    if prop and str(prop).startswith("indicator_"):
        field = {
            "indicator_value": "value",
            "indicator_start": "start_value",
            "indicator_end": "end_value",
        }[prop]
        action = {
            "lvgl.indicator.update": {
                "id": target_id,
                field: {"__esphome_lambda__": _lambda_value(transform)},
            }
        }
        return _with_conditions(action, binding)
    if prop == "text":
        template = str(transform.get("format", "{value}"))
        # ESPHome's format/args form keeps numeric and textual sources typed.
        if entity.get("data_type") == "number":
            fmt = template.replace("{value}", "%.1f").replace("{state}", "%.1f")
            action = {
                "lvgl.label.update": {
                    "id": target_id,
                    "text": {
                        "format": fmt,
                        "args": [{"__esphome_lambda__": "return x;"}],
                    },
                }
            }
        else:
            action = {
                "lvgl.label.update": {
                    "id": target_id,
                    "text": {"__esphome_lambda__": "return x;"},
                }
            }
        return _with_conditions(action, binding)
    if prop == "value":
        action = {
            f"lvgl.{widget.widget_type}.update": {
                "id": target_id,
                "value": {"__esphome_lambda__": _lambda_value(transform)},
            }
        }
        return _with_conditions(action, binding)
    if prop == "selected":
        action = {
            f"lvgl.{widget.widget_type}.update": {
                "id": target_id,
                "selected_index": {"__esphome_lambda__": "return int(x);"},
            }
        }
        return _with_conditions(action, binding)
    if prop == "checked":
        action = {
            "lvgl.widget.update": {
                "id": target_id,
                "state": {"checked": {"__esphome_lambda__": "return x;"}},
            }
        }
        return _with_conditions(action, binding)
    if prop == "visible":
        action = {
            "if": {
                "condition": {"lambda": {"__esphome_lambda__": "return bool(x);"}},
                "then": [{"lvgl.widget.show": target_id}],
                "else": [{"lvgl.widget.hide": target_id}],
            }
        }
        return _with_conditions(action, binding)
    field = "opa" if prop == "opacity" else "bg_color"
    return _with_conditions(
        {
            "lvgl.widget.update": {
                "id": target_id,
                field: {"__esphome_lambda__": "return x;"},
            }
        },
        binding,
    )


def _with_conditions(action: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
    conditions = binding.get("conditions", [])
    if not isinstance(conditions, list) or not conditions:
        return action
    parts: list[str] = []
    operators = {"eq": "==", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        operator = operators.get(str(condition.get("operator")))
        if not operator:
            continue
        value = condition.get("value")
        literal = (
            "true"
            if value is True
            else "false"
            if value is False
            else json.dumps(value)
        )
        parts.append(f"x {operator} {literal}")
    if not parts:
        return action
    payload: dict[str, Any] = {
        "condition": {
            "lambda": {"__esphome_lambda__": f"return {' && '.join(parts)};"}
        },
        "then": [action],
    }
    fallback = binding.get("fallback")
    if isinstance(fallback, dict) and isinstance(fallback.get("action"), dict):
        payload["else"] = [fallback["action"]]
    return {"if": payload}


def _command_action(binding: dict[str, Any]) -> dict[str, Any]:
    target = binding["target"]
    domain, entity_id = str(target["domain"]), str(target["id"])
    command = str(target.get("command", "toggle"))
    if command == "set_state":
        return {
            "if": {
                "condition": {"lambda": {"__esphome_lambda__": "return bool(x);"}},
                "then": [{f"{domain}.turn_on": entity_id}],
                "else": [{f"{domain}.turn_off": entity_id}],
            }
        }
    action_names = {
        ("number", "set"): "number.set",
        ("select", "set"): "select.set",
        ("button", "press"): "button.press",
        ("script", "execute"): "script.execute",
        ("script", "stop"): "script.stop",
        ("cover", "open"): "cover.open",
        ("cover", "close"): "cover.close",
        ("cover", "stop"): "cover.stop",
        ("lock", "lock"): "lock.lock",
        ("lock", "unlock"): "lock.unlock",
    }
    name = action_names.get((domain, command), f"{domain}.{command}")
    control_actions = {
        ("light", "brightness"): ("light.turn_on", "brightness"),
        ("fan", "speed"): ("fan.turn_on", "speed"),
        ("cover", "position"): ("cover.control", "position"),
        ("climate", "mode"): ("climate.control", "mode"),
        ("climate", "target_temperature"): ("climate.control", "target_temperature"),
        ("media_player", "volume"): ("media_player.volume_set", "volume"),
    }
    if (domain, command) in control_actions:
        name, field = control_actions[(domain, command)]
        return {
            name: {
                "id": entity_id,
                field: {
                    "__esphome_lambda__": _lambda_value(binding.get("transform", {}))
                },
            }
        }
    if command in (
        "set",
        "brightness",
        "speed",
        "position",
        "volume",
        "target_temperature",
    ):
        field = {
            "set": "value" if domain == "number" else "option",
            "brightness": "brightness",
            "speed": "speed",
            "position": "position",
            "volume": "volume",
            "target_temperature": "target_temperature",
        }[command]
        return {
            name: {
                "id": entity_id,
                field: {
                    "__esphome_lambda__": _lambda_value(binding.get("transform", {}))
                },
            }
        }
    return {name: entity_id}


def compile_bindings(project: Project) -> CompiledBindings:
    result = CompiledBindings(project=copy.deepcopy(project))
    result.issues = validate_project_bindings(project)
    if any(issue.severity == "error" for issue in result.issues):
        return result
    entities = {(e["domain"], e["id"]): e for e in getattr(project, "entities", [])}
    widgets = _widget_index(result.project)
    for binding in getattr(project, "bindings", []):
        direction = binding["direction"]
        if direction in ("entity_to_widget", "bidirectional"):
            source = binding["source"]
            widget = widgets[binding["target"]["widget_id"]]
            entity = entities[(source["domain"], source["id"])]
            result.entity_actions.append(
                {
                    "binding_id": binding["id"],
                    "domain": source["domain"],
                    "entity_id": source["id"],
                    "trigger": source.get("event")
                    or entity.get("trigger")
                    or "on_state",
                    "action": _incoming_action(binding, entity, widget),
                }
            )
        if direction in ("widget_to_entity", "bidirectional"):
            if direction == "bidirectional":
                entity_side, source = binding["source"], binding["target"]
                command_binding = {
                    **binding,
                    "target": {
                        "domain": entity_side["domain"],
                        "id": entity_side["id"],
                        "command": entity_side.get("command", "set"),
                    },
                }
            else:
                source, command_binding = binding["source"], binding
            widget = widgets[source["widget_id"]]
            event = {
                "click": "on_click",
                "press": "on_press",
                "release": "on_release",
                "value": "on_value",
            }.get(source.get("event"), "on_value")
            widget.events.setdefault(event, [])
            widget.events[event].append(_command_action(command_binding))
    return result


def binding_schemas() -> dict[str, Any]:
    return {
        "entities": copy.deepcopy(ENTITY_CAPABILITIES),
        "widgets": copy.deepcopy(WIDGET_CAPABILITIES),
    }
