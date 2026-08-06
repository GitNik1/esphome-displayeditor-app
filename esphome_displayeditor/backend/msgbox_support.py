"""Add-on-only materialisation of ESPHome LVGL message boxes.

Same rationale and pattern as ``page_support.py``: ``msgboxes:`` is a
top-level ``lvgl:`` key, structurally unrelated to the widget tree, so the
shared (byte-identical, desktop-compatible) designer core continues to
preserve it verbatim in ``Project.extra_lvgl``. This adapter turns that
preserved YAML shape into the normalised dictionaries the add-on frontend
edits, and back, without changing the shared core or the saved/exported
source representation.
"""

from __future__ import annotations

import copy
from typing import Any

from .designer_core.idgen import IdRegistry
from .designer_core.model import Project, WidgetNode
from .designer_core.widgetschema import LVGL_STYLE_KEYS
from .designer_core.yamlexport import ExportIssue, _merge_passthrough, _widget_dict, clean_style_dict
from .designer_core.yamlimport import ImportIssue, _classify_style_dict, _import_widget

_MSGBOX_STRUCTURAL_KEYS = {"id", "title", "close_button", "body", "buttons", "header_buttons", "button_style"}
_BODY_STRUCTURAL_KEYS = {"text"}


def _body(raw: Any, path: str, issues: list[ImportIssue]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"text": "", "style_tree": {}, "extra": {}}
    style_source = {
        key: value for key, value in raw.items()
        if key not in _BODY_STRUCTURAL_KEYS and key in LVGL_STYLE_KEYS
    }
    style_tree = _classify_style_dict(style_source, issues, path) if style_source else {}
    extra = {
        key: value for key, value in raw.items()
        if key not in _BODY_STRUCTURAL_KEYS and key not in style_source
    }
    return {"text": raw.get("text", ""), "style_tree": style_tree, "extra": extra}


def _button_entries(raw: Any, widget_type: str, path: str,
                    registry: IdRegistry, issues: list[ImportIssue]) -> list[dict[str, Any]]:
    """A ``buttons:``/``header_buttons:`` list entry is a flat mapping - no
    ``{button: {...}}`` wrapper like an ordinary ``widgets:`` entry has - so
    it is wrapped here before delegating to the normal widget importer."""
    result = []
    for index, entry in enumerate(raw or []):
        if not isinstance(entry, dict):
            issues.append(ImportIssue("B", "Skipped a button entry that is not a mapping.", f"{path}[{index}]"))
            continue
        widget = _import_widget({widget_type: entry}, registry, issues, f"{path}[{index}]")
        if widget is not None:
            result.append(widget.to_dict())
    return result


