from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from ...builder import BuilderManager
from ...settings import Settings, capabilities


def create_system_router(
    *,
    version: str,
    settings: Settings,
    builder: BuilderManager,
    request_identity: Callable[[Request], tuple[str | None, str]],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["system"])

    @router.get("/health")
    async def health() -> dict:
        return {"status": "ok", "version": version}

    @router.get("/system")
    async def system(request: Request) -> dict:
        user_id, role = request_identity(request)
        return {
            "version": version,
            "access_level": settings.access_level,
            "mdi_local": settings.mdi_local,
            "user": {
                "id": user_id,
                "name": request.headers.get("X-Remote-User-Name"),
                "display_name": request.headers.get("X-Remote-User-Display-Name"),
                "role": role,
            },
            "backends": {
                "configuration": "disabled" if settings.access_level == "none" else "filesystem",
                "runtime": settings.runtime_provider,
                "builder": builder.state,
            },
            "builder": builder.status(),
        }

    @router.get("/capabilities")
    async def get_capabilities(request: Request) -> dict:
        _user_id, role = request_identity(request)
        return {
            "access_level": settings.access_level,
            "role": role,
            "capabilities": capabilities(settings, role, builder_available=builder.available),
        }

    return router
