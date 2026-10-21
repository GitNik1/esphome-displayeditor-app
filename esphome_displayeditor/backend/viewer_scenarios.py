"""Viewer scenarios: hand-written device states the browser cannot compute.

A configuration's runtime behaviour often lives outside ``lvgl:`` - C++ in an
``interval:`` lambda, an SPI driver, a state machine. The Viewer never runs
any of that, so the screens it leads to are unreachable in the preview.

A scenario names such a state and lists the LVGL actions that produce it::

    - name: Board rechts erkannt
      actions:
        - lvgl.label.update:
            id: version_0_label
            text: "1.0.18"
            bg_color: 0x00FF00
        - lvgl.widget.show: [start_next_button, stop_button]

The Viewer replays the actions with the same interpreter it uses for widget
events. A scenario with ``on:`` plays when a widget event reaches an action
the browser cannot run (``state_machine.transition: NEXT``); with
``transitions:`` the trigger walks a state table, so a test sequence can be
clicked through on the simulated display itself. Scenarios are stored with
the project, never exported to ESPHome.
"""

from __future__ import annotations

import copy
from typing import Any


from .designer_core.yamlexport import HexColor
from .designer_core.yamlimport import LvglImportError, load_yaml_bounded
from .entity_bindings import _portable_yaml_value

MAX_SCENARIOS = 50
MAX_ACTIONS = 100


def _portable(value: Any) -> Any:
    """Like ``_portable_yaml_value``, plus colours as ``0xRRGGBB`` strings -
    the form the Viewer's style resolver reads; a bare int would be taken
    for a decimal number."""
    value = _portable_yaml_value(value)
    if isinstance(value, dict):
        return {
            key: (f"0x{item:06X}" if key.endswith("_color") and isinstance(item, int)
                  and not isinstance(item, bool) else _portable(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_portable(item) for item in value]
    if isinstance(value, HexColor):
        return f"0x{int(value):06X}"
    return value


def _parse_trigger(name: str, value: Any) -> dict[str, Any]:
    """``on:`` - the action that plays the scenario: an action name alone
    (``script.execute``) or one ``name: payload`` entry."""
    if isinstance(value, str) and value.strip():
        return {"name": value.strip(), "payload": None}
    if isinstance(value, dict) and len(value) == 1:
        (action, payload), = value.items()
        return {"name": str(action), "payload": _portable(payload)}
    raise LvglImportError(
        f"Scenario '{name}': 'on:' is an action name or one 'action: payload' entry.")


def _parse_entry(index: int, entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict) or not str(entry.get("name") or "").strip():
        raise LvglImportError(f"Scenario {index} needs a 'name:'.")
    name = str(entry["name"]).strip()
    if True in entry:  # bare `on:` is a YAML 1.1 boolean key
        entry = {("on" if key is True else key): value for key, value in entry.items()}
    unknown = set(entry) - {"name", "actions", "on", "transitions", "initial"}
    if unknown:
        raise LvglImportError(f"Scenario '{name}': unknown key(s) {', '.join(sorted(map(str, unknown)))}.")

    scenario: dict[str, Any] = {"name": name, "actions": []}
    actions = entry.get("actions", [])
    if actions is None:
        actions = []
    if not isinstance(actions, list):
        raise LvglImportError(f"Scenario '{name}': 'actions:' must be a list.")
    if len(actions) > MAX_ACTIONS:
        raise LvglImportError(f"Scenario '{name}' has more than {MAX_ACTIONS} actions.")
    for position, action in enumerate(actions, start=1):
        if not isinstance(action, dict) or len(action) != 1:
            raise LvglImportError(
                f"Scenario '{name}', action {position}: "
                "each action is a single 'name: payload' entry.")
    scenario["actions"] = _portable(actions)

    if "on" in entry:
        scenario["on"] = _parse_trigger(name, entry["on"])
    if "transitions" in entry:
        transitions = entry["transitions"]
        if "on" not in entry:
            raise LvglImportError(f"Scenario '{name}': 'transitions:' needs an 'on:' trigger.")
        if not isinstance(transitions, dict) or not transitions:
            raise LvglImportError(f"Scenario '{name}': 'transitions:' maps 'from: to' scenario names.")
        scenario["transitions"] = {str(k): str(v) for k, v in transitions.items()}
    if "initial" in entry:
        scenario["initial"] = str(entry["initial"])
    return scenario


def parse_viewer_scenarios(text: str) -> list[dict[str, Any]]:
    """Parse the scenario YAML into ``[{name, actions, on?, transitions?,
    initial?}]``; raises LvglImportError naming the offending entry.

    ``on:`` makes a scenario react to an action the browser cannot run
    (``state_machine.transition: NEXT``, ``script.execute: x``) instead of
    logging it as skipped. ``transitions:`` turns such a trigger into a
    state table: the Viewer remembers the last played state and plays the
    scenario the table names for it.
    """
    if not text.strip():
        return []
    document = load_yaml_bounded(text)
    if document is None:  # only comments
        return []
    if not isinstance(document, list):
        raise LvglImportError("Scenarios must be a YAML list ('- name: ...').")
    if len(document) > MAX_SCENARIOS:
        raise LvglImportError(f"At most {MAX_SCENARIOS} scenarios are allowed.")

    scenarios = [_parse_entry(index, entry) for index, entry in enumerate(document, start=1)]
    names = [s["name"] for s in scenarios]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise LvglImportError(f"Scenario names must be unique: {', '.join(duplicates)}.")
    known = set(names)
    for scenario in scenarios:
        referenced = [*scenario.get("transitions", {}).keys(),
                      *scenario.get("transitions", {}).values()]
        if "initial" in scenario:
            referenced.append(scenario["initial"])
        missing = sorted({n for n in referenced if n not in known})
        if missing:
            raise LvglImportError(
                f"Scenario '{scenario['name']}' refers to unknown scenario(s): {', '.join(missing)}.")
    return scenarios


def normalise_viewer_scenarios(value: Any) -> dict[str, Any]:
    """The stored shape ``{"yaml", "scenarios", "suggestions"}``; anything
    else is dropped rather than failing the project save."""
    if not isinstance(value, dict) or not isinstance(value.get("yaml"), str):
        return {"yaml": "", "scenarios": [], "suggestions": ""}
    scenarios = value.get("scenarios")
    suggestions = value.get("suggestions")
    return {
        "yaml": value["yaml"],
        "scenarios": copy.deepcopy(scenarios) if isinstance(scenarios, list) else [],
        "suggestions": suggestions if isinstance(suggestions, str) else "",
    }
