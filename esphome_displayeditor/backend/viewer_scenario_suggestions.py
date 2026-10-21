"""Viewer scenarios suggested from the rest of an imported configuration.

The Viewer only sees ``lvgl:``. Much of what a display does at runtime is
triggered from elsewhere - a template switch's ``turn_on_action`` showing a
button, a script, a state machine's ``on_enter`` updating a label. This
module collects every such automation that (directly, or through another
collected automation) contains an ``lvgl.*`` action and turns it into a
scenario the user can review and adopt:

* template switch ``turn_on_action``/``turn_off_action`` -> ``on: switch.turn_on/off: id``
* ``button`` ``press_action``                           -> ``on: button.press: id``
* ``script:`` entries                                   -> ``on: script.execute: id``
* ``state_machine:`` (muxa/esphome-state-machine)       -> one scenario per state
  (its ``on_enter``) plus one per input with the transition table
* any other ``on_*``/``then`` automation                -> a scenario without trigger

What C++ does directly (``lv_label_set_text`` in a lambda) cannot be seen
here; those states stay hand-written.
"""

from __future__ import annotations

import re
from typing import Any

# Imported for its side effect: registers how tagged scalars (!lambda) dump.
from . import lvgl_merge  # noqa: F401
from .yaml_patch import _dump

#: Actions that hand control to another automation the suggestions cover.
_CALL_ACTIONS = {"switch.turn_on", "switch.turn_off", "switch.toggle",
                 "script.execute", "button.press", "state_machine.transition"}
_TRANSITION_RE = re.compile(r"^\s*(\S+)\s*->\s*(\S+)\s*$")


