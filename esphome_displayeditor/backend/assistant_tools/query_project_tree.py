"""Project summary/tree/widget-lookup projections, split out of query.py."""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..api.viewer_projection import project_widget_types
from .limits import MCP_TREE_WIDGET_LIMIT


def project_summary(project: dict[str, Any], issues: list[dict]) -> dict[str, Any]:
    widget_types = project_widget_types(project)
    canvas = project.get("canvas") if isinstance(project.get("canvas"), dict) else {}
    pages = project.get("pages") if isinstance(project.get("pages"), list) else []
    msgboxes = (
        project.get("msgboxes") if isinstance(project.get("msgboxes"), list) else []
    )
    return {
        "format": project.get("format"),
        "format_version": project.get("format_version"),
        "canvas": canvas,
        "widget_count": len(widget_types),
        "widget_types": dict(sorted(Counter(widget_types.values()).items())),
        "page_count": len(pages),
        "layers": {
            "top": isinstance(project.get("top_layer"), dict),
            "bottom": isinstance(project.get("bottom_layer"), dict),
        },
        "msgbox_count": len(msgboxes),
        "entity_count": len(project.get("entities", [])),
        "binding_count": len(project.get("bindings", [])),
        "resource_counts": {
            key: len(project.get(key, []))
            for key in ("styles", "fonts", "images", "colors")
        },
        "issue_count": len(issues),
    }


def project_tree(project: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    state = {"count": 0, "truncated": False}

    def nodes(raw: Any) -> list[dict[str, Any]]:
        result = []
        for widget in raw if isinstance(raw, list) else []:
            if not isinstance(widget, dict):
                continue
            if state["count"] >= MCP_TREE_WIDGET_LIMIT:
                state["truncated"] = True
                break
            state["count"] += 1
            node = {
                "id": widget.get("id"),
                "widget_type": widget.get("widget_type"),
                "x": widget.get("x"),
                "y": widget.get("y"),
                "width": widget.get("width"),
                "height": widget.get("height"),
            }
            children = nodes(widget.get("children"))
            if children:
                node["children"] = children
            result.append(node)
        return result

    pages = []
    for page in project.get("pages", []) if isinstance(project.get("pages"), list) else []:
        if isinstance(page, dict):
            pages.append({"id": page.get("id"), "widgets": nodes(page.get("widgets"))})
    layers = {}
    for key in ("top_layer", "bottom_layer"):
        layer = project.get(key)
        if isinstance(layer, dict):
            layers[key] = nodes(layer.get("widgets"))
    msgboxes = []
    for msgbox in project.get("msgboxes", []) if isinstance(project.get("msgboxes"), list) else []:
        if isinstance(msgbox, dict):
            msgboxes.append(
                {
                    "id": msgbox.get("id"),
                    "buttons": nodes(msgbox.get("buttons")),
                    "header_buttons": nodes(msgbox.get("header_buttons")),
                }
            )
    return {
        "widgets": nodes(project.get("widgets")),
        "pages": pages,
        "layers": layers,
        "msgboxes": msgboxes,
        "widget_count": state["count"],
    }, bool(state["truncated"])


def find_widget(project: dict[str, Any], widget_id: str) -> dict[str, Any] | None:
    def find(nodes: Any) -> dict[str, Any] | None:
        for widget in nodes if isinstance(nodes, list) else []:
            if not isinstance(widget, dict):
                continue
            if widget.get("id") == widget_id:
                return widget
            child = find(widget.get("children"))
            if child is not None:
                return child
        return None

    groups: list[Any] = [project.get("widgets")]
    groups.extend(
        page.get("widgets")
        for page in project.get("pages", [])
        if isinstance(page, dict)
    )
    groups.extend(
        layer.get("widgets")
        for layer in (project.get("top_layer"), project.get("bottom_layer"))
        if isinstance(layer, dict)
    )
    for msgbox in project.get("msgboxes", []):
        if isinstance(msgbox, dict):
            groups.extend((msgbox.get("buttons"), msgbox.get("header_buttons")))
    for group in groups:
        match = find(group)
        if match is not None:
            return match
    return None
