from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Query, Request

from ...audit import AuditStore


def create_audit_router(
    *,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/audit", tags=["audit"])

    @router.get("")
    async def get_audit(
        request: Request, limit: int = Query(default=100, ge=1, le=500)
    ) -> dict:
        require_capability(request, "audit.read")
        return {"events": audit.recent(limit)}

    return router
