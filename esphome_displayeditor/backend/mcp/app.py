"""ASGI application factory for the separate MCP listener."""

from __future__ import annotations

from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..assistant_tools.limits import MCP_REQUEST_MAX_BYTES
from ..builder import BuilderManager
from ..settings import Settings
from .auth import BearerTokenMiddleware
from .configuration import (
    normalise_allowed_hosts,
    normalise_allowed_origins,
    validate_mcp_settings,
)
from .server import create_mcp_server
from .token_store import MCPTokenAuthenticator, MCPTokenStore


def create_mcp_app(settings: Settings | None = None, *, builder: BuilderManager | None = None):
    runtime_settings = settings or Settings.load()
    validate_mcp_settings(runtime_settings)
    if runtime_settings.mcp_mode == "disabled":
        raise RuntimeError("MCP is disabled in the add-on configuration.")

    authenticator = MCPTokenAuthenticator(
        MCPTokenStore(runtime_settings.data_root),
        runtime_settings.mcp_access_token,
        runtime_settings.mcp_access,
    )
    server = create_mcp_server(
        runtime_settings,
        require_bound_identity=True,
        builder=builder,
    )
    protocol_app = server.streamable_http_app(
        streamable_http_path="/mcp",
        max_request_body_size=MCP_REQUEST_MAX_BYTES,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=normalise_allowed_hosts(runtime_settings.mcp_allowed_hosts),
            allowed_origins=normalise_allowed_origins(
                runtime_settings.mcp_allowed_origins
            ),
        ),
        host="0.0.0.0",
    )

    async def health(_request: Request) -> JSONResponse:
        # Unauthenticated by design (used for the bounded loopback probe),
        # so it must not leak the configured access mode to anyone who can
        # merely reach the port. The Admin API already exposes the access
        # mode from settings to authenticated administrators.
        return JSONResponse({"status": "ok"})

    protocol_app.add_route("/health", health, methods=["GET"])
    protocol_app.add_middleware(
        BearerTokenMiddleware,
        authenticate=authenticator.authenticate,
        requests_per_minute=runtime_settings.api_rate_limit_per_minute,
        write_requests_per_minute=runtime_settings.write_rate_limit_per_minute,
        preauth_requests_per_minute=min(
            runtime_settings.api_rate_limit_per_minute,
            120,
        ),
    )
    return protocol_app
