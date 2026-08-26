"""Scope-aware MCP resources, templates and argument completions."""

from __future__ import annotations

from mcp.server import MCPServer
from mcp.types import Completion, PromptReference, ResourceTemplateReference

from ..assistant_tools import AssistantToolService
from .discovery import register_discovery_resources
from .identity import MCPAuthorization, has_scopes
from .support import scoped_resource_json


def register_read_resources(
    server: MCPServer,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    @server.resource(
        "esphome-display://server/info",
        name="server-info",
        title="Display Editor server information",
        mime_type="application/json",
    )
    def server_info_resource() -> str:
        return scoped_resource_json(
            ("server:read",),
            fallback,
            lambda authorization: {
                **service.server_info(),
                "authorization": authorization.summary(),
            },
        )

    @server.resource(
        "esphome-display://catalog/widgets",
        name="widget-catalog",
        title="Supported widget types and schemas",
        mime_type="application/json",
    )
    def widget_catalog_resource() -> str:
        return scoped_resource_json(
            ("project:read",),
            fallback,
            lambda _authorization: service.catalog("widgets"),
        )

    @server.resource(
        "esphome-display://catalog/bindings",
        name="binding-catalog",
        title="Supported entity and widget bindings",
        mime_type="application/json",
    )
    def binding_catalog_resource() -> str:
        return scoped_resource_json(
            ("project:read",),
            fallback,
            lambda _authorization: service.catalog("bindings"),
        )

    @server.resource(
        "esphome-display://projects",
        name="projects",
        title="Stored Display Editor projects",
        mime_type="application/json",
    )
    def projects_resource() -> str:
        return scoped_resource_json(
            ("project:read",),
            fallback,
            lambda _authorization: service.list_projects(),
        )

    @server.resource(
        "esphome-display://projects/{name}/summary",
        name="project-summary",
        title="Display Editor project summary",
        mime_type="application/json",
    )
    def project_summary_resource(name: str) -> str:
        return scoped_resource_json(
            ("project:read",),
            fallback,
            lambda _authorization: service.read_project(name, "summary"),
        )

    register_discovery_resources(server, service, fallback)

    @server.completion()
    async def complete_display_argument(ref, argument, context) -> Completion:
        if not isinstance(ref, (PromptReference, ResourceTemplateReference)):
            return Completion(values=[], total=0, hasMore=False)
        resource_reference = (
            str(ref.uri) if isinstance(ref, ResourceTemplateReference) else ""
        )
        completion_scope = (
            "configuration:read"
            if argument.name in {"configuration_name", "source"}
            else "device:read"
            if argument.name == "device_id"
            else "project:read"
        )
        if not has_scopes((completion_scope,), fallback):
            return Completion(values=[], total=0, hasMore=False)
        context_arguments = context.arguments if context is not None else None
        result = service.complete_argument(
            argument.name,
            argument.value,
            context_arguments,
            resource_reference=resource_reference,
        )
        return Completion(
            values=result["values"],
            total=result["total"],
            hasMore=result["has_more"],
        )
