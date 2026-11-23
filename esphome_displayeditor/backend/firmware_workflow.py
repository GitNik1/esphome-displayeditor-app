"""Validate, compile, install and publish - one set of rules for every caller.

The web API and the MCP tools used to carry their own copies of this
workflow, and they had drifted apart: MCP started jobs without the
per-configuration lock and without idempotency, published without checking
for a running firmware job, and the web API audited every installation as
port "OTA" whatever was asked for. Both now go through ``FirmwareWorkflow``;
they differ only in the audit action names.

The MCP listener runs in its own process with its own ``BuilderManager``
(see ``assistant_tools/firmware.py``), so the asyncio locks here guard one
process; the builder's job list and the SQLite ``WorkflowStore`` are what
both processes share.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .audit import AuditStore
from .builder import BuilderManager
from .errors import ApiError
from .filesystem import DRAFT_UNCHECKED, FilesystemBackend
from .settings import Settings
from .workflow import WorkflowStore

TERMINAL_JOB_STATUSES = frozenset(
    {"success", "succeeded", "completed", "done", "failed", "error", "cancelled", "canceled"}
)


@dataclass(frozen=True)
class AuditActions:
    validate: str
    compile: str
    install: str
    publish: str
    cancel: str


WEB_ACTIONS = AuditActions(
    "configuration.validate.esphome", "firmware.compile", "firmware.install",
    "configuration.publish", "firmware.cancel",
)
MCP_ACTIONS = AuditActions(
    "mcp.firmware.validate", "mcp.firmware.compile", "mcp.firmware.install",
    "mcp.configuration.publish", "mcp.firmware.cancel",
)


class FirmwareWorkflow:
    def __init__(
        self,
        settings: Settings,
        filesystem: FilesystemBackend,
        workflow: WorkflowStore,
        audit: AuditStore,
        builder: BuilderManager,
        actions: AuditActions,
    ) -> None:
        self.settings = settings
        self.filesystem = filesystem
        self.workflow = workflow
        self.audit = audit
        self.builder = builder
        self.actions = actions
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, name: str) -> asyncio.Lock:
        return self._locks.setdefault(name, asyncio.Lock())

    async def validate(self, name: str, *, identity: str) -> dict[str, Any]:
        before = self.filesystem.read_config(name)
        result = await self.builder.validate(name)
        after = self.filesystem.read_config(name)
        if after["revision"] != before["revision"]:
            self.workflow.invalidate_validation(name)
            self._audit(identity, self.actions.validate, name, before["revision"],
                        after["revision"], "validation_revision_conflict")
            raise ApiError(
                "validation_revision_conflict",
                "The active configuration changed while ESPHome was validating it.",
                409,
                {"validated_revision": before["revision"], "active_revision": after["revision"]},
            )
        proof = (self.workflow.record_validation(name, after["revision"], self.builder.esphome_version)
                 if result["valid"] else None)
        if proof is None:
            self.workflow.invalidate_validation(name)
        self._audit(identity, self.actions.validate, name, after["revision"], after["revision"],
                    "success" if result["valid"] else "validation_failed")
        return {**result, "revision": after["revision"],
                "validated_at": proof["validated_at"] if proof else None,
                "expires_in_seconds": self.settings.validation_max_age_seconds if proof else 0}

    async def start_job(
        self,
        operation: str,
        name: str,
        *,
        identity: str,
        port: str = "OTA",
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Start a compile or install job for a configuration validated in
        its current revision. A repeated ``idempotency_key`` returns the job
        it started the first time instead of starting a second one."""
        action = self.actions.compile if operation == "compile" else self.actions.install
        metadata = {"port": port} if operation == "install" else None
        try:
            async with self._lock(name):
                replay = self._replayed_job(idempotency_key, operation, name)
                if replay is not None:
                    return replay
                active = self.filesystem.read_config(name)
                self.workflow.require_validation(
                    name, active["revision"], self.settings.validation_max_age_seconds)
                await self._reject_parallel_job(name)
                latest = self.filesystem.read_config(name)
                if latest["revision"] != active["revision"]:
                    self.workflow.require_validation(
                        name, latest["revision"], self.settings.validation_max_age_seconds)
                job = (await self.builder.compile(name) if operation == "compile"
                       else await self.builder.install(name, port))
                if idempotency_key is not None:
                    self.workflow.record_job_request(
                        idempotency_key, operation, name, active["revision"], job)
        except ApiError as exc:
            self._audit(identity, action, name, None, None, exc.error, metadata=metadata)
            raise
        self._audit(identity, action, name, active["revision"], active["revision"], "accepted",
                    job_id=job["job_id"], metadata=metadata)
        return {"job": job, "revision": active["revision"], "idempotent_replay": False}

    async def publish(
        self,
        name: str,
        expected_revision: str,
        *,
        identity: str,
        expected_draft_revision: Any = DRAFT_UNCHECKED,
    ) -> dict[str, Any]:
        """Make the reviewed draft active - never while a firmware job for
        the configuration is still running."""
        try:
            async with self._lock(name):
                if self.builder.available:
                    await self._reject_parallel_job(name)
                # File locks, YAML parsing and fsync - off the event loop.
                result = await asyncio.to_thread(
                    self.filesystem.publish, name, expected_revision,
                    expected_draft_revision=expected_draft_revision)
                self.workflow.invalidate_validation(name)
        except ApiError as exc:
            self._audit(identity, self.actions.publish, name, expected_revision, None, exc.error)
            raise
        self._audit(identity, self.actions.publish, name, result["old_revision"],
                    result["revision"], "success")
        return result

    async def read_job(self, job_id: str) -> dict[str, Any]:
        return await self.builder.job(job_id)

    async def list_jobs(self) -> dict[str, Any]:
        jobs = await self.builder.jobs()
        return {"jobs": jobs, "count": len(jobs)}

    async def cancel_job(self, job_id: str, *, identity: str) -> dict[str, Any]:
        await self.builder.cancel(job_id)
        self._audit(identity, self.actions.cancel, job_id, None, None, "success", job_id=job_id)
        return {"job_id": job_id, "cancelled": True}

    def _replayed_job(self, key: str | None, operation: str, name: str) -> dict[str, Any] | None:
        if key is None:
            return None
        prior = self.workflow.job_request(key)
        if prior is None:
            return None
        if prior["operation"] != operation or prior["configuration"] != name:
            raise ApiError(
                "idempotency_conflict",
                "The idempotency key belongs to a different firmware request.",
                409,
                {"operation": prior["operation"], "configuration": prior["configuration"]},
            )
        return {"job": prior["job"], "revision": prior["revision"], "idempotent_replay": True}

    async def _reject_parallel_job(self, name: str) -> None:
        for job in await self.builder.jobs():
            if str(job.get("configuration", "")) != name:
                continue
            status = str(job.get("status", "")).strip().lower()
            if status not in TERMINAL_JOB_STATUSES:
                raise ApiError(
                    "job_already_running",
                    "A firmware job is already active for this configuration.",
                    409,
                    {"configuration": name, "job_id": job.get("job_id"),
                     "status": status or "unknown"},
                )

    def _audit(self, identity: str, action: str, configuration: str, old_revision: str | None,
               new_revision: str | None, result: str, *, job_id: str | None = None,
               metadata: dict[str, Any] | None = None) -> None:
        self.audit.record(user_id=identity, action=action, configuration=configuration,
                          old_revision=old_revision, new_revision=new_revision, result=result,
                          job_id=job_id, esphome_version=self.builder.esphome_version,
                          metadata=metadata)