def materialize_msgboxes(project: Project,
                         issues: list[ImportIssue] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return a frontend payload plus message-box statistics.

    The raw ``msgboxes:`` key remains in ``extra_lvgl`` so saving the project
    through the unchanged desktop-compatible core preserves the original YAML
    verbatim.
    """
    collected = issues if issues is not None else []
    registry = IdRegistry()
    for widget in project.all_widgets():
        registry.claim(widget.id, f"root widget '{widget.id}'")

    raw_list = project.extra_lvgl.get("msgboxes") or []
    msgboxes = []
    for index, raw in enumerate(raw_list):
        if not isinstance(raw, dict):
            continue
        path = f"lvgl.msgboxes[{index}]"
        msgbox_id = str(raw.get("id") or registry.unique_id("msgbox"))
        registry.claim(msgbox_id, f"msgbox at {path}")
        extra = {
            key: value for key, value in raw.items() if key not in _MSGBOX_STRUCTURAL_KEYS
        }
        msgboxes.append({
            "id": msgbox_id,
            "synthetic_id": not bool(raw.get("id")),
            "title": str(raw.get("title") or ""),
            "close_button": bool(raw.get("close_button", True)),
            "body": _body(raw.get("body"), f"{path}.body", collected),
            "buttons": _button_entries(raw.get("buttons"), "button", f"{path}.buttons", registry, collected),
            "header_buttons": _button_entries(
                raw.get("header_buttons"), "button", f"{path}.header_buttons", registry, collected),
            "extra": extra,
        })
    for message in registry.collisions():
        collected.append(ImportIssue("A", message))

    widget_count = sum(len(mb["buttons"]) + len(mb["header_buttons"]) for mb in msgboxes)
    return msgboxes, {"msgbox_count": len(msgboxes), "msgbox_widget_count": widget_count}


def apply_msgbox_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Fold editable add-on message boxes back into the core passthrough shape.

    ``Project`` deliberately stays byte-compatible with the desktop project
    and therefore does not own ``msgboxes``. The browser sends normalised
    message boxes alongside the core payload; before ``Project.from_dict``
    this adapter serializes them back into ``extra_lvgl``. Stored projects
    and exported YAML consequently contain the edited source of truth
    instead of a browser-only sidecar.
    """
    if "msgboxes" not in payload:
        return payload

    normalized = copy.deepcopy(payload)
    extra_lvgl = dict(normalized.get("extra_lvgl") or {})
    registry = IdRegistry()
    export_issues: list[ExportIssue] = []

    def button_list(entries: Any) -> list[dict[str, Any]]:
        # _widget_dict() returns the flat body only; a normal ``widgets:``
        # entry gets the ``{button: {...}}`` type wrapper added by its
        # caller, but msgbox's ``buttons:``/``header_buttons:`` entries are
        # already flat in real ESPHome YAML (see _button_entries() on the
        # import side, which does the reverse: adds the wrapper only to
        # satisfy _import_widget()'s single-key-mapping expectation).
        result = []
        for raw in entries if isinstance(entries, list) else []:
            if not isinstance(raw, dict):
                continue
            node = WidgetNode.from_dict(raw)
            widget_dict = _widget_dict(node, registry, export_issues)
            # A msgbox's buttons/header_buttons are auto-laid-out by LVGL in a
            # row, not placed at an absolute canvas position - x/y from the
            # editor's own canvas (where the button preview needs *some*
            # coordinate) would be meaningless noise in the exported YAML, so
            # they are dropped here. width/height are kept: a real msgbox
            # button can legitimately have an explicit size (e.g. a wider
            # "Apply" than "Cancel").
            widget_dict.pop("x", None)
            widget_dict.pop("y", None)
            result.append(widget_dict)
        return result

    def body_dict(body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            return {}
        result: dict[str, Any] = {}
        text = body.get("text")
        if text:
            result["text"] = text
        style_tree = body.get("style_tree")
        if isinstance(style_tree, dict) and style_tree:
            result.update(clean_style_dict(style_tree))
        preserved = body.get("extra")
        if isinstance(preserved, dict):
            _merge_passthrough(result, preserved, export_issues, "msgbox body")
        return result

    raw_msgboxes = normalized.get("msgboxes")
    msgboxes = []
    for entry in raw_msgboxes if isinstance(raw_msgboxes, list) else []:
        if not isinstance(entry, dict):
            continue
        result: dict[str, Any] = {}
        if not entry.get("synthetic_id"):
            result["id"] = str(entry.get("id", ""))
        result["title"] = str(entry.get("title", ""))
        if not entry.get("close_button", True):
            result["close_button"] = False
        body = body_dict(entry.get("body"))
        if body:
            result["body"] = body
        buttons = button_list(entry.get("buttons"))
        if buttons:
            result["buttons"] = buttons
        header_buttons = button_list(entry.get("header_buttons"))
        if header_buttons:
            result["header_buttons"] = header_buttons
        preserved = entry.get("extra")
        if isinstance(preserved, dict):
            _merge_passthrough(result, preserved, export_issues, str(entry.get("id", "msgbox")))
        msgboxes.append(result)

    if msgboxes:
        extra_lvgl["msgboxes"] = msgboxes
    else:
        extra_lvgl.pop("msgboxes", None)

    normalized["extra_lvgl"] = extra_lvgl
    return normalized
