from __future__ import annotations

from collections.abc import Callable
from urllib.parse import quote

from fastapi import APIRouter, Query, Request, Response

from ...audit import AuditStore
from ...designer import DesignerService
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ..drafts import expected_draft_revision
from ...lvgl_bundle import build_project_zip
from ...lvgl_merge import (
    DisplayTakeoverRequired,
    MergeError,
    build_project_yaml_for_bundle,
    choose_merge_base,
    merge_project_into_yaml,
)
from ...entity_bindings import parse_custom_binding_yaml
from ...viewer_scenarios import parse_viewer_scenarios
from ...designer_core.yamlimport import LvglImportError
from ..schemas import (
    CustomBindingYamlRequest,
    DesignerProjectRequest,
    MergeDraftRequest,
    ViewerScenariosRequest,
)


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
    def schemas(language: str = Query(default="de", pattern="^(de|en)$")) -> dict:
        return designer.schemas(language)

    @router.post("/projects/validate")
    def validate(body: DesignerProjectRequest) -> dict:
        project, issues = designer.validate(body.project)
        return {"valid": not any(issue["severity"] == "error" for issue in issues),
                "issues": issues, "project": designer.project_payload(project)}

    @router.post("/bindings/custom-yaml/validate")
    def validate_custom_binding_yaml(body: CustomBindingYamlRequest) -> dict:
        try:
            action, normalized = parse_custom_binding_yaml(body.content)
        except LvglImportError as exc:
            raise ApiError("invalid_custom_binding_yaml", str(exc), 422) from exc
        return {"valid": True, "action": action, "yaml": normalized}

    @router.post("/viewer-scenarios/validate")
    def validate_viewer_scenarios(body: ViewerScenariosRequest) -> dict:
        try:
            scenarios = parse_viewer_scenarios(body.content)
        except LvglImportError as exc:
            raise ApiError("invalid_viewer_scenarios", str(exc), 422) from exc
        return {"valid": True, "scenarios": scenarios}

    @router.post("/projects/export-yaml")
    def export_yaml(body: DesignerProjectRequest) -> dict:
        return designer.export_yaml(body.project)

    @router.post("/projects/export-zip")
    def export_zip(body: DesignerProjectRequest) -> Response:
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
    def merge_draft(body: MergeDraftRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.write_draft")
        ensure_capability_available("designer.export_yaml")
        project, issues = designer.validate(body.project)
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError("invalid_project", "Project validation failed.", 422,
                           {"issues": issues})
        try:
            draft = filesystem.read_draft(body.target)["content"]
        except ApiError as exc:
            if exc.error != "draft_not_found":
                raise
            draft = None
        existing, base_issues = choose_merge_base(
            draft, filesystem.read_config(body.target)["content"])
        try:
            merged = merge_project_into_yaml(
                project, existing,
                display_takeover="comment" if body.confirm_display_takeover else "ask",
            )
        except DisplayTakeoverRequired as exc:
            raise ApiError("display_takeover_required", str(exc), 409,
                           {"displays": exc.conflicts}) from exc
        except MergeError as exc:
            raise ApiError("merge_failed", str(exc), 422) from exc
        merged.issues[:0] = base_issues
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
            result = filesystem.save_draft(
                body.target, merged.content,
                expected_draft_revision=expected_draft_revision(body))
        except ApiError as exc:
            _record(audit, user_id, body.target, old_revision, None, exc.error)
            raise
        _record(audit, user_id, body.target, old_revision, result["revision"], "success")
        return {"revision": result["revision"], "replaced": merged.replaced_keys,
                "appended": merged.appended_keys,
                "display_takeover": merged.display_takeover,
                "issues": [{"severity": issue.severity, "message": issue.message}
                           for issue in merged.issues[:100]]}

    return router


def _record(audit, user_id, name, old_revision, new_revision, result):
    audit.record(user_id=user_id, action="configuration.draft.merge",
                 configuration=name, old_revision=old_revision,
                 new_revision=new_revision, result=result)
