"""Project-bound tool scope for the in-app AI help panel.

Every tool here operates on the one ``project_name`` (and, optionally, the
one ``configuration_name``) fixed for the whole request - never a value the
model supplies. This is enforced structurally, not by validation: the
Anthropic-facing ``input_schema`` for each tool simply does not include a
project/configuration name parameter, so there is nothing for a prompt
injection to redirect. The handler always substitutes the bound name.

Read tools mirror a deliberately small slice of what MCP exposes (project
read, validation, binding targets, the static widget/binding catalog, and -
only when a configuration_name was bound - one configuration read). Write
tools are limited to project and project-binding proposals; there is no
apply, publish, YAML import/export, build, or install tool here. Applying a
proposed changeset always requires an explicit action in the panel UI
itself, never a model-initiated call.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import TypeAdapter

from ..assistant_tools import AssistantToolService
from ..assistant_tools.binding_operations import ProjectBindingOperation
from ..assistant_tools.operations import PlacementOperation
from ..errors import ApiError

_PLACEMENT_OPERATIONS_SCHEMA = TypeAdapter(list[PlacementOperation]).json_schema()
_BINDING_OPERATIONS_SCHEMA = TypeAdapter(list[ProjectBindingOperation]).json_schema()


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], dict[str, Any]]


def _run(operation: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return {"ok": True, **operation()}
    except ApiError as exc:
        return {"ok": False, "error": exc.error, "message": exc.message}


def build_tool_scope(
    service: AssistantToolService,
    *,
    project_name: str,
    configuration_name: str | None,
    identity: str,
) -> list[ToolSpec]:
    tools = [
        ToolSpec(
            name="read_project",
            description=(
                "Read the bound project: summary, widget tree, entity/widget "
                "bindings, or one widget by ID."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "view": {
                        "type": "string",
                        "enum": ["summary", "tree", "bindings", "widget"],
                        "default": "summary",
                    },
                    "widget_id": {
                        "type": "string",
                        "description": "Required when view is 'widget'.",
                    },
                },
            },
            handler=lambda args: _run(
                lambda: service.read_project(
                    project_name,
                    str(args.get("view", "summary")),
                    str(args.get("widget_id", "")),
                )
            ),
        ),
        ToolSpec(
            name="validate_project",
            description="Validate the bound project and return its issues.",
            input_schema={"type": "object", "properties": {}},
            handler=lambda _args: _run(lambda: service.validate_project(project_name)),
        ),
        ToolSpec(
            name="binding_targets",
            description=(
                "List compatible entity or widget binding targets in the "
                "bound project."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "enum": ["entities", "widgets", "viewer_widgets"],
                        "default": "widgets",
                    },
                    "direction": {
                        "type": "string",
                        "enum": [
                            "entity_to_widget",
                            "widget_to_entity",
                            "bidirectional",
                        ],
                        "default": "entity_to_widget",
                    },
                    "entity_domain": {"type": "string"},
                    "entity_id": {"type": "string"},
                    "widget_id": {"type": "string"},
                    "query": {"type": "string"},
                },
            },
            handler=lambda args: _run(
                lambda: service.binding_targets(
                    project_name,
                    str(args.get("target", "widgets")),
                    str(args.get("direction", "entity_to_widget")),
                    str(args.get("entity_domain", "")),
                    str(args.get("entity_id", "")),
                    str(args.get("widget_id", "")),
                    str(args.get("query", "")),
                )
            ),
        ),
        ToolSpec(
            name="widget_catalog",
            description=(
                "List supported widget types, or inspect one widget type's "
                "schema. Not project-specific."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "widget_type": {
                        "type": "string",
                        "description": "Leave empty to list all widget types.",
                    },
                },
            },
            handler=lambda args: _run(
                lambda: service.catalog(
                    "widgets", "de", str(args.get("widget_type", ""))
                )
            ),
        ),
        ToolSpec(
            name="propose_layout_change",
            description=(
                "Propose add_widget/update_widget/place_widget operations "
                "against the bound project as a reviewable, expiring change "
                "set. This never saves the project - the user applies it "
                "explicitly in the panel."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "base_revision": {
                        "type": "string",
                        "description": (
                            "The exact project revision this proposal is "
                            "based on, from a prior read_project call."
                        ),
                    },
                    "operations": _PLACEMENT_OPERATIONS_SCHEMA,
                },
                "required": ["base_revision", "operations"],
            },
            handler=lambda args: _run(
                lambda: service.propose_project(
                    project_name,
                    str(args.get("base_revision", "")),
                    list(args.get("operations", [])),
                    identity=identity,
                )
            ),
        ),
        ToolSpec(
            name="propose_binding_change",
            description=(
                "Propose set_project_binding/remove_project_binding "
                "operations against the bound project as a reviewable, "
                "expiring change set."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "base_revision": {
                        "type": "string",
                        "description": (
                            "The exact project revision this proposal is "
                            "based on, from a prior read_project call."
                        ),
                    },
                    "operations": _BINDING_OPERATIONS_SCHEMA,
                },
                "required": ["base_revision", "operations"],
            },
            handler=lambda args: _run(
                lambda: service.propose_project_bindings(
                    project_name,
                    str(args.get("base_revision", "")),
                    list(args.get("operations", [])),
                    identity=identity,
                )
            ),
        ),
    ]

    if configuration_name:
        tools.append(
            ToolSpec(
                name="read_configuration",
                description=(
                    "Read the one ESPHome configuration bound to this "
                    "session (bounded text segment)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "offset": {"type": "integer", "default": 0},
                        "source": {
                            "type": "string",
                            "enum": ["active", "draft"],
                            "default": "active",
                        },
                    },
                },
                handler=lambda args: _run(
                    lambda: service.read_configuration(
                        configuration_name,
                        int(args.get("offset", 0) or 0),
                        65536,
                        str(args.get("source", "active")),
                    )
                ),
            )
        )

    return tools
