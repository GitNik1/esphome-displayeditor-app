from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Query, Request

from ...runtime import DeviceManager


def create_devices_router(
    *,
    runtime: DeviceManager,
    require_capability: Callable[[Request, str], str],
    viewer_snapshot: Callable[[], dict],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["devices"])

    @router.get("/devices")
    async def list_devices(request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.info")
        return {"devices": runtime.list_devices()}

    @router.get("/devices/{device_id}")
    async def get_device(device_id: str, request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.info")
        return runtime.get_device(device_id)

    @router.get("/devices/{device_id}/info")
    async def get_info(device_id: str, request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.info")
        return {"device_id": device_id, "info": runtime.get_info(device_id)}

    @router.get("/devices/{device_id}/entities")
    async def get_entities(device_id: str, request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.entities")
        return {"device_id": device_id, "entities": runtime.get_entities(device_id)}

    @router.get("/devices/{device_id}/states")
    async def get_states(device_id: str, request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.states")
        return {"device_id": device_id, "states": runtime.get_states(device_id)}

    @router.get("/devices/{device_id}/logs")
    async def get_logs(
        device_id: str,
        request: Request,
        limit: int = Query(default=200, ge=1, le=1000),
    ) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.logs")
        return {"device_id": device_id, "logs": runtime.get_logs(device_id, limit)}

    @router.get("/viewer/runtime", tags=["viewer"])
    async def get_viewer_runtime(request: Request) -> dict:
        runtime.ensure_enabled()
        require_capability(request, "device.states")
        return viewer_snapshot()

    return router
