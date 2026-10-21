"""Apply Viewer-scenario operations to a project payload.

The scenario YAML text is the source of truth - it is what the Viewer's
editor shows, comments included. Operations therefore edit that text through
the structural patcher (``backend/yaml_patch.py``) instead of re-dumping it:
an upsert touches only its own scenario's lines, and a human's comments
around the others survive an MCP edit.
"""

from __future__ import annotations

import copy
import re
from typing import Any


from ..api.viewer_projection import project_widget_types
from ..designer_core.yamlexport import HexColor
from ..designer_core.yamlimport import LvglImportError, load_yaml_bounded
from ..entity_bindings import _materialize_portable_yaml
from ..errors import ApiError
from ..viewer_scenarios import normalise_viewer_scenarios, parse_viewer_scenarios
from ..yaml_patch import _dump, patch_top_level_block

# `on` is a YAML 1.1 boolean: bare it loads as True, dumped it comes out as
# 'on'. Both sides of a patch are put in the quoted form and back.
_BARE_ON = re.compile(r"(?m)^(\s*(?:-\s+)?)on:")
_QUOTED_ON = re.compile(r"(?m)^(\s*(?:-\s+)?)'on':")


def _load_entries(text: str) -> list[dict[str, Any]]:
    if not text.strip():
        return []
    try:
        document = load_yaml_bounded(_BARE_ON.sub(r"\1'on':", text))
    except LvglImportError as exc:
        raise ApiError("invalid_viewer_scenarios", str(exc), 422) from exc
    if document is None:
        return []
    if not isinstance(document, list) or not all(isinstance(e, dict) for e in document):
        raise ApiError("invalid_viewer_scenarios", "Scenarios must be a YAML list of entries.", 422)
    return document


def _write(text: str, entries: list[dict[str, Any]]) -> tuple[str, bool]:
    """New scenario text for ``entries``; True when the old text's comments
    and formatting were kept."""
    if not entries:
        return "", True
    if text.strip():
        quoted = _BARE_ON.sub(r"\1'on':", text)
        wrapped = ["scenarios:\n"] + [
            f"  {line}" if line.strip() else line
            for line in quoted.splitlines(keepends=True)
        ]
        if wrapped[-1] and not wrapped[-1].endswith("\n"):
            wrapped[-1] += "\n"
        patched = patch_top_level_block(wrapped, "scenarios", entries)
        if patched is not None:
            body = "".join(line[2:] if line.startswith("  ") else line for line in patched[1:])
            return _QUOTED_ON.sub(r"\1on:", body), True
    dumped = "".join(_dump(entries, indented_sequences=True))
    return _QUOTED_ON.sub(r"\1on:", dumped), False


_HEX = re.compile(r"^(?:0x|#)([0-9A-Fa-f]{6})$")


