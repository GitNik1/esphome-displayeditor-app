from __future__ import annotations

from collections.abc import Callable
from urllib.parse import quote

from fastapi import APIRouter, Query, Request, Response

from ...audit import AuditStore
from ...designer import DesignerService
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ...lvgl_bundle import build_project_zip
from ...lvgl_merge import MergeError, build_project_yaml_for_bundle, merge_project_into_yaml
from ..schemas import DesignerProjectRequest, MergeDraftRequest


def create_designer_transform_router(
    *,
    designer: DesignerService,
    filesystem: FilesystemBackend,
    audit: AuditStore,
    ensure_capability_available: Callable[[str], None],
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/designer", tags=["designer transform"])

    @router.get("/schemas")
    async def schemas(language: str = Query(default="de", pattern="^(de|en)$")) -> dict:
        return designer.schemas(language)

    @router.post("/projects/validate")
    async def validate(body: DesignerProjectRequest) -> dict:
        project, issues = designer.validate(body.project)
        return {"valid": not any(issue["severity"] == "error" for issue in issues),
                "issues": issues, "project": designer.project_payload(project)}

    @router.post("/projects/export-yaml")
    async def export_yaml(body: DesignerProjectRequest) -> dict:
        return designer.export_yaml(body.project)

    @router.post("/projects/export-zip")
    async def export_zip(body: DesignerProjectRequest) -> Response:
        ensure_capability_available("designer.export_yaml")
        project, issues = designer.validate(body.project)
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError("invalid_project", "Project validation failed.", 422,
                           {"issues": issues})
        yaml_text, export_issues = build_project_yaml_for_bundle(project)
        blocking = [issue for issue in export_issues if issue.severity == "A"]
        if blocking:
            raise ApiError("invalid_project", "Project validation failed.", 422,
                           {"issues": [{"severity": issue.severity,
                                        "message": issue.message} for issue in blocking]})
        bundle = build_project_zip(yaml_text, project, filesystem)
        headers = {"Content-Disposition": 'attachment; filename="ui-bundle.zip"'}
        if bundle.missing_assets:
            headers["X-Missing-Assets"] = ",".join(
                quote(path, safe="") for path in bundle.missing_assets
            )
        return Response(content=bundle.content, media_type="application/zip", headers=headers)

    @router.post("/projects/merge-draft")
    async def merge_draft(body: MergeDraftRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.write_draft")
        ensure_capability_available("designer.export_yaml")
        project, issues = designer.validate(body.project)
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError("invalid_project", "Project validation failed.", 422,
                           {"issues": issues})
        try:
            existing = filesystem.read_draft(body.target)["content"]
        except ApiError as exc:
            if exc.error != "draft_not_found":
                raise
            existing = filesystem.read_config(body.target)["content"]
        try:
            merged = merge_project_into_yaml(project, existing)
        except MergeError as exc:
            raise ApiError("merge_failed", str(exc), 422) from exc
        blocking = [issue for issue in merged.issues if issue.severity == "A"]
        if blocking:
            raise ApiError("invalid_project", "Project validation failed.", 422,
                           {"issues": [{"severity": issue.severity,
                                        "message": issue.message} for issue in blocking]})
        old_revision = None
        try:
            try:
                old_revision = filesystem.read_draft(body.target)["revision"]
            except ApiError as exc:
                if exc.error != "draft_not_found":
                    raise
            result = filesystem.save_draft(body.target, merged.content)
        except ApiError as exc:
            _record(audit, user_id, body.target, old_revision, None, exc.error)
            raise
        _record(audit, user_id, body.target, old_revision, result["revision"], "success")
        return {"revision": result["revision"], "replaced": merged.replaced_keys,
                "appended": merged.appended_keys}

    return router


def _record(audit, user_id, name, old_revision, new_revision, result):
    audit.record(user_id=user_id, action="configuration.draft.merge",
                 configuration=name, old_revision=old_revision,
                 new_revision=new_revision, result=result)
