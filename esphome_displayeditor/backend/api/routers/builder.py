from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from ...builder import BuilderManager


def create_builder_router(
    *,
    builder: BuilderManager,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/builder", tags=["builder"])

    @router.get("/status")
    async def builder_status() -> dict:
        return builder.status()

    @router.post("/probe")
    async def probe_builder(request: Request) -> dict:
        require_capability(request, "builder.manage")
        return await builder.probe()

    return router
