"""MCP tool and resource registration."""

from __future__ import annotations

from typing import Any, Literal

from mcp.server import MCPServer

from ..assistant_tools import AssistantToolService
from ..builder import BuilderManager
from ..settings import Settings
from ..version import APP_VERSION
from .apps_api import build_apps_extension
from .discovery import register_discovery_tools
from .firmware_api import register_firmware_api
from .identity import MCPAuthorization, authorization_for_token
from .read_resources import register_read_resources
from .support import READ_ONLY, scoped_tool_result
from .write_api import register_write_api


def create_mcp_server(
    settings: Settings | None = None,
    *,
    default_authorization: MCPAuthorization | None = None,
    require_bound_identity: bool = False,
    builder: BuilderManager | None = None,
) -> MCPServer:
    """Register MCP tools/resources against a scope-checked fallback identity.

    ``require_bound_identity`` must be set for any server exposed over a real
    transport (HTTP, stdio). It disables the convenience fallback so a scope
    check can never silently succeed against an unbound request context - for
    example if authentication middleware fails to propagate its identity.
    Tests that call ``server.call_tool`` directly without that middleware may
    leave it unset to keep using ``default_authorization`` as a fallback.

    ``builder`` lets tests inject a ``BuilderManager`` backed by a fake
    adapter instead of a real Device Builder WebSocket connection, the same
    way ``create_app(..., builder_manager=...)`` does for the REST API.
    """
    runtime_settings = settings or Settings.load()
    fallback = None if require_bound_identity else (
        default_authorization
        or authorization_for_token(
            runtime_settings.mcp_access_token,
            runtime_settings.mcp_access,
        )
    )
    service = AssistantToolService(runtime_settings, builder=builder)
    apps = build_apps_extension(
        service,
        fallback,
        include_changeset_review=runtime_settings.mcp_access == "project_write",
    )
    server = MCPServer(
        "esphome-display-editor",
        title="ESPHome Display Editor",
        description="Inspect LVGL projects and apply validated project or draft changesets.",
        instructions=(
            "Inspect the widget catalog before proposing changes. When write access is "
            "enabled, proposals never alter a project; only display_changeset_apply can "
            "persist a validated proposal with exact source revisions. Configuration "
            "merge changesets write drafts only and never publish active YAML."
        ),
        version=APP_VERSION,
        extensions=[apps],
    )

    @server.tool(name="display_server_info", annotations=READ_ONLY)
    def display_server_info() -> dict[str, Any]:
        """Return MCP features, access mode and enforced limits."""
        return scoped_tool_result(
            ("server:read",),
            fallback,
            lambda authorization: {
                **service.server_info(),
                "authorization": authorization.summary(),
            },
        )

    @server.tool(name="display_catalog", annotations=READ_ONLY)
    def display_catalog(
        kind: Literal["widgets", "bindings"] = "widgets",
        language: Literal["de", "en"] = "de",
        widget_type: str = "",
    ) -> dict[str, Any]:
        """List widget/binding capabilities or inspect one widget schema."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.catalog(kind, language, widget_type),
        )

    @server.tool(name="display_projects", annotations=READ_ONLY)
    def display_projects(limit: int = 50, cursor: str = "") -> dict[str, Any]:
        """List stored projects with revisions and an opaque next-page cursor."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.list_projects(limit, cursor),
        )

    @server.tool(name="display_configurations", annotations=READ_ONLY)
    def display_configurations(
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        """List ESPHome YAML configurations with revisions and an opaque cursor."""
        return scoped_tool_result(
            ("configuration:read",),
            fallback,
            lambda _authorization: service.list_configurations(limit, cursor),
        )

    @server.tool(name="display_configuration_read", annotations=READ_ONLY)
    def display_configuration_read(
        name: str,
        offset: int = 0,
        max_characters: int = 65536,
        source: Literal["active", "draft"] = "active",
    ) -> dict[str, Any]:
        """Read bounded active/draft YAML plus its exact source revision."""
        return scoped_tool_result(
            ("configuration:read",),
            fallback,
            lambda _authorization: service.read_configuration(
                name,
                offset,
                max_characters,
                source,
            ),
        )

    @server.tool(name="display_project_read", annotations=READ_ONLY)
    def display_project_read(
        name: str,
        view: Literal[
            "summary", "tree", "bindings", "viewer_bindings", "widget"
        ] = "summary",
        widget_id: str = "",
    ) -> dict[str, Any]:
        """Read a bounded project view; widget view also requires widget_id."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.read_project(name, view, widget_id),
        )

    @server.tool(name="display_project_validate", annotations=READ_ONLY)
    def display_project_validate(name: str) -> dict[str, Any]:
        """Validate a stored project and return its current revision and issues."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.validate_project(name),
        )

    @server.tool(name="display_project_revisions", annotations=READ_ONLY)
    def display_project_revisions(name: str, limit: int = 10) -> dict[str, Any]:
        """List the stored earlier versions of a project with actor and origin."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.list_project_revisions(name, limit),
        )

    @server.tool(name="display_project_revision_read", annotations=READ_ONLY)
    def display_project_revision_read(
        name: str,
        revision_id: int,
        view: Literal["summary", "diff"] = "summary",
        against: str = "current",
    ) -> dict[str, Any]:
        """Read one earlier version as a bounded summary or a unified diff.

        Rolling back is deliberately not a tool: read the version, then go
        through display_project_propose and display_changeset_apply.
        """
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.read_project_revision(
                name, revision_id, view, against
            ),
        )

    register_discovery_tools(server, service, fallback)

    @server.tool(name="display_binding_targets", annotations=READ_ONLY)
    def display_binding_targets(
        name: str,
        target: Literal["entities", "widgets", "viewer_widgets"] = "widgets",
        direction: Literal[
            "entity_to_widget", "widget_to_entity", "bidirectional"
        ] = "entity_to_widget",
        entity_domain: str = "",
        entity_id: str = "",
        widget_id: str = "",
        query: str = "",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        """List compatible, bounded entity or widget binding targets."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.binding_targets(
                name,
                target,
                direction,
                entity_domain,
                entity_id,
                widget_id,
                query,
                limit,
                cursor,
            ),
        )

    @server.tool(name="display_yaml_transform", annotations=READ_ONLY)
    def display_yaml_transform(
        name: str,
        project_revision: str,
        mode: Literal["export", "merge_preview"] = "export",
        configuration_name: str = "",
        configuration_revision: str = "",
        offset: int = 0,
        max_characters: int = 65536,
    ) -> dict[str, Any]:
        """Export or merge-preview exact-revision YAML in bounded text segments."""
        required_scopes = (
            ("project:read", "configuration:read")
            if mode == "merge_preview"
            else ("project:read",)
        )
        return scoped_tool_result(
            required_scopes,
            fallback,
            lambda _authorization: service.transform_yaml(
                name,
                project_revision,
                mode,
                configuration_name,
                configuration_revision,
                offset,
                max_characters,
            ),
        )

    @server.prompt(
        name="display_analyze_project",
        title="Analyze a display project",
        description="Inspect one project with bounded MCP reads and report findings.",
    )
    def display_analyze_project(
        project_name: str,
        focus: str = "summary",
    ) -> str:
        return (
            f"Analyze Display Editor project '{project_name}' with focus '{focus}'. "
            "Start with display_project_read view=summary and retain its exact revision. "
            "Use view=tree, widget, bindings or viewer_bindings only as needed, and run "
            "display_project_validate before reporting concrete issues. Do not propose "
            "or apply changes unless the user explicitly asks for them."
        )

    @server.prompt(
        name="display_review_yaml",
        title="Review generated or merged YAML",
        description="Export a project or preview its merge into an ESPHome configuration.",
    )
    def display_review_yaml(
        project_name: str,
        configuration_name: str = "",
    ) -> str:
        target = (
            f" Preview a merge into '{configuration_name}' using its exact active revision."
            if configuration_name
            else " Export the project YAML."
        )
        return (
            f"Read project '{project_name}' and retain its exact revision.{target} "
            "Call display_yaml_transform with bounded segments until next_offset is null. "
            "Report validation issues and preserved configuration sections. This workflow "
            "is read-only and must not create or apply a change set."
        )

    if runtime_settings.mcp_access == "project_write":
        register_write_api(server, service, fallback)
        if runtime_settings.access_level == "write_with_builder":
            register_firmware_api(server, service, fallback)

    register_read_resources(server, service, fallback)

    return server
