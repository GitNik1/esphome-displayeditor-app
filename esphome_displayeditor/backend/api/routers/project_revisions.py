from __future__ import annotations

import difflib
import json
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Query, Request

from ...audit import AuditStore
from ...designer import DesignerService
from ...errors import ApiError
from ...project_revisions import (
    PROJECT_REVISION_DEPTH,
    PROJECT_REVISION_FEED_LIMIT,
    PROJECT_REVISION_LOCKED_DEPTH,
    ProjectRevisionStore,
)
from ...project_store import ProjectStore
from ...settings import role_allows
from ..schemas import AnnotateProjectRevisionRequest, RestoreProjectRevisionRequest

_DIFF_PREVIEW_CHARACTERS = 32 * 1024


def create_project_revisions_router(
    *,
    projects: ProjectStore,
    revisions: ProjectRevisionStore,
    designer: DesignerService,
    audit: AuditStore,
    request_identity: Callable[[Request], tuple[str | None, str]],
    ensure_capability_available: Callable[[str], None],
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/designer", tags=["project revisions"])

    @router.get("/revisions")
    async def get_feed(
        request: Request, limit: int = Query(default=50, ge=1, le=PROJECT_REVISION_FEED_LIMIT)
    ) -> dict:
        ensure_capability_available("designer.project")
        # Actor ids are Home Assistant user ids, which only administrators see
        # elsewhere (via audit.read). Origin and action stay visible to all -
        # that is what answers "what did the MCP server change?".
        expose_actors = role_allows(request_identity(request)[1], "administrator")
        events = []
        for item in revisions.recent(limit):
            events.append(
                {
                    **_public(item, expose_actor=expose_actors),
                    "project_exists": projects.current_revision(
                        item["project_name"]
                    )
                    is not None,
                }
            )
        return {"limit": limit, "events": events}

    @router.get("/projects/{name}/revisions")
    async def list_revisions(name: str, request: Request) -> dict:
        ensure_capability_available("designer.project")
        expose_actors = role_allows(request_identity(request)[1], "administrator")
        current = projects.current_revision(name)
        versions = revisions.list(name)
        # A restored version is byte-identical to its source, so several rows
        # can share the current revision. Only the newest of them is the one
        # actually on disk.
        current_id = next(
            (
                item["id"]
                for item in versions
                if item["revision"] == current and item["action"] == "save"
            ),
            None,
        )
        return {
            "name": name,
            "exists": current is not None,
            "current_revision": current,
            "depth": PROJECT_REVISION_DEPTH,
            "locked_depth": PROJECT_REVISION_LOCKED_DEPTH,
            "locked_used": sum(1 for item in versions if item["locked"]),
            "versions": [
                {
                    **_public(item, expose_actor=expose_actors),
                    "is_current": item["id"] == current_id,
                    # Resolved lazily by the selected-version route: validating
                    # ten projects on every dialog open would be wasteful.
                    "restorable": None,
                }
                for item in versions
            ],
        }

    @router.get("/projects/{name}/revisions/{revision_id}")
    async def read_revision(name: str, revision_id: int, request: Request) -> dict:
        ensure_capability_available("designer.project")
        expose_actors = role_allows(request_identity(request)[1], "administrator")
        raw, metadata = _content(revisions, name, revision_id)
        payload, issues = _validate(designer, metadata, raw)
        return {
            **_public(metadata, expose_actor=expose_actors),
            "project": payload,
            "issues": issues,
            "restorable": _restorable(metadata, issues),
        }

    @router.get("/projects/{name}/revisions/{revision_id}/diff")
    async def diff_revision(
        name: str, revision_id: int, against: str = Query(default="current")
    ) -> dict:
        ensure_capability_available("designer.project")
        source, metadata = _content(revisions, name, revision_id)
        if against == "current":
            target = _current_bytes(projects, name)
            target_meta: dict[str, Any] | None = None
            target_revision = projects.current_revision(name)
            target_label = "current"
        else:
            target, target_meta = _content(revisions, name, _as_id(against))
            target_revision = target_meta["revision"]
            target_label = _short(target_revision)
        diff = "".join(
            difflib.unified_diff(
                source.decode("utf-8", "replace").splitlines(keepends=True),
                target.decode("utf-8", "replace").splitlines(keepends=True),
                fromfile=f"{name}@{_short(metadata['revision'])}",
                tofile=f"{name}@{target_label}",
            )
        )
        return {
            "name": name,
            "from": {
                "id": metadata["id"],
                "revision": metadata["revision"],
                "created_at": metadata["created_at"],
            },
            "to": {
                "id": target_meta["id"] if target_meta else None,
                "revision": target_revision,
                "created_at": target_meta["created_at"] if target_meta else None,
            },
            "diff": diff[:_DIFF_PREVIEW_CHARACTERS],
            "diff_truncated": len(diff) > _DIFF_PREVIEW_CHARACTERS,
        }

    @router.patch("/projects/{name}/revisions/{revision_id}")
    async def annotate_revision(
        name: str,
        revision_id: int,
        body: AnnotateProjectRevisionRequest,
        request: Request,
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            result = revisions.set_label(name, revision_id, body.label)
        except ApiError as exc:
            _record(audit, user_id, "designer.project.revision_label", name, exc.error)
            raise
        _record(audit, user_id, "designer.project.revision_label", name, "success")
        return _public(result, expose_actor=True)

    @router.post("/projects/{name}/revisions/{revision_id}/lock")
    async def lock_revision(name: str, revision_id: int, request: Request) -> dict:
        return await _set_lock(name, revision_id, request, True)

    @router.delete("/projects/{name}/revisions/{revision_id}/lock")
    async def unlock_revision(name: str, revision_id: int, request: Request) -> dict:
        return await _set_lock(name, revision_id, request, False)

    async def _set_lock(
        name: str, revision_id: int, request: Request, locked: bool
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            result = revisions.set_locked(name, revision_id, locked, f"ha:{user_id}")
        except ApiError as exc:
            _record(audit, user_id, "designer.project.revision_lock", name, exc.error)
            raise
        _record(audit, user_id, "designer.project.revision_lock", name, "success")
        return _public(result, expose_actor=True)

    @router.post("/projects/{name}/revisions/{revision_id}/restore")
    async def restore_revision(
        name: str,
        revision_id: int,
        body: RestoreProjectRevisionRequest,
        request: Request,
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        raw, metadata = _content(revisions, name, revision_id)
        if metadata["encoding"] in {"tombstone", "skipped"}:
            raise ApiError(
                "revision_not_restorable",
                "This entry does not carry the project content.",
                409,
                {"encoding": metadata["encoding"]},
            )
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ApiError(
                "invalid_project", "Stored version contains invalid JSON.", 422
            ) from exc
        try:
            # Going through save() is deliberate: it re-runs the revision
            # check, validation and canonicalization, and its own snapshot
            # hook records the displaced state - so the restore is undoable.
            result = projects.save(
                name,
                payload,
                body.expected_revision,
                actor=f"ha:{user_id}",
                origin="restore",
                restored_from=revision_id,
            )
        except ApiError as exc:
            _record(audit, user_id, "designer.project.restore", name, exc.error)
            raise
        _record(audit, user_id, "designer.project.restore", name, "success")
        return {
            **result,
            "restored_from": {"id": revision_id, "revision": metadata["revision"]},
        }

    return router


def _as_id(value: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise ApiError(
            "invalid_request", "'against' must be 'current' or a version id."
        ) from exc


def _short(revision: str | None) -> str:
    return revision[7:19] if revision else "none"


def _content(
    revisions: ProjectRevisionStore, name: str, revision_id: int
) -> tuple[bytes, dict[str, Any]]:
    found = revisions.content(name, revision_id)
    if found is None:
        raise ApiError("revision_not_found", "Version was not found.", 404)
    return found


def _current_bytes(projects: ProjectStore, name: str) -> bytes:
    return projects.current_bytes(name) or b""


def _validate(
    designer: DesignerService, metadata: dict[str, Any], raw: bytes
) -> tuple[dict[str, Any] | None, list[dict]]:
    """Report validation issues instead of raising on them.

    A version stored before a schema tightening may no longer validate. The
    user must be able to look at it and see why, rather than hitting a 422.
    """
    if metadata["encoding"] in {"tombstone", "skipped"}:
        return None, []
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, [{"severity": "error", "message": "Stored version is unreadable."}]
    project, issues = designer.validate(payload)
    return designer.project_payload(project), issues


def _restorable(metadata: dict[str, Any], issues: list[dict]) -> bool:
    if metadata["encoding"] in {"tombstone", "skipped"}:
        return False
    return not any(issue["severity"] == "error" for issue in issues)


def _public(item: dict[str, Any], *, expose_actor: bool) -> dict[str, Any]:
    public = {key: value for key, value in item.items() if key != "metadata"}
    if not expose_actor:
        public["actor"] = None
        public["locked_by"] = None
    return public


def _record(
    audit: AuditStore, user_id: str, action: str, configuration: str, result: str
) -> None:
    audit.record(
        user_id=user_id,
        action=action,
        configuration=configuration,
        old_revision=None,
        new_revision=None,
        result=result,
    )