def _contains_lvgl(value: Any) -> bool:
    if isinstance(value, dict):
        return any(str(key).startswith("lvgl.") or _contains_lvgl(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_lvgl(item) for item in value)
    return False


def _calls(value: Any) -> set[tuple[str, str]]:
    """Every (action, target) handed to another automation, at any depth."""
    found: set[tuple[str, str]] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _CALL_ACTIONS:
                target = item.get("id") if isinstance(item, dict) else item
                if key == "state_machine.transition" and isinstance(item, dict):
                    target = item.get("input")
                found.add((str(key), str(target)))
            found |= _calls(item)
    elif isinstance(value, list):
        for item in value:
            found |= _calls(item)
    return found


def _is_action_list(value: Any) -> bool:
    return (isinstance(value, list) and bool(value)
            and all(isinstance(item, dict) and len(item) == 1 for item in value))


def _as_actions(value: Any) -> list | None:
    """An action list, or a single action written without the list
    (``then: {lvgl.widget.show: x}``, which ESPHome accepts too)."""
    if _is_action_list(value):
        return value
    if isinstance(value, dict) and len(value) == 1 and "." in str(next(iter(value))):
        return [value]
    return None


def _is_automation_list(value: Any) -> bool:
    """A trigger written as a list of automations, each with its own ``then:``."""
    return (isinstance(value, list) and bool(value)
            and all(isinstance(item, dict) and "then" in item
                    and isinstance(item["then"], (list, dict)) for item in value))


def _short(value: Any) -> str:
    text = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
    return text if len(text) <= 40 else text[:37] + "..."


def _label(entry: dict[str, Any], fallback: str) -> str:
    for key in ("id", "name", "interval", "platform"):
        if isinstance(entry.get(key), (str, int)) and str(entry[key]):
            return str(entry[key])
    return fallback


def _candidates(document: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(automations, state machines) found outside ``lvgl:``."""
    automations: list[dict[str, Any]] = []
    machines: list[dict[str, Any]] = []

    def visit(domain: str, entry: Any, fallback: str) -> None:
        if not isinstance(entry, dict):
            return
        label = _label(entry, fallback)
        for key, value in entry.items():
            if key.startswith("on_") and _is_automation_list(value):
                # `on_press: [{then: ...}, {min_length: 1s, then: ...}]` - several
                # automations on one trigger; each one is its own scenario.
                for index, automation in enumerate(value, start=1):
                    actions = automation["then"]
                    params = ", ".join(f"{k}: {_short(v)}" for k, v in automation.items() if k != "then")
                    suffix = f" ({params})" if params else (f" #{index}" if len(value) > 1 else "")
                    automations.append({
                        "name": f"{domain} {label}: {key}{suffix}",
                        "on": None,
                        "actions": actions if isinstance(actions, list) else [actions],
                    })
            elif _as_actions(value) is not None and (
                    key.startswith("on_") or key.endswith("_action") or key == "then"):
                value = _as_actions(value)
                trigger = None
                if domain == "switch" and key in {"turn_on_action", "turn_off_action"} and "id" in entry:
                    trigger = {"switch.turn_on" if key == "turn_on_action" else "switch.turn_off": entry["id"]}
                elif domain == "button" and key == "press_action" and "id" in entry:
                    trigger = {"button.press": entry["id"]}
                elif domain == "script" and key == "then" and "id" in entry:
                    trigger = {"script.execute": entry["id"]}
                name = f"{domain} {label}" if key == "then" else f"{domain} {label}: {key}"
                automations.append({"name": name, "on": trigger, "actions": value})
            elif isinstance(value, dict):
                # `on_update: {then: [...]}` - name it after its owner.
                visit(domain, value, f"{label}: {key}")

    for domain, block in document.items():
        if domain == "lvgl":
            continue
        if domain == "state_machine":
            machines.extend(m for m in (block if isinstance(block, list) else [block])
                            if isinstance(m, dict))
            continue
        entries = block if isinstance(block, list) else [block]
        for index, entry in enumerate(entries):
            visit(str(domain), entry, f"{domain}[{index}]")
    return automations, machines


def _machine_scenarios(machine: dict[str, Any], prefix: str) -> list[dict[str, Any]]:
    states = []
    for raw in machine.get("states") or []:
        state = raw if isinstance(raw, dict) else {"name": raw}
        if state.get("name") is None:
            continue
        actions = state.get("on_enter") if _is_action_list(state.get("on_enter")) else []
        states.append({"name": f"{prefix}{state['name']}", "actions": actions})
    if not states:
        return []
    initial = machine.get("initial_state") or states[0]["name"][len(prefix):]
    inputs = []
    for raw in machine.get("inputs") or []:
        if not isinstance(raw, dict) or raw.get("name") is None:
            continue
        table: dict[str, str] = {}
        for transition in raw.get("transitions") or []:
            text = transition.get("transition") if isinstance(transition, dict) else transition
            match = _TRANSITION_RE.match(str(text or ""))
            if match:
                table[f"{prefix}{match.group(1)}"] = f"{prefix}{match.group(2)}"
        if table:
            inputs.append({
                "name": f"{prefix}Eingang {raw['name']}",
                "on": {"state_machine.transition": raw["name"]},
                "transitions": table,
                "initial": f"{prefix}{initial}",
            })
    return states + inputs


def suggest_viewer_scenarios(document: dict[str, Any]) -> list[dict[str, Any]]:
    automations, machines = _candidates(document)

    # Keep what shows something on the display - directly, or by calling
    # another kept automation (a script switching a switch that shows a
    # button). Fixpoint, since calls can chain.
    machine_inputs = {str(i.get("name")) for m in machines for i in (m.get("inputs") or [])
                      if isinstance(i, dict)}
    machine_lvgl = any(_contains_lvgl(s) for m in machines for s in (m.get("states") or []))
    kept: list[dict[str, Any]] = []
    callable_targets: set[tuple[str, str]] = (
        {("state_machine.transition", name) for name in machine_inputs} if machine_lvgl else set())
    changed = True
    while changed:
        changed = False
        for automation in automations:
            if automation in kept:
                continue
            if _contains_lvgl(automation["actions"]) or _calls(automation["actions"]) & callable_targets:
                kept.append(automation)
                changed = True
                if automation["on"]:
                    (action, target), = automation["on"].items()
                    callable_targets.add((action, str(target)))
                    if action == "switch.turn_on":
                        callable_targets.add(("switch.toggle", str(target)))

    scenarios: list[dict[str, Any]] = []
    if machine_lvgl:
        for index, machine in enumerate(machines):
            prefix = f"{machine.get('id') or index}: " if len(machines) > 1 else ""
            scenarios.extend(_machine_scenarios(machine, prefix))
    order = {"switch": 0, "button": 1, "script": 2}
    kept.sort(key=lambda a: order.get(a["name"].split(" ", 1)[0], 3))
    for automation in kept:
        scenario = {"name": automation["name"]}
        if automation["on"]:
            scenario["on"] = automation["on"]
        scenario["actions"] = automation["actions"]
        scenarios.append(scenario)

    seen: dict[str, int] = {}
    for scenario in scenarios:
        base = scenario["name"]
        seen[base] = seen.get(base, 0) + 1
        if seen[base] > 1:
            scenario["name"] = f"{base} ({seen[base]})"
    return scenarios


def suggest_viewer_scenarios_yaml(document: dict[str, Any], source_name: str = "") -> str:
    scenarios = suggest_viewer_scenarios(document)
    if not scenarios:
        return ""
    source = f" aus {source_name}" if source_name else ""
    header = (
        f"# Vorschläge{source}: Automationen außerhalb von lvgl:, die das Display ändern.\n"
        "# Zustände, die C++ direkt setzt (z. B. per Lambda/SPI), fehlen hier -\n"
        "# die als eigene Szenarien ergänzen.\n"
    )
    text = "".join(_dump(scenarios, indented_sequences=True))
    # PyYAML quotes `on` (a YAML 1.1 boolean); the parser accepts it bare.
    return header + re.sub(r"(?m)^(\s*)'on':", r"\1on:", text)
