"""FastAPI entry point for the Home Assistant Ingress application."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .audit import AuditStore
from .designer import DesignerService
from .errors import ApiError, capability_unavailable
from .filesystem import FilesystemBackend
from .project_store import ProjectStore
from .settings import Settings, capabilities


class DraftRequest(BaseModel):
    content: str = Field(max_length=4 * 1024 * 1024)


class PublishRequest(BaseModel):
    expected_revision: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DesignerProjectRequest(BaseModel):
    project: dict[str, Any]


class SaveDesignerProjectRequest(DesignerProjectRequest):
    expected_revision: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )


def create_app(runtime_settings: Settings | None = None, *, serve_frontend: bool = True) -> FastAPI:
    settings = runtime_settings or Settings.load()
    filesystem = FilesystemBackend(settings)
    audit = AuditStore(settings.data_root)
    designer = DesignerService(settings.data_root)
    projects = ProjectStore(settings.data_root, designer, settings.max_file_size)
    application = FastAPI(
        title="ESPHome Display Editor API",
        version=os.getenv("APP_VERSION", "0.2.0"),
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
    )

    @application.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.error, "message": exc.message, "details": exc.details},
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_request",
                "message": "The request body or parameters are invalid.",
                "details": {"errors": exc.errors()},
            },
        )

    def require_write(request: Request, capability: str) -> str:
        if not capabilities(settings).get(capability, False):
            raise capability_unavailable(capability, settings.profile)
        user_id = request.headers.get("X-Remote-User-Id", "").strip()
        allow_local = os.getenv("ESPHOME_ALLOW_ANONYMOUS_WRITE") == "1"
        if not user_id and not allow_local:
            raise ApiError(
                "permission_denied",
                "A Home Assistant Ingress user is required for write operations.",
                403,
            )
        return user_id or "local-development"

    @application.get("/api/v1/health")
    async def health() -> dict:
        return {"status": "ok", "version": application.version}

    @application.get("/api/v1/system")
    async def system(request: Request) -> dict:
        return {
            "version": application.version,
            "profile": settings.profile,
            "user": {
                "id": request.headers.get("X-Remote-User-Id"),
                "name": request.headers.get("X-Remote-User-Name"),
                "display_name": request.headers.get("X-Remote-User-Display-Name"),
            },
            "backends": {
                "configuration": "filesystem",
                "runtime": "disabled",
                "builder": "disabled",
            },
        }

    @application.get("/api/v1/capabilities")
    async def get_capabilities() -> dict:
        return {"profile": settings.profile, "capabilities": capabilities(settings)}

    @application.get("/api/v1/configurations")
    async def list_configurations() -> dict:
        return {"configurations": filesystem.list_configs()}

    @application.get("/api/v1/configurations/{name:path}/draft")
    async def get_draft(name: str) -> dict:
        return filesystem.read_draft(name)

    @application.put("/api/v1/configurations/{name:path}/draft")
    async def put_draft(name: str, body: DraftRequest, request: Request) -> dict:
        require_write(request, "configuration.write_draft")
        return filesystem.save_draft(name, body.content)

    @application.delete("/api/v1/configurations/{name:path}/draft", status_code=204)
    async def delete_draft(name: str, request: Request) -> Response:
        require_write(request, "configuration.write_draft")
        filesystem.delete_draft(name)
        return Response(status_code=204)

    @application.get("/api/v1/configurations/{name:path}/diff")
    async def get_diff(name: str) -> dict:
        return filesystem.diff(name)

    @application.post("/api/v1/configurations/{name:path}/check-yaml")
    async def check_yaml(name: str, source: str = Query(default="draft", pattern="^(draft|active)$")) -> dict:
        return filesystem.check_yaml(name, source=source)

    @application.post("/api/v1/configurations/{name:path}/publish")
    async def publish(name: str, body: PublishRequest, request: Request) -> dict:
        user_id = require_write(request, "configuration.publish")
        try:
            result = filesystem.publish(name, body.expected_revision)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="configuration.publish",
                configuration=name,
                old_revision=body.expected_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="configuration.publish",
            configuration=name,
            old_revision=result["old_revision"],
            new_revision=result["revision"],
            result="success",
        )
        return result

    @application.get("/api/v1/configurations/{name:path}")
    async def get_configuration(name: str) -> dict:
        return filesystem.read_config(name)

    @application.get("/api/v1/audit")
    async def get_audit(limit: int = Query(default=100, ge=1, le=500)) -> dict:
        return {"events": audit.recent(limit)}

    @application.get("/api/v1/designer/schemas")
    async def designer_schemas(language: str = Query(default="de", pattern="^(de|en)$")) -> dict:
        return designer.schemas(language)

    @application.post("/api/v1/designer/projects/validate")
    async def validate_project(body: DesignerProjectRequest) -> dict:
        project, issues = designer.validate(body.project)
        return {
            "valid": not any(issue["severity"] == "error" for issue in issues),
            "issues": issues,
            "project": project.to_dict(),
        }

    @application.post("/api/v1/designer/projects/export-yaml")
    async def export_project_yaml(body: DesignerProjectRequest) -> dict:
        return designer.export_yaml(body.project)

    @application.get("/api/v1/designer/projects")
    async def list_designer_projects() -> dict:
        return {"projects": projects.list()}

    @application.get("/api/v1/designer/projects/{name}")
    async def get_designer_project(name: str) -> dict:
        return projects.read(name)

    @application.put("/api/v1/designer/projects/{name}")
    async def save_designer_project(
        name: str, body: SaveDesignerProjectRequest, request: Request
    ) -> dict:
        user_id = require_write(request, "designer.project_write")
        try:
            result = projects.save(name, body.project, body.expected_revision)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.project.save",
                configuration=name,
                old_revision=body.expected_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.project.save",
            configuration=name,
            old_revision=result["old_revision"],
            new_revision=result["revision"],
            result="success",
        )
        return result

    @application.delete("/api/v1/designer/projects/{name}")
    async def delete_designer_project(
        name: str,
        request: Request,
        expected_revision: str = Query(pattern=r"^sha256:[0-9a-f]{64}$"),
    ) -> dict:
        user_id = require_write(request, "designer.project_write")
        try:
            result = projects.delete(name, expected_revision)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.project.delete",
                configuration=name,
                old_revision=expected_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.project.delete",
            configuration=name,
            old_revision=result["revision"],
            new_revision=None,
            result="success",
        )
        return result

    if serve_frontend:
        frontend = Path(__file__).resolve().parents[1] / "frontend"
        application.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")

    return application
