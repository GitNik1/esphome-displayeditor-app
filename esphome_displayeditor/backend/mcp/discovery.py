"""MCP registration for layout previews and registered-device discovery."""

from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from ..assistant_tools import AssistantToolService
from .identity import MCPAuthorization
from .support import READ_ONLY, scoped_resource_json, scoped_tool_result


def register_discovery_tools(
    server: MCPServer,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    # display_preview is registered in apps_api.py: it is UI-bound to the
    # MCP Apps Preview view (ui://display-editor/preview) and must be
    # registered via the Apps extension, not this server.tool() decorator.

    @server.tool(name="display_device_read", annotations=READ_ONLY)
    def display_device_read(
        device_id: str = "",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        """List registered devices or read one secret-free endpoint summary."""
        if device_id:
            return scoped_tool_result(
                ("device:read",),
                fallback,
                lambda _authorization: service.read_device(device_id),
            )
        return scoped_tool_result(
            ("device:read",),
            fallback,
            lambda _authorization: service.list_devices(limit, cursor),
        )


def register_discovery_resources(
    server: MCPServer,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    @server.resource(
        "esphome-display://devices",
        name="devices",
        title="Registered ESPHome devices",
        mime_type="application/json",
    )
    def devices_resource() -> str:
        return scoped_resource_json(
            ("device:read",),
            fallback,
            lambda _authorization: service.list_devices(),
        )

    @server.resource(
        "esphome-display://devices/{device_id}/summary",
        name="device-summary",
        title="Registered ESPHome device summary",
        mime_type="application/json",
    )
    def device_summary_resource(device_id: str) -> str:
        return scoped_resource_json(
            ("device:read",),
            fallback,
            lambda _authorization: service.read_device(device_id),
        )
