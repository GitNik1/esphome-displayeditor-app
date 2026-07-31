"""FastAPI entry point for the Home Assistant Ingress application."""

from __future__ import annotations

import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr

from .audit import AuditStore
from .designer import DesignerService
from .errors import ApiError, capability_unavailable
from .filesystem import FilesystemBackend
from .project_store import ProjectStore
from .runtime import DeviceManager, DeviceRegistry, SecretStore
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


class DeviceRequest(BaseModel):
    id: str = Field(min_length=1, max_length=63)
    name: str = Field(min_length=1, max_length=80)
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=6053, ge=1, le=65535)
    encryption_key_ref: str = Field(min_length=1, max_length=63)


class DeviceSecretRequest(BaseModel):
    encryption_key: SecretStr


def create_app(
    runtime_settings: Settings | None = None,
    *,
    serve_frontend: bool = True,
    runtime_manager: DeviceManager | None = None,
) -> FastAPI:
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

    if runtime_manager is None:
        registry = DeviceRegistry(settings.data_root)
        secret_store = SecretStore(settings.data_root)
        runtime_manager = DeviceManager(
            registry,
            secret_store,
            enabled=settings.runtime_provider == "native",
        )

    @asynccontextmanager
    async def lifespan(_application: FastAPI):
        await runtime_manager.start()
        try:
            yield
        finally:
            await runtime_manager.stop()

    application = FastAPI(
        title="ESPHome Display Editor API",
        version=os.getenv("APP_VERSION", "0.8.0"),
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    application.state.device_manager = runtime_manager

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
        ensure_capability_available(capability)
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

    def ensure_capability_available(capability: str) -> None:
        if not capabilities(settings, "administrator").get(capability, False):
            raise capability_unavailable(capability, settings.profile)

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
                "runtime": settings.runtime_provider,
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
        ensure_capability_available("configuration.list")
        return {"configurations": filesystem.list_configs()}

    @application.get("/api/v1/configurations/{name:path}/draft")
    async def get_draft(name: str) -> dict:
        ensure_capability_available("configuration.read")
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
        ensure_capability_available("configuration.read")
        return filesystem.diff(name)

    @application.post("/api/v1/configurations/{name:path}/check-yaml")
    async def check_yaml(name: str, source: str = Query(default="draft", pattern="^(draft|active)$")) -> dict:
        ensure_capability_available("configuration.validate_yaml")
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
        ensure_capability_available("configuration.read")
        return filesystem.read_config(name)

    @application.get("/api/v1/audit")
    async def get_audit(
        request: Request, limit: int = Query(default=100, ge=1, le=500)
    ) -> dict:
        require_capability(request, "audit.read")
        return {"events": audit.recent(limit)}

    @application.get("/api/v1/devices")
    async def list_devices(request: Request) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.info")
        return {"devices": runtime_manager.list_devices()}

    @application.get("/api/v1/devices/{device_id}")
    async def get_device(device_id: str, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.info")
        return runtime_manager.get_device(device_id)

    @application.get("/api/v1/devices/{device_id}/info")
    async def get_device_info(device_id: str, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.info")
        return {"device_id": device_id, "info": runtime_manager.get_info(device_id)}

    @application.get("/api/v1/devices/{device_id}/entities")
    async def get_device_entities(device_id: str, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.entities")
        return {"device_id": device_id, "entities": runtime_manager.get_entities(device_id)}

    @application.get("/api/v1/devices/{device_id}/states")
    async def get_device_states(device_id: str, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.states")
        return {"device_id": device_id, "states": runtime_manager.get_states(device_id)}

    @application.get("/api/v1/devices/{device_id}/logs")
    async def get_device_logs(
        device_id: str,
        request: Request,
        limit: int = Query(default=200, ge=1, le=1000),
    ) -> dict:
        runtime_manager.ensure_enabled()
        require_capability(request, "device.logs")
        return {"device_id": device_id, "logs": runtime_manager.get_logs(device_id, limit)}

    @application.post("/api/v1/admin/devices", status_code=201)
    async def create_device(body: DeviceRequest, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        try:
            runtime_manager.registry.get(body.id)
        except ApiError as exc:
            if exc.error != "device_not_found":
                raise
        else:
            raise ApiError("device_exists", "A device with this id already exists.", 409)
        device = runtime_manager.registry.upsert(body.model_dump())
        await runtime_manager.restart(device.id)
        audit.record(
            user_id=user_id,
            action="device.create",
            configuration=device.id,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return runtime_manager.get_device(device.id)

    @application.put("/api/v1/admin/devices/{device_id}")
    async def update_device(device_id: str, body: DeviceRequest, request: Request) -> dict:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime_manager.registry.get(device_id)
        device = runtime_manager.registry.upsert(body.model_dump(), expected_id=device_id)
        await runtime_manager.restart(device.id)
        audit.record(
            user_id=user_id,
            action="device.update",
            configuration=device.id,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return runtime_manager.get_device(device.id)

    @application.delete("/api/v1/admin/devices/{device_id}", status_code=204)
    async def delete_device(device_id: str, request: Request) -> Response:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime_manager.registry.delete(device_id)
        await runtime_manager.remove(device_id)
        audit.record(
            user_id=user_id,
            action="device.delete",
            configuration=device_id,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return Response(status_code=204)

    @application.put("/api/v1/admin/device-secrets/{key_ref}", status_code=204)
    async def set_device_secret(
        key_ref: str, body: DeviceSecretRequest, request: Request
    ) -> Response:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime_manager.secrets.set(key_ref, body.encryption_key.get_secret_value())
        await runtime_manager.refresh_key_reference(key_ref)
        audit.record(
            user_id=user_id,
            action="device.secret.update",
            configuration=key_ref,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return Response(status_code=204)

    @application.delete("/api/v1/admin/device-secrets/{key_ref}", status_code=204)
    async def delete_device_secret(key_ref: str, request: Request) -> Response:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime_manager.secrets.delete(key_ref)
        await runtime_manager.refresh_key_reference(key_ref)
        audit.record(
            user_id=user_id,
            action="device.secret.delete",
            configuration=key_ref,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return Response(status_code=204)

    @application.post("/api/v1/admin/devices/{device_id}/reconnect", status_code=204)
    async def reconnect_device(device_id: str, request: Request) -> Response:
        runtime_manager.ensure_enabled()
        user_id = require_capability(request, "device.manage")
        runtime_manager.registry.get(device_id)
        await runtime_manager.restart(device_id)
        audit.record(
            user_id=user_id,
            action="device.reconnect",
            configuration=device_id,
            old_revision=None,
            new_revision=None,
            result="success",
        )
        return Response(status_code=204)

    @application.websocket("/api/v1/devices/events")
    async def device_events(websocket: WebSocket) -> None:
        if not runtime_manager.enabled:
            await websocket.close(code=4403, reason="capability_unavailable")
            return
        client_host = websocket.client.host if websocket.client else "unknown"
        if not allow_direct_access and client_host not in trusted_ingress_hosts:
            await websocket.close(code=4403, reason="ingress_required")
            return
        user_id = websocket.headers.get("X-Remote-User-Id", "").strip() or None
        if not user_id and os.getenv("ESPHOME_ALLOW_ANONYMOUS_WRITE") == "1":
            user_id = "local-development"
            role = "administrator"
        else:
            role = settings.role_for(user_id)
        if not user_id or not capabilities(settings, role).get("device.states", False):
            await websocket.close(code=4403, reason="permission_denied")
            return
        device_filter = websocket.query_params.get("device_id")
        if device_filter:
            try:
                runtime_manager.registry.get(device_filter)
            except ApiError:
                await websocket.close(code=4404, reason="device_not_found")
                return
        decision = rate_limiter.check(user_id, write=False)
        if not decision.allowed:
            await websocket.close(code=4429, reason="rate_limit_exceeded")
            return
        await websocket.accept()
        queue = runtime_manager.subscribe()
        try:
            await websocket.send_json(
                {
                    "type": "devices",
                    "devices": [
                        device
                        for device in runtime_manager.list_devices()
                        if not device_filter or device["id"] == device_filter
                    ],
                }
            )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except TimeoutError:
                    event = {"type": "heartbeat"}
                if not device_filter or event.get("device_id") in {None, device_filter}:
                    await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            runtime_manager.unsubscribe(queue)

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
            ensure_capability_available("configuration.read")
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
