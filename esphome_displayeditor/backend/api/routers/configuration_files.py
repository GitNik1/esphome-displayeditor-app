from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Query, Request, Response

from ...audit import AuditStore
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ..schemas import DraftRequest


def create_configuration_files_router(
    *,
    filesystem: FilesystemBackend,
    audit: AuditStore,
    ensure_capability_available: Callable[[str], None],
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/configurations", tags=["configurations"])

    @router.get("")
    async def list_configurations() -> dict:
        ensure_capability_available("configuration.list")
        return {"configurations": filesystem.list_configs()}

    @router.get("/{name:path}/draft")
    async def get_draft(name: str) -> dict:
        ensure_capability_available("configuration.read")
        return filesystem.read_draft(name)

    @router.put("/{name:path}/draft")
    async def put_draft(name: str, body: DraftRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.write_draft")
        old_revision = None
        try:
            try:
                old_revision = filesystem.read_draft(name)["revision"]
            except ApiError as exc:
                if exc.error != "draft_not_found":
                    raise
            result = filesystem.save_draft(name, body.content)
        except ApiError as exc:
            _record(audit, user_id, "configuration.draft.save", name,
                    old_revision, None, exc.error)
            raise
        _record(audit, user_id, "configuration.draft.save", name,
                old_revision, result["revision"], "success")
        return result

    @router.delete("/{name:path}/draft", status_code=204)
    async def delete_draft(name: str, request: Request) -> Response:
        user_id = require_capability(request, "configuration.write_draft")
        old_revision = None
        try:
            old_revision = filesystem.read_draft(name)["revision"]
            filesystem.delete_draft(name)
        except ApiError as exc:
            _record(audit, user_id, "configuration.draft.delete", name,
                    old_revision, None, exc.error)
            raise
        _record(audit, user_id, "configuration.draft.delete", name,
                old_revision, None, "success")
        return Response(status_code=204)

    @router.get("/{name:path}/diff")
    async def get_diff(name: str) -> dict:
        ensure_capability_available("configuration.read")
        return filesystem.diff(name)

    @router.post("/{name:path}/check-yaml")
    async def check_yaml(
        name: str,
        source: str = Query(default="draft", pattern="^(draft|active)$"),
    ) -> dict:
        ensure_capability_available("configuration.validate_yaml")
        return filesystem.check_yaml(name, source=source)

    @router.get("/{name:path}")
    async def get_configuration(name: str) -> dict:
        ensure_capability_available("configuration.read")
        return filesystem.read_config(name)

    return router


def _record(
    audit: AuditStore,
    user_id: str,
    action: str,
    configuration: str,
    old_revision: str | None,
    new_revision: str | None,
    result: str,
) -> None:
    audit.record(
        user_id=user_id,
        action=action,
        configuration=configuration,
        old_revision=old_revision,
        new_revision=new_revision,
        result=result,
    )
