from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Query, Request

from ...audit import AuditStore
from ...errors import ApiError
from ...project_store import ProjectStore
from ...runtime import DeviceManager
from ...viewer_bindings import ViewerBindingStore, validate_binding_targets
from ..schemas import SaveDesignerProjectRequest, ViewerBindingsRequest
from ..viewer_projection import project_widget_types


def create_designer_projects_router(
    *,
    projects: ProjectStore,
    viewer_bindings: ViewerBindingStore,
    runtime: DeviceManager,
    audit: AuditStore,
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["designer projects"])

    @router.get("/designer/projects")
    async def list_projects() -> dict:
        return {"projects": projects.list()}

    @router.get("/designer/projects/{name}")
    async def get_project(name: str) -> dict:
        return projects.read(name)

    @router.get("/viewer/bindings/{name}")
    async def get_bindings(name: str, request: Request) -> dict:
        require_capability(request, "designer.project")
        projects.read(name)
        return viewer_bindings.read(name)

    @router.put("/viewer/bindings/{name}")
    async def save_bindings(
        name: str, body: ViewerBindingsRequest, request: Request
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            normalized = validate_binding_targets(
                body.bindings,
                project_widget_types(projects.read(name)["project"]),
                runtime.registry.get,
            )
            result = viewer_bindings.save(name, normalized, body.expected_revision)
        except ApiError as exc:
            _record(audit, user_id, "designer.viewer_bindings.save", name,
                    body.expected_revision, None, exc.error)
            raise
        _record(audit, user_id, "designer.viewer_bindings.save", name,
                result["old_revision"], result["revision"], "success")
        return result

    @router.put("/designer/projects/{name}")
    async def save_project(
        name: str, body: SaveDesignerProjectRequest, request: Request
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            result = projects.save(name, body.project, body.expected_revision)
        except ApiError as exc:
            _record(audit, user_id, "designer.project.save", name,
                    body.expected_revision, None, exc.error)
            raise
        _record(audit, user_id, "designer.project.save", name,
                result["old_revision"], result["revision"], "success")
        return result

    @router.delete("/designer/projects/{name}")
    async def delete_project(
        name: str,
        request: Request,
        expected_revision: str = Query(pattern=r"^sha256:[0-9a-f]{64}$"),
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            result = projects.delete(name, expected_revision)
        except ApiError as exc:
            _record(audit, user_id, "designer.project.delete", name,
                    expected_revision, None, exc.error)
            raise
        viewer_bindings.delete(name)
        _record(audit, user_id, "designer.project.delete", name,
                result["revision"], None, "success")
        return result

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