def _hex_colors(value: Any) -> Any:
    """``"0x00FF00"`` from JSON back to the unquoted hex ESPHome writes."""
    if isinstance(value, dict):
        return {
            key: (HexColor(int(_HEX.match(item).group(1), 16))
                  if str(key).endswith("_color") and isinstance(item, str) and _HEX.match(item)
                  else _hex_colors(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_hex_colors(item) for item in value]
    return value


def _entry(operation: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {"name": operation.get("rename_to") or operation["name"]}
    if operation.get("on") is not None:
        entry["on"] = _materialize_portable_yaml(operation["on"])
    if operation.get("transitions"):
        entry["transitions"] = dict(operation["transitions"])
    if operation.get("initial"):
        entry["initial"] = operation["initial"]
    if operation.get("actions") or "transitions" not in entry:
        entry["actions"] = _hex_colors(_materialize_portable_yaml(operation.get("actions") or []))
    return entry


def _rename_references(entries: list[dict[str, Any]], old: str, new: str) -> None:
    for entry in entries:
        table = entry.get("transitions")
        if isinstance(table, dict):
            entry["transitions"] = {
                (new if key == old else key): (new if value == old else value)
                for key, value in table.items()
            }
        if entry.get("initial") == old:
            entry["initial"] = new


def _referenced_ids(value: Any) -> set[str]:
    """Widget and page ids the scenario actions point at."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).startswith("lvgl."):
                if isinstance(item, str):
                    found.add(item)
                elif isinstance(item, list):
                    found.update(i for i in item if isinstance(i, str))
                elif isinstance(item, dict) and isinstance(item.get("id"), str):
                    found.add(item["id"])
            found |= _referenced_ids(item)
    elif isinstance(value, list):
        for item in value:
            found |= _referenced_ids(item)
    return found


def _known_ids(project: dict[str, Any]) -> set[str]:
    known = set(project_widget_types(project))
    for surface in [*(project.get("pages") or []), *(project.get("msgboxes") or [])]:
        if isinstance(surface, dict) and isinstance(surface.get("id"), str):
            known.add(surface["id"])
    return known


#: Returned with every read, so a client can write scenarios without a manual.
SCENARIO_FORMAT_HELP = {
    "purpose": (
        "Scenarios simulate in the browser Viewer what the device computes in C++ "
        "(lambdas, SPI, sensors) or in components the Viewer cannot run (state machines, "
        "scripts). They are stored with the project and never exported to ESPHome."
    ),
    "scenario": {
        "name": "unique name, shown as a button in the Viewer",
        "actions": "LVGL actions as in widget events, e.g. "
                   "{'lvgl.label.update': {'id': 'x', 'text': '1.0', 'bg_color': '0x00FF00'}}, "
                   "{'lvgl.widget.show': ['a', 'b']}, {'lvgl.page.show': 'page_id'}, "
                   "{'switch.turn_on': 'id'} (fires scenarios triggered by it)",
        "on": "optional trigger: the scenario plays when an event reaches this action, "
              "e.g. {'state_machine.transition': 'NEXT'} or {'script.execute': 'id'}",
        "transitions": "optional with 'on': {from_scenario: to_scenario}; the Viewer keeps the "
                       "current state and plays the target",
        "initial": "optional: starting state of the transition tables",
    },
    "lambdas": "a lambda argument is {'__esphome_lambda__': 'return 1;'}; lambda actions "
               "are logged as not executed",
    "conditions": "conditions the browser cannot evaluate are asked of the user in the Viewer",
}


def read_viewer_scenarios(loaded: dict[str, Any], name: str) -> dict[str, Any]:
    """The scenario YAML, its parsed form and the import suggestions of a
    project read from the store."""
    stored = normalise_viewer_scenarios(loaded["project"].get("viewer_scenarios"))
    try:
        suggestion_names = [s["name"] for s in parse_viewer_scenarios(stored["suggestions"])]
    except LvglImportError:
        suggestion_names = []
    return {
        "name": name,
        "revision": loaded["revision"],
        "yaml": stored["yaml"],
        "scenarios": stored["scenarios"],
        "suggestions_yaml": stored["suggestions"],
        "suggestion_names": suggestion_names,
        "format": SCENARIO_FORMAT_HELP,
    }


class ViewerScenarioService:
    def apply(
        self, project: dict[str, Any], operations: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        proposed = copy.deepcopy(project)
        current = normalise_viewer_scenarios(proposed.get("viewer_scenarios"))
        text = current["yaml"]
        entries = _load_entries(text)
        skipped: list[str] = []
        edited = False  # entries changed since `text` was last set

        for operation in operations:
            kind = operation["op"]
            if kind == "set_scenarios_yaml":
                text = operation["yaml"]
                entries = _load_entries(text)
                edited = False
                continue
            edited = True
            if kind == "upsert_scenario":
                new_entry = _entry(operation)
                index = next((i for i, e in enumerate(entries)
                              if str(e.get("name")) == operation["name"]), None)
                if index is None:
                    entries.append(new_entry)
                else:
                    entries[index] = new_entry
                    if operation.get("rename_to"):
                        _rename_references(entries, operation["name"], operation["rename_to"])
            elif kind == "delete_scenario":
                remaining = [e for e in entries if str(e.get("name")) != operation["name"]]
                if len(remaining) == len(entries):
                    raise ApiError("scenario_not_found",
                                   f"There is no scenario named '{operation['name']}'.", 404)
                entries = remaining
            elif kind == "adopt_suggestions":
                suggestions = _load_entries(current["suggestions"])
                wanted = set(operation.get("names") or [])
                unknown = wanted - {str(s.get("name")) for s in suggestions}
                if unknown:
                    raise ApiError("suggestion_not_found",
                                   f"No such suggestion: {', '.join(sorted(unknown))}.", 404)
                existing = {str(e.get("name")) for e in entries}
                for suggestion in suggestions:
                    name = str(suggestion.get("name"))
                    if wanted and name not in wanted:
                        continue
                    if name in existing:
                        skipped.append(name)
                        continue
                    entries.append(suggestion)
                    existing.add(name)

        new_text, kept_formatting = _write(text, entries) if edited else (text, True)
        try:
            scenarios = parse_viewer_scenarios(new_text)
        except LvglImportError as exc:
            raise ApiError("invalid_viewer_scenarios", str(exc), 422) from exc

        proposed["viewer_scenarios"] = {
            "yaml": new_text, "scenarios": scenarios, "suggestions": current["suggestions"],
        }
        after = {s["name"]: s for s in scenarios}
        try:
            old_parsed = {s["name"]: s for s in parse_viewer_scenarios(current["yaml"])}
        except LvglImportError:
            old_parsed = {}
        unknown_ids = sorted(_referenced_ids([s["actions"] for s in scenarios]) - _known_ids(proposed))
        preview = {
            "scenario_count": {"before": len(old_parsed), "after": len(after)},
            "added_scenarios": sorted(set(after) - set(old_parsed)),
            "updated_scenarios": sorted(n for n in set(after) & set(old_parsed)
                                        if after[n] != old_parsed[n]),
            "removed_scenarios": sorted(set(old_parsed) - set(after)),
            "skipped_suggestions": skipped,
            "unknown_widget_ids": unknown_ids,
            "comments_preserved": kept_formatting,
        }
        return proposed, preview
