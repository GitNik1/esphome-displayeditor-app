"""Administrator API for hashed, expiring MCP client tokens."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...audit import AuditStore
from ...assistant_tools.limits import MCP_ACTIVE_TOKEN_LIMIT, MCP_PORT
from ...errors import ApiError
from ...mcp.identity import READ_SCOPES, WRITE_SCOPES
from ...mcp.health import probe_mcp_listener
from ...mcp.token_store import MCPTokenStore
from ...settings import Settings
from ..schemas import MCPTokenCreateRequest


def create_admin_mcp_router(
    *,
    store: MCPTokenStore,
    audit: AuditStore,
    settings: Settings,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/admin/mcp", tags=["MCP administration"])
    allowed_scopes = READ_SCOPES | (
        WRITE_SCOPES if settings.mcp_access == "project_write" else frozenset()
    )

    @router.get("/tokens")
    async def list_tokens(request: Request) -> dict:
        require_capability(request, "mcp.manage")
        return {
            "clients": store.list(),
            "allowed_scopes": sorted(allowed_scopes),
            "maximum": MCP_ACTIVE_TOKEN_LIMIT,
        }

    @router.get("/status")
    async def listener_status(request: Request) -> dict:
        require_capability(request, "mcp.manage")
        store.list()  # refresh the skipped-record diagnostic below
        return {
            "mode": settings.mcp_mode,
            "access": settings.mcp_access,
            "port": MCP_PORT,
            "path": "/mcp",
            "health_path": "/health",
            "allowed_hosts": list(settings.mcp_allowed_hosts),
            "configured": settings.mcp_mode == "lan",
            "skipped_invalid_token_records": store.skipped_invalid_record_count,
        }

    @router.post("/test")
    async def test_listener(request: Request) -> dict:
        require_capability(request, "mcp.manage")
        if settings.mcp_mode != "lan":
            return {
                "reachable": False,
                "status": "disabled",
                "checked_at": None,
                "latency_ms": None,
            }
        return await probe_mcp_listener()

    @router.post("/tokens", status_code=201)
    async def create_token(
        body: MCPTokenCreateRequest,
        request: Request,
    ) -> JSONResponse:
        user_id = require_capability(request, "mcp.manage")
        requested = frozenset(body.scopes)
        if not requested <= allowed_scopes:
            raise ApiError(
                "forbidden_mcp_token_scope",
                "The requested scope exceeds the configured MCP access mode.",
                403,
                {"allowed_scopes": sorted(allowed_scopes)},
            )
        created = store.create(
            body.name,
            body.scopes,
            body.expires_in_seconds,
        )
        client = created["client"]
        audit.record(
            user_id=user_id,
            action="mcp.token.create",
            configuration=client["id"],
            old_revision=None,
            new_revision=None,
            result="success",
            metadata={
                "name": client["name"],
                "scopes": client["scopes"],
                "expires_at": client["expires_at"],
            },
        )
        return JSONResponse(
            created,
            status_code=201,
            headers={"Cache-Control": "no-store"},
        )

    @router.delete("/tokens/{token_id}")
    async def revoke_token(token_id: str, request: Request) -> dict:
        user_id = require_capability(request, "mcp.manage")
        client = store.revoke(token_id)
        audit.record(
            user_id=user_id,
            action="mcp.token.revoke",
            configuration=client["id"],
            old_revision=None,
            new_revision=None,
            result="success",
            metadata={"name": client["name"]},
        )
        return {"client": client}

    return router
