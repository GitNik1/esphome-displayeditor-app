from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request, Response, WebSocket, WebSocketDisconnect

from ...audit import AuditStore
from ...builder import BuilderManager
from ...builder.adapter import BuilderAdapterError, sanitize_output
from ...errors import ApiError


def create_jobs_router(
    *,
    builder: BuilderManager,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
    authorize_websocket: Callable[[WebSocket, str], Awaitable[str | None]],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

    @router.get("")
    async def list_jobs(request: Request) -> dict:
        require_capability(request, "firmware.compile")
        return {"jobs": await builder.jobs()}

    @router.get("/{job_id}")
    async def get_job(job_id: str, request: Request) -> dict:
        require_capability(request, "firmware.compile")
        return {"job": await builder.job(job_id)}

    @router.post("/{job_id}/cancel", status_code=204)
    async def cancel_job(job_id: str, request: Request) -> Response:
        user_id = require_capability(request, "firmware.compile")
        job = await builder.job(job_id)
        await builder.cancel(job_id)
        audit.record(
            user_id=user_id,
            action="firmware.job.cancel",
            configuration=str(job.get("configuration", "")),
            old_revision=None,
            new_revision=None,
            result="success",
            job_id=job_id,
            esphome_version=builder.esphome_version,
        )
        return Response(status_code=204)

    @router.websocket("/events")
    async def job_events(websocket: WebSocket) -> None:
        if await authorize_websocket(websocket, "firmware.compile") is None:
            return
        await websocket.accept()
        backoff = 1

        async def forward(event: dict[str, Any]) -> None:
            data = event.get("data")
            if isinstance(data, dict) and "line" in data:
                data = {**data, "line": sanitize_output(data["line"])}
            elif event.get("event") == "output":
                data = sanitize_output(data)
            await websocket.send_json(
                {"type": "builder_job", "event": event.get("event"), "data": data}
            )

        try:
            while True:
                try:
                    await websocket.send_json(
                        {"type": "builder_status", "builder": builder.status()}
                    )
                    await builder.follow_jobs(forward)
                    raise BuilderAdapterError(
                        "builder_stream_ended", "The Device Builder event stream ended."
                    )
                except (BuilderAdapterError, ApiError):
                    await websocket.send_json(
                        {"type": "resync_required", "builder": builder.status()}
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                    await builder.probe()
        except (WebSocketDisconnect, RuntimeError):
            pass

    return router
