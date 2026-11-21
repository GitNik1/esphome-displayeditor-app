"""MCP entry points for validate/compile/install/publish.

The rules themselves live in ``backend/firmware_workflow.py`` and are shared
with the web API; this layer adds what is specific to MCP clients: no
operation may touch ``secrets.yaml``, publishing needs the add-on's MCP write
access, and audit entries carry ``mcp.*`` action names.

The MCP listener runs as a separate process from the main app (see run.sh),
so it cannot share the main app's ``BuilderManager`` - that instance owns an
``asyncio.Lock`` and a background probe task bound to the main app's event
loop. It gets its own ``BuilderManager`` talking to the same
``builder_url``; the two processes share only the external Device Builder and
the SQLite-backed ``WorkflowStore``.
"""

from __future__ import annotations

from typing import Any

from ..audit import AuditStore
from ..builder import BuilderManager
from ..errors import ApiError
from ..filesystem import DRAFT_UNCHECKED, FilesystemBackend
from ..firmware_workflow import MCP_ACTIONS, FirmwareWorkflow
from ..settings import Settings
from ..workflow import WorkflowStore
from .secrets_guard import assert_not_secrets_file


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
        self.builder = builder if builder is not None else BuilderManager(settings)
        self._workflow = FirmwareWorkflow(
            settings, filesystem, workflow, audit, self.builder, MCP_ACTIONS)

    async def validate(self, name: str, *, identity: str) -> dict[str, Any]:
        assert_not_secrets_file(name)
        return await self._workflow.validate(name, identity=identity)

    async def start_build(self, name: str, *, identity: str) -> dict[str, Any]:
        assert_not_secrets_file(name)
        return _job_result(await self._workflow.start_job("compile", name, identity=identity))

    async def start_install(
        self, name: str, *, confirmed: bool, port: str = "OTA", identity: str
    ) -> dict[str, Any]:
        if not confirmed:
            raise ApiError(
                "upload_confirmation_required",
                "Firmware installation requires explicit confirmation.",
                409,
            )
        assert_not_secrets_file(name)
        return _job_result(
            await self._workflow.start_job("install", name, identity=identity, port=port))

    async def publish(
        self,
        name: str,
        expected_revision: str,
        *,
        identity: str,
        expected_draft_revision: str | None = None,
    ) -> dict[str, Any]:
        """Publish an already-reviewed draft as the active ESPHome YAML.

        There is no separate propose step: the draft's content was reviewed
        when it was created or merged (``display_configuration_draft_propose``
        / ``display_changeset_apply``); publishing is the further, separate
        and revision-checked step that makes it active. With
        ``expected_draft_revision`` a draft changed since review is refused.
        """
        if self.settings.mcp_access != "project_write" or self.settings.access_level not in {
            "write",
            "write_with_builder",
        }:
            raise ApiError(
                "mcp_write_disabled",
                "MCP project writes are disabled by the app configuration.",
                403,
            )
        assert_not_secrets_file(name)
        return await self._workflow.publish(
            name, expected_revision, identity=identity,
            expected_draft_revision=expected_draft_revision or DRAFT_UNCHECKED)

    async def read_job(self, job_id: str) -> dict[str, Any]:
        return await self._workflow.read_job(job_id)

    async def list_jobs(self) -> dict[str, Any]:
        return await self._workflow.list_jobs()

    async def cancel_job(self, job_id: str, *, identity: str) -> dict[str, Any]:
        return await self._workflow.cancel_job(job_id, identity=identity)


def _job_result(result: dict[str, Any]) -> dict[str, Any]:
    # MCP clients have no idempotency key, so the flag would always be false.
    return {"job": result["job"], "revision": result["revision"]}
