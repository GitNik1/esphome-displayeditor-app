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
from .security import RateLimiter
from .settings import CAPABILITY_MINIMUM_ROLE, Settings, capabilities


class DraftRequest(BaseModel):
    content: str = Field(max_length=4 * 1024 * 1024)


class PublishRequest(BaseModel):
    expected_revision: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DesignerProjectRequest(BaseModel):
    project: dict[str, Any]


class CanvasSize(BaseModel):
    width: int = Field(ge=1, le=4096)
    height: int = Field(ge=1, le=4096)


class ImportRequest(BaseModel):
    """Either an existing configuration by name, or pasted/uploaded content."""

    configuration: str | None = None
    content: str | None = Field(default=None, max_length=4 * 1024 * 1024)
    canvas: CanvasSize | None = None


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
    rate_limiter = RateLimiter(
        settings.api_rate_limit_per_minute,
        settings.write_rate_limit_per_minute,
    )
    allow_direct_access = runtime_settings is not None or os.getenv(
        "ESPHOME_ALLOW_DIRECT_ACCESS"
    ) == "1"
    trusted_ingress_hosts = {
        host.strip()
        for host in os.getenv("ESPHOME_TRUSTED_INGRESS_HOSTS", "172.30.32.2").split(",")
        if host.strip()
    }
    application = FastAPI(
        title="ESPHome Display Editor API",
        version=os.getenv("APP_VERSION", "0.7.0"),
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
    )

    @application.middleware("http")
    async def security_boundary(request: Request, call_next):
        client_host = request.client.host if request.client else "unknown"
        if not allow_direct_access and client_host not in trusted_ingress_hosts:
            return JSONResponse(
                status_code=403,
                headers={
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                },
                content={
                    "error": "ingress_required",
                    "message": "This application is available only through Home Assistant Ingress.",
                    "details": {},
                },
            )

        if request.url.path.startswith("/api/v1/"):
            user_id = request.headers.get("X-Remote-User-Id", "").strip()
            identity = user_id or f"client:{client_host}"
            decision = rate_limiter.check(
                identity,
                write=request.method not in {"GET", "HEAD", "OPTIONS"},
            )
            if not decision.allowed:
                return JSONResponse(
                    status_code=429,
                    headers={
                        "Cache-Control": "no-store",
                        "Referrer-Policy": "no-referrer",
                        "Retry-After": str(decision.retry_after),
                        "X-Content-Type-Options": "nosniff",
                    },
                    content={
                        "error": "rate_limit_exceeded",
                        "message": "Too many API requests. Try again later.",
                        "details": {"retry_after": decision.retry_after},
                    },
                )

        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/v1/"):
            response.headers["Cache-Control"] = "no-store"
        return response

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

    def request_identity(request: Request) -> tuple[str | None, str]:
        user_id = request.headers.get("X-Remote-User-Id", "").strip() or None
        if not user_id and os.getenv("ESPHOME_ALLOW_ANONYMOUS_WRITE") == "1":
            return "local-development", "administrator"
        return user_id, settings.role_for(user_id)

    def require_capability(request: Request, capability: str) -> str:
        if not capabilities(settings, "administrator").get(capability, False):
            raise capability_unavailable(capability, settings.profile)
        user_id, role = request_identity(request)
        if not user_id:
            raise ApiError(
                "permission_denied",
                "A Home Assistant Ingress user is required for write operations.",
                403,
            )
        if not capabilities(settings, role).get(capability, False):
            audit.record(
                user_id=user_id,
                action="authorization.denied",
                configuration=capability,
                old_revision=None,
                new_revision=None,
                result="permission_denied",
            )
            raise ApiError(
                "permission_denied",
                "The assigned role does not permit this operation.",
                403,
                {
                    "capability": capability,
                    "required_role": CAPABILITY_MINIMUM_ROLE[capability],
                    "actual_role": role,
                },
            )
        return user_id

    @application.get("/api/v1/health")
    async def health() -> dict:
        return {"status": "ok", "version": application.version}

    @application.get("/api/v1/system")
    async def system(request: Request) -> dict:
        user_id, role = request_identity(request)
        return {
            "version": application.version,
            "profile": settings.profile,
            "user": {
                "id": user_id,
                "name": request.headers.get("X-Remote-User-Name"),
                "display_name": request.headers.get("X-Remote-User-Display-Name"),
                "role": role,
            },
            "backends": {
                "configuration": "filesystem",
                "runtime": "disabled",
                "builder": "disabled",
            },
        }

    @application.get("/api/v1/capabilities")
    async def get_capabilities(request: Request) -> dict:
        _user_id, role = request_identity(request)
        return {
            "profile": settings.profile,
            "role": role,
            "capabilities": capabilities(settings, role),
        }

    @application.get("/api/v1/configurations")
    async def list_configurations() -> dict:
        return {"configurations": filesystem.list_configs()}

    @application.get("/api/v1/configurations/{name:path}/draft")
    async def get_draft(name: str) -> dict:
        return filesystem.read_draft(name)

    @application.put("/api/v1/configurations/{name:path}/draft")
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
            audit.record(
                user_id=user_id,
                action="configuration.draft.save",
                configuration=name,
                old_revision=old_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="configuration.draft.save",
            configuration=name,
            old_revision=old_revision,
            new_revision=result["revision"],
            result="success",
        )
        return result

    @application.delete("/api/v1/configurations/{name:path}/draft", status_code=204)
    async def delete_draft(name: str, request: Request) -> Response:
        user_id = require_capability(request, "configuration.write_draft")
        old_revision = None
        try:
            old_revision = filesystem.read_draft(name)["revision"]
            filesystem.delete_draft(name)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="configuration.draft.delete",
                configuration=name,
                old_revision=old_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="configuration.draft.delete",
            configuration=name,
            old_revision=old_revision,
            new_revision=None,
            result="success",
        )
        return Response(status_code=204)

    @application.get("/api/v1/configurations/{name:path}/diff")
    async def get_diff(name: str) -> dict:
        return filesystem.diff(name)

    @application.post("/api/v1/configurations/{name:path}/check-yaml")
    async def check_yaml(name: str, source: str = Query(default="draft", pattern="^(draft|active)$")) -> dict:
        return filesystem.check_yaml(name, source=source)

    @application.post("/api/v1/configurations/{name:path}/publish")
    async def publish(name: str, body: PublishRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.publish")
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
    async def get_audit(
        request: Request, limit: int = Query(default=100, ge=1, le=500)
    ) -> dict:
        require_capability(request, "audit.read")
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

    def _import_source(body: ImportRequest) -> tuple[str, str]:
        """Resolve the text to import, and the name to record as its origin.

        A named configuration is read through FilesystemBackend.read_config,
        which already enforces the path, symlink, size and secrets.yaml rules
        and is strictly read-only - the import path has no access to
        save_draft or publish at all, so it cannot write back to the source.
        """
        if body.configuration:
            source = filesystem.read_config(body.configuration)
            return source["content"], source["name"]
        if body.content is None:
            raise ApiError(
                "invalid_request",
                "Provide either a configuration name or file content.",
                422,
            )
        return body.content, ""

    @application.post("/api/v1/designer/import/probe")
    async def probe_import(body: ImportRequest) -> dict:
        text, _name = _import_source(body)
        return designer.probe_yaml(text)

    @application.post("/api/v1/designer/import")
    async def import_configuration(body: ImportRequest) -> dict:
        text, name = _import_source(body)
        canvas = (body.canvas.width, body.canvas.height) if body.canvas else None
        return designer.import_yaml(text, canvas=canvas, source_name=name)

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
        user_id = require_capability(request, "designer.project_write")
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
        user_id = require_capability(request, "designer.project_write")
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
