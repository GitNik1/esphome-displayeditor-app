from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ...errors import ApiError
from ...runtime import DeviceManager


def create_runtime_events_router(
    *,
    runtime: DeviceManager,
    authorize_websocket: Callable[[WebSocket, str], Awaitable[str | None]],
    viewer_snapshot: Callable[[], dict[str, Any]],
    viewer_event: Callable[[dict[str, Any]], dict[str, Any] | None],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["runtime events"])

    async def authorize(websocket: WebSocket) -> str | None:
        # The shared check comes first, so a client outside Ingress does not
        # learn whether the device runtime is switched on.
        user_id = await authorize_websocket(websocket, "device.states")
        if user_id is not None and not runtime.enabled:
            await websocket.close(code=4403, reason="capability_unavailable")
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
