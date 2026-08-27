"""Write-mode MCP prompts and change-set tool registration."""

from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from ..assistant_tools import AssistantToolService
from ..assistant_tools.operations import PlacementOperation
from .identity import MCPAuthorization
from .support import APPLY, READ_ONLY, scoped_tool_result


def register_write_api(
    server: MCPServer,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    @server.prompt(
        name="display_create_project_from_yaml",
        title="Create a project from ESPHome YAML",
        description="Import exact-revision YAML through a reviewed project change set.",
    )
    def display_create_project_from_yaml(
        configuration_name: str,
        project_name: str,
        goal: str = "",
    ) -> str:
        return (
            f"Create project '{project_name}' from configuration "
            f"'{configuration_name}'. Goal: {goal or 'preserve the imported layout'}. "
            "Read the complete configuration in bounded segments, retain its exact "
            "revision, call display_project_import_propose, review all blocking issues "
            "and the change-set preview, and call display_changeset_apply only after "
            "the user approves. Never modify the source YAML."
        )

    @server.prompt(
        name="display_edit_layout",
        title="Plan and apply a layout change",
        description="Use semantic placement operations and a reviewed project change set.",
    )
    def display_edit_layout(
        project_name: str,
        goal: str,
        parent_widget_id: str = "",
    ) -> str:
        parent = (
            f" Prefer parent widget '{parent_widget_id}'." if parent_widget_id else ""
        )
        return (
            f"Modify project '{project_name}' to achieve: {goal}.{parent} Read the "
            "summary, relevant tree/widgets and widget catalog first. Use only semantic "
            "add_widget, update_widget or place_widget operations. Propose against the "
            "exact project revision, review validation and placement results, and apply "
            "only after user approval."
        )

    @server.prompt(
        name="display_bind_entities",
        title="Create compatible display bindings",
        description="Discover compatible targets and propose project or Viewer bindings.",
    )
    def display_bind_entities(
        project_name: str,
        binding_kind: str = "project",
        direction: str = "entity_to_widget",
        widget_id: str = "",
        entity_domain: str = "",
        entity_id: str = "",
        goal: str = "",
    ) -> str:
        return (
            f"Add {binding_kind} bindings in project '{project_name}' for goal: "
            f"{goal or 'connect the selected entity and widget'}. Direction: {direction}; "
            f"widget: {widget_id or 'select a compatible target'}; entity: "
            f"{entity_domain or '*'}:{entity_id or '*'}. Read the exact project and "
            "Viewer-sidecar revisions, use display_binding_targets to discover compatible "
            "properties/events/commands, propose the correct binding kind, review the "
            "change set, and apply only after user approval. Never convert project and "
            "Viewer bindings into each other."
        )

    # display_project_propose, display_project_import_propose,
    # display_project_import_yaml_propose, display_configuration_draft_propose,
    # display_binding_propose and display_viewer_binding_propose are
    # registered in apps_api.py: they are UI-bound to the MCP Apps
    # Change-Set Review view (ui://display-editor/changeset-review) and must
    # be registered via the Apps extension, not this server.tool() decorator.

    @server.tool(name="display_changeset_read", annotations=READ_ONLY)
    def display_changeset_read(change_set_id: str) -> dict[str, Any]:
        """Read an owned changeset, its semantic operations and validation preview."""
        return scoped_tool_result(
            ("changeset:read",),
            fallback,
            lambda authorization: service.read_changeset(
                change_set_id,
                identity=authorization.identity,
            ),
        )

    @server.tool(name="display_project_apply", annotations=APPLY)
    def display_project_apply(
        name: str,
        base_revision: str,
        operations: list[PlacementOperation],
    ) -> dict[str, Any]:
        """Validate and persist project operations in one step, without review.

        The reviewed route (display_project_propose -> display_changeset_apply)
        stays available and is the better choice when someone should look at
        the diff first. This one trades that look for a single round trip and
        relies on the project version history to undo a bad change.

        It is not a shortcut past the safety checks: the operations are
        validated exactly as a proposal is, and ``base_revision`` is still
        enforced, so a change made by another session in the meantime is
        refused rather than silently overwritten.
        """
        return scoped_tool_result(
            ("project:write", "changeset:apply"),
            fallback,
            lambda authorization: service.apply_changeset(
                service.propose_project(
                    name,
                    base_revision,
                    operations,
                    identity=authorization.identity,
                )["change_set_id"],
                identity=authorization.identity,
            ),
        )

    @server.tool(name="display_changeset_apply", annotations=APPLY)
    def display_changeset_apply(change_set_id: str) -> dict[str, Any]:
        """Persist a validated project or draft changeset if revisions still match."""
        return scoped_tool_result(
            ("changeset:apply",),
            fallback,
            lambda authorization: service.apply_changeset(
                change_set_id,
                identity=authorization.identity,
            ),
        )

    @server.tool(name="display_configuration_apply", annotations=APPLY)
    def display_configuration_apply(name: str, expected_revision: str) -> dict[str, Any]:
        """Publish an already-reviewed draft as the active ESPHome YAML."""
        return scoped_tool_result(
            ("configuration:publish",),
            fallback,
            lambda authorization: service.publish_configuration(
                name,
                expected_revision,
                identity=authorization.identity,
            ),
        )
