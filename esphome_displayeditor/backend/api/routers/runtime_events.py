from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ...errors import ApiError
from ...runtime import DeviceManager
from ...security import RateLimiter
from ...settings import Settings, capabilities


def create_runtime_events_router(
    *,
    runtime: DeviceManager,
    settings: Settings,
    rate_limiter: RateLimiter,
    allow_direct_access: bool,
    trusted_ingress_hosts: set[str],
    viewer_snapshot: Callable[[], dict[str, Any]],
    viewer_event: Callable[[dict[str, Any]], dict[str, Any] | None],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["runtime events"])

    async def authorize(websocket: WebSocket) -> str | None:
        if not runtime.enabled:
            await websocket.close(code=4403, reason="capability_unavailable")
            return None
        client_host = websocket.client.host if websocket.client else "unknown"
        if not allow_direct_access and client_host not in trusted_ingress_hosts:
            await websocket.close(code=4403, reason="ingress_required")
            return None
        user_id = websocket.headers.get("X-Remote-User-Id", "").strip() or None
        if not user_id and os.getenv("ESPHOME_ALLOW_ANONYMOUS_WRITE") == "1":
            user_id, role = "local-development", "administrator"
        else:
            role = settings.role_for(user_id)
        if not user_id or not capabilities(settings, role).get("device.states", False):
            await websocket.close(code=4403, reason="permission_denied")
            return None
        if not rate_limiter.check(user_id, write=False).allowed:
            await websocket.close(code=4429, reason="rate_limit_exceeded")
            return None
        return user_id

    @router.websocket("/devices/events")
    async def device_events(websocket: WebSocket) -> None:
        if await authorize(websocket) is None:
            return
        device_filter = websocket.query_params.get("device_id")
        if device_filter:
            try:
                runtime.registry.get(device_filter)
            except ApiError:
                await websocket.close(code=4404, reason="device_not_found")
                return
        await websocket.accept()
        queue = runtime.subscribe()
        try:
            await websocket.send_json(
                {
                    "type": "devices",
                    "devices": [
                        device
                        for device in runtime.list_devices()
                        if not device_filter or device["id"] == device_filter
                    ],
                }
            )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except TimeoutError:
                    event = {"type": "heartbeat"}
                if not device_filter or event.get("device_id") in {None, device_filter}:
                    await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            runtime.unsubscribe(queue)

    @router.websocket("/viewer/runtime/events")
    async def viewer_runtime_events(websocket: WebSocket) -> None:
        if await authorize(websocket) is None:
            return
        await websocket.accept()
        queue = runtime.subscribe()
        try:
            await websocket.send_json(viewer_snapshot())
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except TimeoutError:
                    await websocket.send_json({"type": "heartbeat"})
                    continue
                filtered = viewer_event(event)
                if filtered is not None:
                    await websocket.send_json(filtered)
        except WebSocketDisconnect:
            pass
        finally:
            runtime.unsubscribe(queue)

    return router
