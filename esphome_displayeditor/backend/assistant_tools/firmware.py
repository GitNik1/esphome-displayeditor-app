"""Async firmware validate/compile/install operations for MCP clients.

Builder access is inherently async (WebSocket-backed) and this mirrors the
existing REST ``firmware_workflow.py`` logic exactly, adapted for a
transport-neutral async caller. The MCP listener runs as a separate process
from the main app (see run.sh), so it cannot share the main app's
``BuilderManager`` - that instance owns an ``asyncio.Lock`` and background
probe task bound to the main app's own event loop. Instead, this gets its
own ``BuilderManager`` talking to the same ``builder_url``; the two never
share in-process state, only the external Device Builder and the SQLite-
backed ``WorkflowStore``, which is already designed for cross-process use.
"""

from __future__ import annotations

from typing import Any

from ..audit import AuditStore
from ..builder import BuilderManager
from ..errors import ApiError
from ..filesystem import FilesystemBackend
from ..settings import Settings
from ..workflow import WorkflowStore
from .secrets_guard import assert_not_secrets_file

_TERMINAL_JOB_STATUSES = frozenset(
    {
        "success",
        "succeeded",
        "completed",
        "done",
        "failed",
        "error",
        "cancelled",
        "canceled",
    }
)


class FirmwareService:
    def __init__(
        self,
        settings: Settings,
        filesystem: FilesystemBackend,
        workflow: WorkflowStore,
        audit: AuditStore,
        *,
        builder: BuilderManager | None = None,
    ) -> None:
        self.settings = settings
        self.filesystem = filesystem
        self.workflow = workflow
        self.audit = audit
        self.builder = builder if builder is not None else BuilderManager(settings)

    async def validate(self, name: str, *, identity: str) -> dict[str, Any]:
        assert_not_secrets_file(name)
        before = self.filesystem.read_config(name)
        result = await self.builder.validate(name)
        after = self.filesystem.read_config(name)
        if after["revision"] != before["revision"]:
            self.workflow.invalidate_validation(name)
            self._audit(
                identity,
                "mcp.firmware.validate",
                name,
                before["revision"],
                after["revision"],
                "validation_revision_conflict",
            )
            raise ApiError(
                "validation_revision_conflict",
                "The active configuration changed while ESPHome was validating it.",
                409,
                {
                    "validated_revision": before["revision"],
                    "active_revision": after["revision"],
                },
            )
        proof = (
            self.workflow.record_validation(
                name, after["revision"], self.builder.esphome_version
            )
            if result["valid"]
            else None
        )
        if proof is None:
            self.workflow.invalidate_validation(name)
        self._audit(
            identity,
            "mcp.firmware.validate",
            name,
            after["revision"],
            after["revision"],
            "success" if result["valid"] else "validation_failed",
        )
        return {
            **result,
            "revision": after["revision"],
            "validated_at": proof["validated_at"] if proof else None,
            "expires_in_seconds": (
                self.settings.validation_max_age_seconds if proof else 0
            ),
        }

    async def start_build(self, name: str, *, identity: str) -> dict[str, Any]:
        return await self._start_job("compile", name, identity=identity)

    async def start_install(
        self,
        name: str,
        *,
        confirmed: bool,
        port: str = "OTA",
        identity: str,
    ) -> dict[str, Any]:
        if not confirmed:
            raise ApiError(
                "upload_confirmation_required",
                "Firmware installation requires explicit confirmation.",
                409,
            )
        return await self._start_job("install", name, identity=identity, port=port)

    async def _start_job(
        self,
        operation: str,
        name: str,
        *,
        identity: str,
        port: str = "OTA",
    ) -> dict[str, Any]:
        assert_not_secrets_file(name)
        active = self.filesystem.read_config(name)
        self.workflow.require_validation(
            name, active["revision"], self.settings.validation_max_age_seconds
        )
        await self._reject_parallel_job(name)
        latest = self.filesystem.read_config(name)
        if latest["revision"] != active["revision"]:
            self.workflow.require_validation(
                name, latest["revision"], self.settings.validation_max_age_seconds
            )
        action = "mcp.firmware.compile" if operation == "compile" else "mcp.firmware.install"
        metadata = {"port": port} if operation == "install" else None
        try:
            job = (
                await self.builder.compile(name)
                if operation == "compile"
                else await self.builder.install(name, port)
            )
        except ApiError as exc:
            self._audit(identity, action, name, None, None, exc.error, metadata=metadata)
            raise
        self._audit(
            identity,
            action,
            name,
            active["revision"],
            active["revision"],
            "accepted",
            job_id=job["job_id"],
            metadata=metadata,
        )
        return {"job": job, "revision": active["revision"]}

    async def _reject_parallel_job(self, name: str) -> None:
        for job in await self.builder.jobs():
            if str(job.get("configuration", "")) != name:
                continue
            status = str(job.get("status", "")).strip().lower()
            if status not in _TERMINAL_JOB_STATUSES:
                raise ApiError(
                    "job_already_running",
                    "A firmware job is already active for this configuration.",
                    409,
                    {
                        "configuration": name,
                        "job_id": job.get("job_id"),
                        "status": status or "unknown",
                    },
                )

    async def read_job(self, job_id: str) -> dict[str, Any]:
        return await self.builder.job(job_id)

    async def list_jobs(self) -> dict[str, Any]:
        jobs = await self.builder.jobs()
        return {"jobs": jobs, "count": len(jobs)}

    async def cancel_job(self, job_id: str, *, identity: str) -> dict[str, Any]:
        await self.builder.cancel(job_id)
        self._audit(
            identity,
            "mcp.firmware.cancel",
            job_id,
            None,
            None,
            "success",
            job_id=job_id,
        )
        return {"job_id": job_id, "cancelled": True}

    def _audit(
        self,
        identity: str,
        action: str,
        configuration: str,
        old_revision: str | None,
        new_revision: str | None,
        result: str,
        *,
        job_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.audit.record(
            user_id=identity,
            action=action,
            configuration=configuration,
            old_revision=old_revision,
            new_revision=new_revision,
            result=result,
            job_id=job_id,
            esphome_version=self.builder.esphome_version,
            metadata=metadata,
        )
