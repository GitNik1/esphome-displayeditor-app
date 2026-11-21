from __future__ import annotations

import re
from collections.abc import Callable

from fastapi import APIRouter, Header, Request

from ...audit import AuditStore
from ...builder import BuilderManager
from ...errors import ApiError
from ...filesystem import DRAFT_UNCHECKED, FilesystemBackend
from ...firmware_workflow import WEB_ACTIONS, FirmwareWorkflow
from ...settings import Settings
from ...workflow import WorkflowStore
from ..schemas import InstallRequest, PublishRequest


def create_firmware_workflow_router(
    *,
    filesystem: FilesystemBackend,
    builder: BuilderManager,
    workflow: WorkflowStore,
    audit: AuditStore,
    settings: Settings,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/configurations", tags=["firmware workflow"])
    firmware = FirmwareWorkflow(settings, filesystem, workflow, audit, builder, WEB_ACTIONS)

    def checked_key(value: str | None) -> str | None:
        if value is None:
            return None
        key = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", key):
            raise ApiError(
                "invalid_idempotency_key",
                "Idempotency-Key must contain 8 to 128 safe ASCII characters.",
                422,
            )
        return key

    @router.post("/{name:path}/validate")
    async def validate(name: str, request: Request) -> dict:
        user_id = require_capability(request, "configuration.validate_esphome")
        return await firmware.validate(name, identity=user_id)

    @router.post("/{name:path}/compile", status_code=202)
    async def compile_configuration(
        name: str, request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        user_id = require_capability(request, "firmware.compile")
        return await firmware.start_job(
            "compile", name, identity=user_id, idempotency_key=checked_key(idempotency_key))

    @router.post("/{name:path}/install", status_code=202)
    async def install_configuration(
        name: str, body: InstallRequest, request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        if not body.confirmed:
            raise ApiError("upload_confirmation_required",
                           "Firmware installation requires explicit confirmation.", 409)
        user_id = require_capability(request, "firmware.upload")
        return await firmware.start_job(
            "install", name, identity=user_id, port=body.port,
            idempotency_key=checked_key(idempotency_key))

    @router.post("/{name:path}/publish")
    async def publish(name: str, body: PublishRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.publish")
        return await firmware.publish(
            name, body.expected_revision, identity=user_id,
            expected_draft_revision=body.expected_draft_revision or DRAFT_UNCHECKED)

    return router
