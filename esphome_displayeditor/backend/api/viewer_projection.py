"""Data minimization helpers for the read-only browser Viewer."""

from __future__ import annotations

from typing import Any


def viewer_entity_id(item: dict[str, Any]) -> str | None:
    entity_type = str(item.get("type", "")).strip()
    key = item.get("key", item.get("object_id"))
    if not entity_type or key is None:
        return None
    return f"{entity_type}:{key}"


def viewer_entity(item: dict[str, Any]) -> dict[str, Any] | None:
    entity_id = viewer_entity_id(item)
    if entity_id is None:
        return None
    allowed = (
        "type",
        "key",
        "object_id",
        "name",
        "icon",
        "unit_of_measurement",
        "device_class",
        "entity_category",
        "disabled_by_default",
    )
    return {
        "entity_id": entity_id,
        **{key: item[key] for key in allowed if key in item},
    }


def viewer_state(item: dict[str, Any]) -> dict[str, Any] | None:
    entity_id = viewer_entity_id(item)
    if entity_id is None:
        return None
    allowed = ("type", "key", "object_id", "state", "available", "received_at")
    return {
        "entity_id": entity_id,
        **{key: item[key] for key in allowed if key in item},
    }


def project_widget_types(project: dict[str, Any]) -> dict[str, str]:
    """Index widget ids across root, pages, layers and message boxes."""

    result: dict[str, str] = {}

    def visit(nodes: Any) -> None:
        if not isinstance(nodes, list):
            return
        for widget in nodes:
            if not isinstance(widget, dict):
                continue
            widget_id = widget.get("id")
            if isinstance(widget_id, str):
                result[widget_id] = str(widget.get("widget_type", ""))
            visit(widget.get("children"))

    visit(project.get("widgets"))
    pages = project.get("pages")
    for page in pages if isinstance(pages, list) else []:
        if isinstance(page, dict):
            visit(page.get("widgets"))
    for layer_name in ("top_layer", "bottom_layer"):
        layer = project.get(layer_name)
        if isinstance(layer, dict):
            visit(layer.get("widgets"))
    msgboxes = project.get("msgboxes")
    for msgbox in msgboxes if isinstance(msgboxes, list) else []:
        if isinstance(msgbox, dict):
            visit(msgbox.get("buttons"))
            visit(msgbox.get("header_buttons"))
    return result

