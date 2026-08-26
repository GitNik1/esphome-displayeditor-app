"""Typed ESPHome entity/widget bindings and automation compilation.

Bindings deliberately live in the designer project while entity definitions
remain in the user's ESPHome YAML.  The compiler has two outputs: widget
events that become part of the generated ``lvgl:`` tree and entity trigger
actions that are merged into the matching component by id.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

import yaml

from .binding_formats import compile_numeric_binding_format, validate_binding_format
from .designer_core.model import Project
from .designer_core.yamlimport import LvglImportError, TaggedScalar, load_lvgl_yaml

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
    "animimg": {
        "inputs": ["visible", "opacity", "flow_direction"],
        "outputs": ["click"],
    },
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

WIDGET_INPUT_DATA_TYPES: dict[str, set[str]] = {
    "text": {"text", "choice", "number", "boolean"},
    "selected": {"choice", "number"},
    "checked": {"boolean", "light", "fan", "lock", "alarm"},
    "visible": {"boolean", "number", "light", "fan", "lock", "alarm"},
    "value": {"number"},
    "indicator_value": {"number"},
    "indicator_start": {"number"},
    "indicator_end": {"number"},
    "flow_direction": {"number"},
}


def widget_input_accepts(property_name: str, entity_data_type: str) -> bool:
    """Apply the same data-type rule used by binding validation."""
    accepted = WIDGET_INPUT_DATA_TYPES.get(property_name)
    return accepted is None or entity_data_type in accepted


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
        if binding.get("kind") in {"opaque_yaml", "custom_yaml"}:
            if not isinstance(binding.get("raw_action"), dict):
                issues.append(
                    BindingIssue(
                        "error", "Imported binding has no YAML action.", binding_id
                    )
                )
            continue
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
                if not widget_input_accepts(prop, str(entity.get("data_type", ""))):
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
        if prop == "flow_direction":
            reverse_id = str(widget_side.get("reverse_widget_id", ""))
            reverse = widgets.get(reverse_id)
            if not reverse or reverse.widget_type != "animimg":
                issues.append(
                    BindingIssue(
                        "error",
                        "Flow-direction binding requires the reverse animation widget.",
                        binding_id,
                    )
                )
        if direction == "bidirectional":
            if (
                not entity
                or not entity.get("readable")
                or not entity.get("writable")
            ):
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
        elif prop == "text" and entity and entity.get("data_type") == "number":
            try:
                validate_binding_format(transform.get("format", "{value}"))
            except ValueError as exc:
                issues.append(BindingIssue("error", str(exc), binding_id))
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


def _cpp_float(value: int | float) -> str:
    """Render a valid C++ floating-point literal with an ``f`` suffix."""
    rendered = f"{float(value):g}"
    if "." not in rendered and "e" not in rendered.lower():
        rendered += ".0"
    return f"{rendered}f"


def _lambda_value(transform: dict[str, Any], expression: str = "x") -> str:
    factor = float(transform.get("factor", 1) or 1)
    offset = float(transform.get("offset", 0) or 0)
    input_min, input_max = transform.get("input_min"), transform.get("input_max")
    output_min, output_max = transform.get("output_min"), transform.get("output_max")
    code = f"float value = float({expression}); value = value * {_cpp_float(factor)} + {_cpp_float(offset)};"
    if (
        all(
            isinstance(v, (int, float))
            for v in (input_min, input_max, output_min, output_max)
        )
        and input_max != input_min
    ):
        code += f" value = {_cpp_float(output_min)} + (value - {_cpp_float(input_min)}) * {_cpp_float(output_max - output_min)} / {_cpp_float(input_max - input_min)};"
    if transform.get("clamp"):
        low = (
            output_min if isinstance(output_min, (int, float)) else transform.get("min")
        )
        high = (
            output_max if isinstance(output_max, (int, float)) else transform.get("max")
        )
        if isinstance(low, (int, float)) and isinstance(high, (int, float)):
            code += f" value = std::max({_cpp_float(low)}, std::min({_cpp_float(high)}, value));"
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
    if prop == "flow_direction":
        reverse_id = str(target.get("reverse_widget_id", ""))
        off = max(0, int(float(transform.get("off_threshold", 0) or 0)))
        fast = max(off + 1, int(float(transform.get("fast_threshold", 1000) or 1000)))
        normal_ms = max(10, int(float(transform.get("normal_duration", 900) or 900)))
        fast_ms = max(10, int(float(transform.get("fast_duration", 300) or 300)))

        def speed_branch(animation_id: str) -> list[dict[str, Any]]:
            return [
                {"lvgl.animimg.start": animation_id},
                {
                    "if": {
                        "condition": {
                            "lambda": {
                                "__esphome_lambda__": f"return abs((int)x) >= {fast};"
                            }
                        },
                        "then": [
                            {
                                "lvgl.animimg.update": {
                                    "id": animation_id,
                                    "duration": f"{fast_ms}ms",
                                }
                            }
                        ],
                        "else": [
                            {
                                "lvgl.animimg.update": {
                                    "id": animation_id,
                                    "duration": f"{normal_ms}ms",
                                }
                            }
                        ],
                    }
                },
            ]

        action = {
            "if": {
                "condition": {
                    "lambda": {
                        "__esphome_lambda__": f"return abs((int)x) <= {off};"
                    }
                },
                "then": [
                    {"lvgl.widget.hide": target_id},
                    {"lvgl.widget.hide": reverse_id},
                ],
                "else": [
                    {
                        "if": {
                            "condition": {
                                "lambda": {"__esphome_lambda__": "return x > 0;"}
                            },
                            "then": [
                                {"lvgl.widget.hide": reverse_id},
                                {"lvgl.widget.show": target_id},
                                *speed_branch(str(target_id)),
                            ],
                            "else": [
                                {"lvgl.widget.hide": target_id},
                                {"lvgl.widget.show": reverse_id},
                                *speed_branch(reverse_id),
                            ],
                        }
                    }
                ],
            }
        }
        return _with_conditions(action, binding)
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
            fmt = compile_numeric_binding_format(template)
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
        if binding.get("kind") in {"opaque_yaml", "custom_yaml"}:
            source = binding.get("source", {})
            result.entity_actions.append(
                {
                    "binding_id": binding["id"],
                    "domain": source.get("domain", ""),
                    "entity_id": source.get("id", ""),
                    "trigger": source.get("trigger", "on_state"),
                    "action": copy.deepcopy(binding["raw_action"]),
                    "opaque": True,
                    "deleted": bool(binding.get("deleted")),
                }
            )
            continue
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


def _contains_lvgl_action(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            str(key).startswith("lvgl.") or _contains_lvgl_action(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_lvgl_action(child) for child in value)
    return False


def _first_lvgl_target(value: Any) -> str:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).startswith("lvgl."):
                if isinstance(child, str):
                    return child
                if isinstance(child, list) and child and isinstance(child[0], str):
                    return child[0]
                if isinstance(child, dict) and isinstance(child.get("id"), str):
                    return child["id"]
            target = _first_lvgl_target(child)
            if target:
                return target
    elif isinstance(value, list):
        for child in value:
            target = _first_lvgl_target(child)
            if target:
                return target
    return ""


def _trigger_actions(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        then = value.get("then")
        return [item for item in then if isinstance(item, dict)] if isinstance(then, list) else []
    if not isinstance(value, list):
        return []
    if value and all(isinstance(item, dict) and "then" in item for item in value):
        result: list[dict[str, Any]] = []
        for automation in value:
            result.extend(_trigger_actions(automation))
        return result
    return [item for item in value if isinstance(item, dict)]


def _portable_yaml_value(value: Any) -> Any:
    if isinstance(value, TaggedScalar):
        if value.tag == "!lambda":
            return {"__esphome_lambda__": str(value)}
        return {"__esphome_tag__": value.tag, "value": str(value)}
    if isinstance(value, dict):
        return {key: _portable_yaml_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_portable_yaml_value(child) for child in value]
    return value


def _materialize_portable_yaml(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"__esphome_lambda__"}:
            return TaggedScalar(str(value["__esphome_lambda__"]), "!lambda")
        if set(value) == {"__esphome_tag__", "value"}:
            return TaggedScalar(str(value["value"]), str(value["__esphome_tag__"]))
        return {key: _materialize_portable_yaml(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_materialize_portable_yaml(child) for child in value]
    return value


class _CustomYamlDumper(yaml.SafeDumper):
    pass


def _represent_custom_tag(dumper: yaml.Dumper, value: TaggedScalar):
    return dumper.represent_scalar(
        value.tag or "tag:yaml.org,2002:str",
        str(value),
        style="|" if "\n" in str(value) else None,
    )


_CustomYamlDumper.add_representer(TaggedScalar, _represent_custom_tag)


def dump_custom_binding_yaml(action: dict[str, Any]) -> str:
    return yaml.dump(
        _materialize_portable_yaml(action),
        Dumper=_CustomYamlDumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    ).rstrip()


def parse_custom_binding_yaml(text: str) -> tuple[dict[str, Any], str]:
    try:
        action = load_lvgl_yaml(text)
    except LvglImportError:
        raise
    if len(action) != 1:
        raise LvglImportError("A custom binding must contain exactly one top-level action.")
    portable = _portable_yaml_value(action)
    return portable, dump_custom_binding_yaml(portable)


def extract_imported_bindings(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract non-destructively round-trippable LVGL entity automations."""
    imported: list[dict[str, Any]] = []
    for domain in ENTITY_CAPABILITIES:
        entries = document.get(domain)
        if isinstance(entries, dict):
            entries = [entries]
        if not isinstance(entries, list):
            continue
        for entity in entries:
            if not isinstance(entity, dict) or not isinstance(entity.get("id"), str):
                continue
            for trigger, body in entity.items():
                if not str(trigger).startswith("on_"):
                    continue
                for index, action in enumerate(_trigger_actions(body)):
                    if not _contains_lvgl_action(action):
                        continue
                    identity = json.dumps(
                        [domain, entity["id"], trigger, index, action],
                        sort_keys=True,
                        separators=(",", ":"),
                        default=str,
                    )
                    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
                    portable_action = _portable_yaml_value(action)
                    imported.append(
                        {
                            "id": f"imported_{digest}",
                            "kind": "custom_yaml",
                            "origin": "imported",
                            "direction": "entity_to_widget",
                            "source": {
                                "domain": domain,
                                "id": entity["id"],
                                "trigger": str(trigger),
                            },
                            "target": {
                                "widget_id": _first_lvgl_target(action),
                                "property": "imported_yaml",
                            },
                            "raw_action": portable_action,
                            "raw_yaml": dump_custom_binding_yaml(portable_action),
                            "original_action": copy.deepcopy(portable_action),
                            "original_yaml": dump_custom_binding_yaml(portable_action),
                            "read_only": False,
                            "deleted": False,
                        }
                    )
    return imported
