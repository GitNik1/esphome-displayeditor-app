from __future__ import annotations

import asyncio
import re
from collections.abc import Callable

from fastapi import APIRouter, Header, Request

from ...audit import AuditStore
from ...builder import BuilderManager
from ...errors import ApiError
from ...filesystem import FilesystemBackend
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
    locks: dict[str, asyncio.Lock] = {}

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

    def replayed_job(key: str | None, operation: str, name: str) -> dict | None:
        if key is None:
            return None
        prior = workflow.job_request(key)
        if prior is None:
            return None
        if prior["operation"] != operation or prior["configuration"] != name:
            raise ApiError(
                "idempotency_conflict",
                "The idempotency key belongs to a different firmware request.",
                409,
                {"operation": prior["operation"], "configuration": prior["configuration"]},
            )
        return {"job": prior["job"], "revision": prior["revision"],
                "idempotent_replay": True}

    async def reject_parallel_job(name: str) -> None:
        terminal = {"success", "succeeded", "completed", "done", "failed", "error",
                    "cancelled", "canceled"}
        for job in await builder.jobs():
            if str(job.get("configuration", "")) != name:
                continue
            status = str(job.get("status", "")).strip().lower()
            if status not in terminal:
                raise ApiError(
                    "job_already_running",
                    "A firmware job is already active for this configuration.",
                    409,
                    {"configuration": name, "job_id": job.get("job_id"),
                     "status": status or "unknown"},
                )

    @router.post("/{name:path}/validate")
    async def validate(name: str, request: Request) -> dict:
        user_id = require_capability(request, "configuration.validate_esphome")
        before = filesystem.read_config(name)
        result = await builder.validate(name)
        after = filesystem.read_config(name)
        if after["revision"] != before["revision"]:
            workflow.invalidate_validation(name)
            _audit(audit, user_id, "configuration.validate.esphome", name,
                   before["revision"], after["revision"], "validation_revision_conflict", builder)
            raise ApiError(
                "validation_revision_conflict",
                "The active configuration changed while ESPHome was validating it.",
                409,
                {"validated_revision": before["revision"], "active_revision": after["revision"]},
            )
        proof = (workflow.record_validation(name, after["revision"], builder.esphome_version)
                 if result["valid"] else None)
        if proof is None:
            workflow.invalidate_validation(name)
        _audit(audit, user_id, "configuration.validate.esphome", name,
               after["revision"], after["revision"],
               "success" if result["valid"] else "validation_failed", builder)
        return {**result, "revision": after["revision"],
                "validated_at": proof["validated_at"] if proof else None,
                "expires_in_seconds": settings.validation_max_age_seconds if proof else 0}

    async def start_job(
        name: str, operation: str, key: str | None, port: str = "OTA"
    ) -> tuple[dict, dict]:
        async with locks.setdefault(name, asyncio.Lock()):
            replay = replayed_job(key, operation, name)
            if replay is not None:
                return replay, {}
            active = filesystem.read_config(name)
            workflow.require_validation(name, active["revision"], settings.validation_max_age_seconds)
            await reject_parallel_job(name)
            latest = filesystem.read_config(name)
            if latest["revision"] != active["revision"]:
                workflow.require_validation(name, latest["revision"], settings.validation_max_age_seconds)
            job = (await builder.compile(name) if operation == "compile"
                   else await builder.install(name, port))
            if key is not None:
                workflow.record_job_request(key, operation, name, active["revision"], job)
            return {"job": job, "revision": active["revision"],
                    "idempotent_replay": False}, active

    @router.post("/{name:path}/compile", status_code=202)
    async def compile_configuration(
        name: str, request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return await _run_job(name, "compile", checked_key(idempotency_key), request,
                              require_capability, audit, builder, start_job)

    @router.post("/{name:path}/install", status_code=202)
    async def install_configuration(
        name: str, body: InstallRequest, request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        if not body.confirmed:
            raise ApiError("upload_confirmation_required",
                           "Firmware installation requires explicit confirmation.", 409)
        return await _run_job(name, "install", checked_key(idempotency_key), request,
                              require_capability, audit, builder, start_job, body.port)

    @router.post("/{name:path}/publish")
    async def publish(name: str, body: PublishRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.publish")
        try:
            async with locks.setdefault(name, asyncio.Lock()):
                if builder.available:
                    await reject_parallel_job(name)
                result = filesystem.publish(name, body.expected_revision)
                workflow.invalidate_validation(name)
        except ApiError as exc:
            _audit(audit, user_id, "configuration.publish", name,
                   body.expected_revision, None, exc.error)
            raise
        _audit(audit, user_id, "configuration.publish", name,
               result["old_revision"], result["revision"], "success")
        return result

    return router


async def _run_job(
    name, operation, key, request, require_capability, audit, builder, start_job,
    port="OTA",
):
    capability = "firmware.compile" if operation == "compile" else "firmware.upload"
    user_id = require_capability(request, capability)
    try:
        result, active = await start_job(name, operation, key, port)
    except ApiError as exc:
        _audit(audit, user_id, f"firmware.{operation}", name, None, None, exc.error,
               builder, metadata={"port": "OTA"} if operation == "install" else None)
        raise
    if result["idempotent_replay"]:
        return result
    _audit(audit, user_id, f"firmware.{operation}", name,
           active["revision"], active["revision"], "accepted", builder,
           job_id=result["job"]["job_id"],
           metadata={"port": "OTA"} if operation == "install" else None)
    return result


def _audit(audit, user_id, action, name, old_revision, new_revision, result,
           builder=None, job_id=None, metadata=None):
    audit.record(user_id=user_id, action=action, configuration=name,
                 old_revision=old_revision, new_revision=new_revision, result=result,
                 job_id=job_id, esphome_version=builder.esphome_version if builder else None,
                 metadata=metadata)
