"""Preview and adopt changes made to a project's source ESPHome config.

Two endpoints, deliberately split: the preview never writes and needs only
read access, so opening a project can always show what drifted, even for a
viewer who may not apply it. Applying goes through the ordinary project save,
which means it revalidates, respects the revision check, and shows up in the
version history as ``origin: resync``.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from ... import project_resync
from ...audit import AuditStore
from ...designer import DesignerService
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ...project_revisions import ProjectRevisionStore
from ...project_store import ProjectStore
from ..schemas import ApplyProjectResyncRequest


def create_project_resync_router(
    *,
    projects: ProjectStore,
    revisions: ProjectRevisionStore,
    designer: DesignerService,
    filesystem: FilesystemBackend,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/designer", tags=["designer projects"])

    def _reimport(payload: dict) -> tuple[dict, dict, dict] | dict:
        """Return ``(config, imported, unavailable)`` for a stored project.

        The unavailable dict is the whole response when there is nothing to
        compare against - a project that was never imported, a config that has
        since been deleted or renamed, or one this build can no longer parse.
        None of those is an error the user did anything about, so they are
        reported as data rather than raised.
        """
        source_name = str((payload.get("import_source") or {}).get("name") or "")
        if not source_name:
            return {"available": False, "reason": "no_source"}
        try:
            config = filesystem.read_config(source_name)
        except ApiError as exc:
            return {
                "available": False,
                "reason": "source_missing",
                "source": {"name": source_name},
                "message": exc.message,
            }
        canvas = payload.get("canvas") or {}
        width, height = int(canvas.get("width") or 0), int(canvas.get("height") or 0)
        try:
            result = designer.import_yaml(
                config["content"],
                # Re-import at the project's own canvas size: the designer's
                # resolution is the user's decision, not the config's.
                canvas=(width, height) if width and height else None,
                source_name=config["name"],
            )
        except ApiError as exc:
            return {
                "available": False,
                "reason": "import_failed",
                "source": {"name": config["name"], "revision": config["revision"]},
                "message": exc.message,
            }
        imported = result["project"]
        imported.setdefault("import_source", {})["revision"] = config["revision"]
        return config, imported, result

    @router.get("/projects/{name}/source")
    def read_source_changes(name: str, request: Request) -> dict:
        require_capability(request, "designer.project")
        stored = projects.read(name)
        payload = stored["project"]
        outcome = _reimport(payload)
        if isinstance(outcome, dict):
            return {"name": name, "revision": stored["revision"], **outcome}
        config, imported, result = outcome
        plan = project_resync.plan(
            stored=payload,
            imported=imported,
            issues=result["issues"],
            text=config["content"],
        )
        return {
            "available": True,
            "name": name,
            "revision": stored["revision"],
            "source": {
                "name": config["name"],
                "revision": config["revision"],
                # What the project was imported from. Absent for projects
                # imported before this was recorded - the diff is then the only
                # evidence of drift, which is exactly what it is for anyway.
                "known_revision": (payload.get("import_source") or {}).get("revision"),
            },
            **plan,
        }

    @router.post("/projects/{name}/source/apply")
    def apply_source_changes(
        name: str, body: ApplyProjectResyncRequest, request: Request
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        stored = projects.read(name)
        outcome = _reimport(stored["project"])
        if isinstance(outcome, dict):
            _record(audit, user_id, name, outcome["reason"])
            raise ApiError(
                "source_unavailable",
                "The source configuration can no longer be imported.",
                409,
                {"reason": outcome["reason"]},
            )
        config, imported, _result = outcome
        merged, dropped = project_resync.merge(
            stored["project"], imported, body.groups
        )
        source = {
            "name": config["name"],
            "revision": config["revision"],
            # Where the project stood before, so the timeline can show the
            # configuration moving rather than only the project following it.
            "previous_revision": (
                (stored["project"].get("import_source") or {}).get("revision")
            ),
        }
        try:
            result = projects.save(
                name,
                merged,
                body.expected_revision,
                actor=f"ha:{user_id}",
                origin="resync",
                metadata={
                    "source": source,
                    "groups": list(body.groups),
                    "dropped_bindings": [item["id"] for item in dropped],
                },
            )
        except ApiError as exc:
            _record(audit, user_id, name, exc.error)
            raise
        _record(audit, user_id, name, "success", body.expected_revision,
                result["revision"])
        return {
            **result,
            "project": projects.read(name)["project"],
            "groups": list(body.groups),
            "dropped_bindings": dropped,
            "source": source,
            "previous_locked": (
                _lock_previous(name, result["old_revision"], f"ha:{user_id}")
                if body.lock_previous else None
            ),
        }

    def _lock_previous(name: str, revision: str | None, actor: str) -> dict:
        """Lock the version this import displaced.

        Best effort by design: the import itself already succeeded, so a full
        lock quota must report itself rather than undo a write the user asked
        for and got.
        """
        if not revision:
            return {"locked": False, "reason": "no_previous_version"}
        displaced = next(
            (item for item in revisions.list(name) if item["revision"] == revision),
            None,
        )
        if displaced is None:
            return {"locked": False, "reason": "version_not_found"}
        try:
            revisions.set_locked(name, displaced["id"], True, actor)
        except ApiError as exc:
            return {"locked": False, "reason": exc.error, "id": displaced["id"]}
        return {"locked": True, "id": displaced["id"]}

    return router


def _record(
    audit: AuditStore,
    user_id: str,
    name: str,
    result: str,
    old_revision: str | None = None,
    new_revision: str | None = None,
) -> None:
    audit.record(
        user_id=user_id,
        action="designer.project.resync",
        configuration=name,
        old_revision=old_revision,
        new_revision=new_revision,
        result=result,
    )
