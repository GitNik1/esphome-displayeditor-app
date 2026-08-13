from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request, Response

from ...audit import AuditStore
from ...errors import ApiError
from ...runtime import DeviceManager
from ..schemas import DeviceRequest, DeviceSecretRequest


def create_admin_devices_router(
    *,
    runtime: DeviceManager,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/admin", tags=["device administration"])

    @router.post("/devices", status_code=201)
    async def create_device(body: DeviceRequest, request: Request) -> dict:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        try:
            runtime.registry.get(body.id)
        except ApiError as exc:
            if exc.error != "device_not_found":
                raise
        else:
            raise ApiError("device_exists", "A device with this id already exists.", 409)
        device = runtime.registry.upsert(body.model_dump())
        await runtime.restart(device.id)
        _record(audit, user_id, "device.create", device.id)
        return runtime.get_device(device.id)

    @router.put("/devices/{device_id}")
    async def update_device(
        device_id: str, body: DeviceRequest, request: Request
    ) -> dict:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime.registry.get(device_id)
        device = runtime.registry.upsert(body.model_dump(), expected_id=device_id)
        await runtime.restart(device.id)
        _record(audit, user_id, "device.update", device.id)
        return runtime.get_device(device.id)

    @router.delete("/devices/{device_id}", status_code=204)
    async def delete_device(device_id: str, request: Request) -> Response:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime.registry.delete(device_id)
        await runtime.remove(device_id)
        _record(audit, user_id, "device.delete", device_id)
        return Response(status_code=204)

    @router.put("/device-secrets/{key_ref}", status_code=204)
    async def set_device_secret(
        key_ref: str, body: DeviceSecretRequest, request: Request
    ) -> Response:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime.secrets.set(key_ref, body.encryption_key.get_secret_value())
        await runtime.refresh_key_reference(key_ref)
        _record(audit, user_id, "device.secret.update", key_ref)
        return Response(status_code=204)

    @router.delete("/device-secrets/{key_ref}", status_code=204)
    async def delete_device_secret(key_ref: str, request: Request) -> Response:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime.secrets.delete(key_ref)
        await runtime.refresh_key_reference(key_ref)
        _record(audit, user_id, "device.secret.delete", key_ref)
        return Response(status_code=204)

    @router.post("/devices/{device_id}/reconnect", status_code=204)
    async def reconnect_device(device_id: str, request: Request) -> Response:
        runtime.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime.registry.get(device_id)
        await runtime.restart(device_id)
        _record(audit, user_id, "device.reconnect", device_id)
        return Response(status_code=204)

    return router


def _record(audit: AuditStore, user_id: str, action: str, subject: str) -> None:
    audit.record(
        user_id=user_id,
        action=action,
        configuration=subject,
        old_revision=None,
        new_revision=None,
        result="success",
    )
