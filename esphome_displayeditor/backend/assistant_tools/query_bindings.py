"""Binding-target discovery, split out of query.py to stay under the line limit.

These are plain functions rather than methods: they take the owning
``QueryService`` instance explicitly so they can reuse its stores and shared
``_page`` pagination helper without duplicating that state.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..api.viewer_projection import project_widget_types
from ..entity_bindings import WIDGET_CAPABILITIES, widget_input_accepts
from ..errors import ApiError
from ..viewer_bindings import viewer_targets_for_widget_type
from .limits import MCP_BINDING_TARGET_SCAN_LIMIT
from .pagination import cursor_fingerprint

if TYPE_CHECKING:
    from .query import QueryService


def binding_targets(
    service: "QueryService",
    name: str,
    target: str = "widgets",
    direction: str = "entity_to_widget",
    entity_domain: str = "",
    entity_id: str = "",
    widget_id: str = "",
    query: str = "",
    limit: int = 50,
    cursor: str = "",
) -> dict[str, Any]:
    """List bounded binding counterparts using the canonical validators."""
    if target not in {"entities", "widgets", "viewer_widgets"}:
        raise ApiError(
            "invalid_binding_target_kind",
            "target must be entities, widgets or viewer_widgets.",
            422,
        )
    if direction not in {
        "entity_to_widget",
        "widget_to_entity",
        "bidirectional",
    }:
        raise ApiError("invalid_binding_direction", "Binding direction is invalid.", 422)
    if bool(entity_domain) != bool(entity_id):
        raise ApiError(
            "incomplete_entity_reference",
            "entity_domain and entity_id must be supplied together.",
            422,
        )
    normalized_query = str(query).strip().casefold()
    if len(normalized_query) > 128:
        raise ApiError("invalid_query", "The binding target query is too long.", 422)

    loaded = service.projects.read(name)
    project = loaded["project"]
    widgets = project_widget_types(project)
    entities = sorted(
        (item for item in project.get("entities", []) if isinstance(item, dict)),
        key=lambda item: (str(item.get("domain", "")), str(item.get("id", ""))),
    )
    selected_entity = None
    if entity_domain and entity_id:
        selected_entity = next(
            (
                item
                for item in entities
                if item.get("domain") == entity_domain and item.get("id") == entity_id
            ),
            None,
        )
        if selected_entity is None:
            raise ApiError(
                "entity_not_found",
                "The selected project entity was not found.",
                404,
            )
    selected_widget_type = widgets.get(widget_id) if widget_id else None
    if widget_id and selected_widget_type is None:
        raise ApiError("widget_not_found", "The selected widget was not found.", 404)

    if target == "entities":
        candidates = _entity_binding_targets(
            entities,
            direction,
            selected_widget_type,
            normalized_query,
        )
    else:
        candidates = _widget_binding_targets(
            widgets,
            target,
            direction,
            selected_entity,
            normalized_query,
        )

    matching_count = len(candidates)
    scan_truncated = matching_count > MCP_BINDING_TARGET_SCAN_LIMIT
    candidates = candidates[:MCP_BINDING_TARGET_SCAN_LIMIT]
    fingerprint = cursor_fingerprint(
        {
            "revision": loaded["revision"],
            "target": target,
            "direction": direction,
            "entity": [entity_domain, entity_id],
            "widget_id": widget_id,
            "query": normalized_query,
            "candidate_count": matching_count,
        }
    )
    page, next_cursor = service._page(
        candidates,
        limit,
        cursor,
        scope=f"binding-targets:{name}",
        fingerprint=fingerprint,
    )
    return {
        "name": name,
        "revision": loaded["revision"],
        "target": target,
        "direction": direction,
        "targets": page,
        "matching_count": matching_count,
        "scanned_count": len(candidates),
        "returned": len(page),
        "truncated": next_cursor is not None or scan_truncated,
        "scan_truncated": scan_truncated,
        "next_cursor": next_cursor,
    }


def _direction_allowed(entity: dict[str, Any], direction: str) -> bool:
    readable = bool(entity.get("readable"))
    writable = bool(entity.get("writable")) and bool(entity.get("commands"))
    if direction == "entity_to_widget":
        return readable
    if direction == "widget_to_entity":
        return writable
    return readable and writable


def _entity_binding_targets(
    entities: list[dict[str, Any]],
    direction: str,
    widget_type: str | None,
    query: str,
) -> list[dict[str, Any]]:
    widget_caps = WIDGET_CAPABILITIES.get(
        widget_type or "",
        {"inputs": [], "outputs": []},
    )
    result: list[dict[str, Any]] = []
    for entity in entities:
        if not _direction_allowed(entity, direction):
            continue
        data_type = str(entity.get("data_type", ""))
        compatible_inputs = [
            prop
            for prop in widget_caps["inputs"]
            if widget_input_accepts(prop, data_type)
        ]
        compatible_outputs = list(widget_caps["outputs"])
        if widget_type:
            if direction == "entity_to_widget" and not compatible_inputs:
                continue
            if direction == "widget_to_entity" and not compatible_outputs:
                continue
            if direction == "bidirectional" and (
                not compatible_inputs or not compatible_outputs
            ):
                continue
        candidate = {
            key: entity.get(key)
            for key in (
                "domain",
                "id",
                "name",
                "data_type",
                "readable",
                "writable",
                "trigger",
                "commands",
                "unit",
            )
        }
        if widget_type:
            candidate["compatible_inputs"] = compatible_inputs
            candidate["compatible_outputs"] = compatible_outputs
        haystack = " ".join(
            str(candidate.get(key, ""))
            for key in ("domain", "id", "name", "data_type")
        ).casefold()
        if not query or query in haystack:
            result.append(candidate)
    return result


def _widget_binding_targets(
    widgets: dict[str, str],
    target: str,
    direction: str,
    entity: dict[str, Any] | None,
    query: str,
) -> list[dict[str, Any]]:
    if entity is not None and not _direction_allowed(entity, direction):
        return []
    result: list[dict[str, Any]] = []
    for widget_id, widget_type in sorted(widgets.items()):
        if target == "viewer_widgets":
            viewer_targets = viewer_targets_for_widget_type(widget_type)
            if not viewer_targets:
                continue
            candidate = {
                "widget_id": widget_id,
                "widget_type": widget_type,
                "viewer_targets": viewer_targets,
            }
        else:
            caps = WIDGET_CAPABILITIES.get(
                widget_type,
                {"inputs": [], "outputs": []},
            )
            data_type = str(entity.get("data_type", "")) if entity else ""
            compatible_inputs = [
                prop
                for prop in caps["inputs"]
                if entity is None or widget_input_accepts(prop, data_type)
            ]
            compatible_outputs = list(caps["outputs"])
            if direction == "entity_to_widget" and not compatible_inputs:
                continue
            if direction == "widget_to_entity" and not compatible_outputs:
                continue
            if direction == "bidirectional" and (
                not compatible_inputs or not compatible_outputs
            ):
                continue
            candidate = {
                "widget_id": widget_id,
                "widget_type": widget_type,
                "compatible_inputs": compatible_inputs,
                "compatible_outputs": compatible_outputs,
            }
            if entity is not None:
                candidate["entity_commands"] = list(entity.get("commands", []))
        haystack = f"{widget_id} {widget_type}".casefold()
        if not query or query in haystack:
            result.append(candidate)
    return result
