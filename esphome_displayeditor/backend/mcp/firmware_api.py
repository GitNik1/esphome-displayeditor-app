"""MCP registration for ESPHome validate/compile/install operations.

Only registered when the Device Builder backend is actually configured
(``access_level: write_with_builder``); otherwise these tools would always
fail with ``builder_unavailable`` and just clutter a client's tool list.
"""

from __future__ import annotations

from typing import Any, Literal

from mcp.server import MCPServer

from ..assistant_tools import AssistantToolService
from ..errors import ApiError
from .identity import MCPAuthorization
from .support import FIRMWARE_ACTION, VALIDATE, scoped_async_tool_result


def register_firmware_api(
    server: MCPServer,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    @server.tool(name="display_configuration_validate", annotations=VALIDATE)
    async def display_configuration_validate(name: str) -> dict[str, Any]:
        """Validate the active ESPHome YAML and record the proof a build needs."""
        return await scoped_async_tool_result(
            ("configuration:validate",),
            fallback,
            lambda authorization: service.firmware.validate(
                name, identity=authorization.identity
            ),
        )

    @server.tool(name="display_build", annotations=FIRMWARE_ACTION)
    async def display_build(
        action: Literal["start", "status", "cancel", "list"],
        name: str = "",
        job_id: str = "",
    ) -> dict[str, Any]:
        """Start a compile job for a validated configuration, or check/cancel/list jobs."""

        async def run(authorization: MCPAuthorization) -> dict[str, Any]:
            if action == "start":
                if not name:
                    raise ApiError(
                        "configuration_name_required",
                        "name is required for action=start.",
                        422,
                    )
                return await service.firmware.start_build(name, identity=authorization.identity)
            if action == "status":
                if not job_id:
                    raise ApiError(
                        "job_id_required", "job_id is required for action=status.", 422
                    )
                return {"job": await service.firmware.read_job(job_id)}
            if action == "cancel":
                if not job_id:
                    raise ApiError(
                        "job_id_required", "job_id is required for action=cancel.", 422
                    )
                return await service.firmware.cancel_job(
                    job_id, identity=authorization.identity
                )
            return await service.firmware.list_jobs()

        return await scoped_async_tool_result(("firmware:compile",), fallback, run)

    @server.tool(name="display_install", annotations=FIRMWARE_ACTION)
    async def display_install(
        name: str,
        confirmed: bool = False,
        port: Literal["OTA"] = "OTA",
    ) -> dict[str, Any]:
        """Flash a validated, compiled configuration to its known device over OTA.

        Requires explicit confirmed=true; this flashes a real device and is
        never inferred from other arguments.
        """
        return await scoped_async_tool_result(
            ("firmware:install",),
            fallback,
            lambda authorization: service.firmware.start_install(
                name, confirmed=confirmed, port=port, identity=authorization.identity
            ),
        )
