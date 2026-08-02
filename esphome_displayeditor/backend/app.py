"""FastAPI entry point for the Home Assistant Ingress application."""

from __future__ import annotations

import os
import asyncio
import base64
import binascii
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr

from .audit import AuditStore
from .builder import BuilderManager
from .builder.adapter import BuilderAdapterError, sanitize_output
from .designer import DesignerService
from .errors import ApiError, capability_unavailable
from .filesystem import FilesystemBackend
from .font_sources import FontSourceService
from .project_store import ProjectStore
from .runtime import DeviceManager, DeviceRegistry, SecretStore
from .security import RateLimiter
from .settings import CAPABILITY_MINIMUM_ROLE, Settings, capabilities
from .version import APP_VERSION
from .viewer_bindings import ViewerBindingStore, validate_bindings
from .workflow import WorkflowStore


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


class AssetImageRequest(BaseModel):
    """A baked animation frame (or any other PNG) to place in images/.

    Base64 rather than a multipart upload: every other write endpoint here is
    plain JSON, and a baked frame is small enough (a cropped animation frame,
    not a full-resolution photo) that the ~33% encoding overhead is a
    non-issue.
    """

    name: str = Field(min_length=1, max_length=128)
    # A hard ceiling independent of the configured max_file_size_kib, so an
    # oversized request is rejected before it is even fully base64-decoded.
    content_base64: str = Field(min_length=1, max_length=8 * 1024 * 1024)


class AssetFontRequest(BaseModel):
    """A TrueType/OpenType font file to place in fonts/, uploaded from the
    Font Library's "Datei" source. Same base64-over-JSON shape as
    AssetImageRequest; a bigger ceiling since a full glyph-set TTF can run
    well past a typical animation frame's size."""

    name: str = Field(min_length=1, max_length=128)
    content_base64: str = Field(min_length=1, max_length=24 * 1024 * 1024)


class FontSourceCheckRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    etag: str = Field(default="", max_length=512)
    last_modified: str = Field(default="", max_length=256)
    sha256: str = Field(default="", pattern=r"^$|^[0-9a-f]{64}$")


class FontSourceUpdateRequest(BaseModel):
    id: str = Field(min_length=1, max_length=63, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    url: str = Field(min_length=8, max_length=2048)


class FontGlyphCoverageRequest(BaseModel):
    path: str = Field(min_length=5, max_length=512)
    codepoints: list[int] = Field(min_length=1, max_length=512)


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


class ViewerBindingsRequest(BaseModel):
    bindings: list[dict[str, Any]] = Field(default_factory=list, max_length=256)
    expected_revision: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )


class InstallRequest(BaseModel):
    # The active YAML resolves the target. Arbitrary hosts, serial devices and
    # generic command arguments are deliberately not exposed by this API.
    port: str = Field(default="OTA", pattern="^OTA$")
    confirmed: bool = False


def create_app(
    runtime_settings: Settings | None = None,
    *,
    serve_frontend: bool = True,
    runtime_manager: DeviceManager | None = None,
    builder_manager: BuilderManager | None = None,
) -> FastAPI:
    settings = runtime_settings or Settings.load()
    filesystem = FilesystemBackend(settings)
    font_sources = FontSourceService(
        filesystem,
        max_size=min(settings.request_max_size, 16 * 1024 * 1024),
    )
    audit = AuditStore(settings.data_root)
    designer = DesignerService(settings.data_root)
    projects = ProjectStore(settings.data_root, designer, settings.max_file_size)
    viewer_bindings = ViewerBindingStore(settings.data_root)
    workflow = WorkflowStore(settings.data_root)
    configuration_job_locks: dict[str, asyncio.Lock] = {}
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
    if builder_manager is None:
        builder_manager = BuilderManager(settings)

    @asynccontextmanager
    async def lifespan(_application: FastAPI):
        await asyncio.gather(runtime_manager.start(), builder_manager.start())
        try:
            yield
        finally:
            await asyncio.gather(runtime_manager.stop(), builder_manager.stop())

    application = FastAPI(
        title="ESPHome Display Editor API",
        version=os.getenv("APP_VERSION", APP_VERSION),
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    application.state.device_manager = runtime_manager
    application.state.builder_manager = builder_manager
    application.state.font_sources = font_sources
    application.state.workflow = workflow

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
            content_length = request.headers.get("Content-Length")
            if content_length:
                try:
                    request_size = int(content_length)
                except ValueError:
                    request_size = settings.request_max_size + 1
                if request_size < 0 or request_size > settings.request_max_size:
                    return JSONResponse(
                        status_code=413,
                        headers={
                            "Cache-Control": "no-store",
                            "Referrer-Policy": "no-referrer",
                            "X-Content-Type-Options": "nosniff",
                        },
                        content={
                            "error": "request_too_large",
                            "message": "The API request body is too large.",
                            "details": {"max_bytes": settings.request_max_size},
                        },
                    )
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

        try:
            response = await asyncio.wait_for(
                call_next(request), timeout=settings.api_timeout_seconds
            )
        except TimeoutError:
            return JSONResponse(
                status_code=504,
                headers={
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                },
                content={
                    "error": "request_timeout",
                    "message": "The API operation timed out.",
                    "details": {},
                },
            )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: http: https:; font-src 'self' data: http: https:; "
            "connect-src 'self' ws: wss:; "
            "object-src 'none'; base-uri 'none'"
        )
        if request.url.path.startswith("/api/v1/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.method == "GET":
            response.headers["Cache-Control"] = "no-cache"
        return response

    @application.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.error, "message": exc.message, "details": exc.details},
        )

    @application.exception_handler(BuilderAdapterError)
    async def builder_error_handler(
        _request: Request, exc: BuilderAdapterError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=504 if exc.code == "builder_timeout" else 503,
            content={"error": exc.code, "message": exc.message, "details": {}},
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
        if not capabilities(
            settings, role, builder_available=builder_manager.available
        ).get(capability, False):
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
        if not capabilities(
            settings, "administrator", builder_available=builder_manager.available
        ).get(capability, False):
            raise capability_unavailable(capability, settings.access_level)

    def viewer_entity_id(item: dict[str, Any]) -> str | None:
        entity_type = str(item.get("type", "")).strip()
        key = item.get("key", item.get("object_id"))
        if not entity_type or key is None:
            return None
        return f"{entity_type}:{key}"

    def viewer_entity(item: dict[str, Any]) -> dict[str, Any] | None:
        entity_id = viewer_entity_id(item)
        if entity_id is None:
            return None
        allowed = (
            "type", "key", "object_id", "name", "icon", "unit_of_measurement",
            "device_class", "entity_category", "disabled_by_default",
        )
        return {"entity_id": entity_id, **{key: item[key] for key in allowed if key in item}}

    def viewer_state(item: dict[str, Any]) -> dict[str, Any] | None:
        entity_id = viewer_entity_id(item)
        if entity_id is None:
            return None
        allowed = ("type", "key", "object_id", "state", "available", "received_at")
        return {"entity_id": entity_id, **{key: item[key] for key in allowed if key in item}}

    def viewer_device(device_id: str) -> dict[str, Any]:
        public = runtime_manager.get_device(device_id)
        entities = [
            filtered
            for item in runtime_manager.get_entities(device_id)
            if (filtered := viewer_entity(item)) is not None
        ]
        states = [
            filtered
            for item in runtime_manager.get_states(device_id)
            if (filtered := viewer_state(item)) is not None
        ]
        return {
            "id": public["id"],
            "name": public["name"],
            "status": public["status"],
            "last_seen": public["last_seen"],
            "api_version": public["api_version"],
            "entities": entities,
            "states": states,
        }

    def viewer_runtime_snapshot() -> dict[str, Any]:
        return {
            "type": "snapshot",
            "devices": [viewer_device(item["id"]) for item in runtime_manager.list_devices()],
        }

    def viewer_runtime_event(event: dict[str, Any]) -> dict[str, Any] | None:
        event_type = event.get("type")
        if event_type == "state":
            filtered = viewer_state(event.get("state", {}))
            if filtered is None:
                return None
            return {"type": "state", "device_id": event.get("device_id"), "state": filtered}
        if event_type == "connection":
            return {
                "type": "connection",
                "device_id": event.get("device_id"),
                "status": event.get("status"),
                "at": event.get("at"),
            }
        if event_type == "snapshot":
            try:
                return {"type": "device_snapshot", "device": viewer_device(str(event.get("device_id", "")))}
            except ApiError:
                return {"type": "resync_required"}
        if event_type in {"device_removed", "resync_required"}:
            return {"type": event_type, "device_id": event.get("device_id")}
        return None

    def project_widget_types(project: dict[str, Any]) -> dict[str, str]:
        result: dict[str, str] = {}

        def visit(nodes: Any) -> None:
            if not isinstance(nodes, list):
                return
            for widget in nodes:
                if not isinstance(widget, dict):
                    continue
                widget_id = widget.get("id")
                if isinstance(widget_id, str):
                    result[widget_id] = str(widget.get("widget_type", ""))
                visit(widget.get("children"))

        visit(project.get("widgets"))
        for page in project.get("pages", []) if isinstance(project.get("pages"), list) else []:
            if isinstance(page, dict):
                visit(page.get("widgets"))
        for layer_name in ("top_layer", "bottom_layer"):
            layer = project.get(layer_name)
            if isinstance(layer, dict):
                visit(layer.get("widgets"))
        return result

    @application.get("/api/v1/health")
    async def health() -> dict:
        return {"status": "ok", "version": application.version}

    @application.get("/api/v1/system")
    async def system(request: Request) -> dict:
        user_id, role = request_identity(request)
        return {
            "version": application.version,
            "access_level": settings.access_level,
            "user": {
                "id": user_id,
                "name": request.headers.get("X-Remote-User-Name"),
                "display_name": request.headers.get("X-Remote-User-Display-Name"),
                "role": role,
            },
            "backends": {
                "configuration": (
                    "disabled" if settings.access_level == "none" else "filesystem"
                ),
                "runtime": settings.runtime_provider,
                "builder": builder_manager.state,
            },
            "builder": builder_manager.status(),
        }

    @application.get("/api/v1/capabilities")
    async def get_capabilities(request: Request) -> dict:
        _user_id, role = request_identity(request)
        return {
            "access_level": settings.access_level,
            "role": role,
            "capabilities": capabilities(
                settings, role, builder_available=builder_manager.available
            ),
        }

    @application.get("/api/v1/builder/status")
    async def builder_status() -> dict:
        return builder_manager.status()

    @application.post("/api/v1/builder/probe")
    async def probe_builder(request: Request) -> dict:
        require_capability(request, "builder.manage")
        return await builder_manager.probe()

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

    @application.post("/api/v1/configurations/{name:path}/validate")
    async def validate_esphome(name: str, request: Request) -> dict:
        user_id = require_capability(request, "configuration.validate_esphome")
        active_before = filesystem.read_config(name)
        result = await builder_manager.validate(name)
        active_after = filesystem.read_config(name)
        if active_after["revision"] != active_before["revision"]:
            workflow.invalidate_validation(name)
            audit.record(
                user_id=user_id,
                action="configuration.validate.esphome",
                configuration=name,
                old_revision=active_before["revision"],
                new_revision=active_after["revision"],
                result="validation_revision_conflict",
                esphome_version=builder_manager.esphome_version,
            )
            raise ApiError(
                "validation_revision_conflict",
                "The active configuration changed while ESPHome was validating it.",
                409,
                {
                    "validated_revision": active_before["revision"],
                    "active_revision": active_after["revision"],
                },
            )
        proof = None
        if result["valid"]:
            proof = workflow.record_validation(
                name,
                active_after["revision"],
                builder_manager.esphome_version,
            )
        else:
            workflow.invalidate_validation(name)
        audit.record(
            user_id=user_id,
            action="configuration.validate.esphome",
            configuration=name,
            old_revision=active_after["revision"],
            new_revision=active_after["revision"],
            result="success" if result["valid"] else "validation_failed",
            esphome_version=builder_manager.esphome_version,
        )
        return {
            **result,
            "revision": active_after["revision"],
            "validated_at": proof["validated_at"] if proof else None,
            "expires_in_seconds": settings.validation_max_age_seconds if proof else 0,
        }

    def checked_idempotency_key(value: str | None) -> str | None:
        if value is None:
            return None
        key = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", key):
            raise ApiError(
                "invalid_idempotency_key",
                "Idempotency-Key must contain 8 to 128 safe ASCII characters.",
                422,
            )
        return key

    def replayed_job(
        key: str | None, operation: str, configuration: str
    ) -> dict[str, Any] | None:
        if key is None:
            return None
        prior = workflow.job_request(key)
        if prior is None:
            return None
        if (
            prior["operation"] != operation
            or prior["configuration"] != configuration
        ):
            raise ApiError(
                "idempotency_conflict",
                "The idempotency key belongs to a different firmware request.",
                409,
                {
                    "operation": prior["operation"],
                    "configuration": prior["configuration"],
                },
            )
        return {
            "job": prior["job"],
            "revision": prior["revision"],
            "idempotent_replay": True,
        }

    async def reject_parallel_job(configuration: str) -> None:
        terminal = {
            "success", "succeeded", "completed", "done", "failed", "error",
            "cancelled", "canceled",
        }
        for job in await builder_manager.jobs():
            if str(job.get("configuration", "")) != configuration:
                continue
            status = str(job.get("status", "")).strip().lower()
            if status not in terminal:
                raise ApiError(
                    "job_already_running",
                    "A firmware job is already active for this configuration.",
                    409,
                    {
                        "configuration": configuration,
                        "job_id": job.get("job_id"),
                        "status": status or "unknown",
                    },
                )

    @application.post("/api/v1/configurations/{name:path}/compile", status_code=202)
    async def compile_configuration(
        name: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        user_id = require_capability(request, "firmware.compile")
        key = checked_idempotency_key(idempotency_key)
        lock = configuration_job_locks.setdefault(name, asyncio.Lock())
        try:
            async with lock:
                replay = replayed_job(key, "compile", name)
                if replay is not None:
                    return replay
                active = filesystem.read_config(name)
                workflow.require_validation(
                    name, active["revision"], settings.validation_max_age_seconds
                )
                await reject_parallel_job(name)
                latest = filesystem.read_config(name)
                if latest["revision"] != active["revision"]:
                    workflow.require_validation(
                        name,
                        latest["revision"],
                        settings.validation_max_age_seconds,
                    )
                job = await builder_manager.compile(name)
                if key is not None:
                    workflow.record_job_request(
                        key, "compile", name, active["revision"], job
                    )
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="firmware.compile",
                configuration=name,
                old_revision=None,
                new_revision=None,
                result=exc.error,
                esphome_version=builder_manager.esphome_version,
            )
            raise
        audit.record(
            user_id=user_id,
            action="firmware.compile",
            configuration=name,
            old_revision=active["revision"],
            new_revision=active["revision"],
            result="accepted",
            job_id=job["job_id"],
            esphome_version=builder_manager.esphome_version,
        )
        return {"job": job, "revision": active["revision"], "idempotent_replay": False}

    @application.post("/api/v1/configurations/{name:path}/install", status_code=202)
    async def install_configuration(
        name: str,
        body: InstallRequest,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        user_id = require_capability(request, "firmware.upload")
        if not body.confirmed:
            raise ApiError(
                "upload_confirmation_required",
                "Firmware installation requires explicit confirmation.",
                409,
            )
        key = checked_idempotency_key(idempotency_key)
        lock = configuration_job_locks.setdefault(name, asyncio.Lock())
        try:
            async with lock:
                replay = replayed_job(key, "install", name)
                if replay is not None:
                    return replay
                active = filesystem.read_config(name)
                workflow.require_validation(
                    name, active["revision"], settings.validation_max_age_seconds
                )
                await reject_parallel_job(name)
                latest = filesystem.read_config(name)
                if latest["revision"] != active["revision"]:
                    workflow.require_validation(
                        name,
                        latest["revision"],
                        settings.validation_max_age_seconds,
                    )
                job = await builder_manager.install(name, body.port)
                if key is not None:
                    workflow.record_job_request(
                        key, "install", name, active["revision"], job
                    )
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="firmware.install",
                configuration=name,
                old_revision=None,
                new_revision=None,
                result=exc.error,
                esphome_version=builder_manager.esphome_version,
                metadata={"port": "OTA"},
            )
            raise
        audit.record(
            user_id=user_id,
            action="firmware.install",
            configuration=name,
            old_revision=active["revision"],
            new_revision=active["revision"],
            result="accepted",
            job_id=job["job_id"],
            esphome_version=builder_manager.esphome_version,
            metadata={"port": "OTA"},
        )
        return {"job": job, "revision": active["revision"], "idempotent_replay": False}

    @application.get("/api/v1/jobs")
    async def list_builder_jobs(request: Request) -> dict:
        require_capability(request, "firmware.compile")
        return {"jobs": await builder_manager.jobs()}

    @application.get("/api/v1/jobs/{job_id}")
    async def get_builder_job(job_id: str, request: Request) -> dict:
        require_capability(request, "firmware.compile")
        return {"job": await builder_manager.job(job_id)}

    @application.post("/api/v1/jobs/{job_id}/cancel", status_code=204)
    async def cancel_builder_job(job_id: str, request: Request) -> Response:
        user_id = require_capability(request, "firmware.compile")
        job = await builder_manager.job(job_id)
        await builder_manager.cancel(job_id)
        audit.record(
            user_id=user_id,
            action="firmware.job.cancel",
            configuration=str(job.get("configuration", "")),
            old_revision=None,
            new_revision=None,
            result="success",
            job_id=job_id,
            esphome_version=builder_manager.esphome_version,
        )
        return Response(status_code=204)

    @application.post("/api/v1/configurations/{name:path}/publish")
    async def publish(name: str, body: PublishRequest, request: Request) -> dict:
        user_id = require_capability(request, "configuration.publish")
        lock = configuration_job_locks.setdefault(name, asyncio.Lock())
        try:
            async with lock:
                if builder_manager.available:
                    await reject_parallel_job(name)
                result = filesystem.publish(name, body.expected_revision)
                workflow.invalidate_validation(name)
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

    @application.get("/api/v1/viewer/runtime")
    async def get_viewer_runtime(request: Request) -> dict:
        """Return only the entity metadata and values needed by read-only bindings."""
        runtime_manager.ensure_enabled()
        require_capability(request, "device.states")
        return viewer_runtime_snapshot()

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

    @application.websocket("/api/v1/viewer/runtime/events")
    async def viewer_runtime_events(websocket: WebSocket) -> None:
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
        decision = rate_limiter.check(user_id, write=False)
        if not decision.allowed:
            await websocket.close(code=4429, reason="rate_limit_exceeded")
            return
        await websocket.accept()
        queue = runtime_manager.subscribe()
        try:
            await websocket.send_json(viewer_runtime_snapshot())
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except TimeoutError:
                    await websocket.send_json({"type": "heartbeat"})
                    continue
                filtered = viewer_runtime_event(event)
                if filtered is not None:
                    await websocket.send_json(filtered)
        except WebSocketDisconnect:
            pass
        finally:
            runtime_manager.unsubscribe(queue)

    @application.websocket("/api/v1/jobs/events")
    async def builder_job_events(websocket: WebSocket) -> None:
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
        allowed = capabilities(
            settings, role, builder_available=builder_manager.available
        ).get("firmware.compile", False)
        if not user_id or not allowed:
            await websocket.close(code=4403, reason="permission_denied")
            return
        decision = rate_limiter.check(user_id, write=False)
        if not decision.allowed:
            await websocket.close(code=4429, reason="rate_limit_exceeded")
            return
        await websocket.accept()
        backoff = 1

        async def forward(event: dict[str, Any]) -> None:
            data = event.get("data")
            if isinstance(data, dict) and "line" in data:
                data = {**data, "line": sanitize_output(data["line"])}
            elif event.get("event") == "output":
                data = sanitize_output(data)
            await websocket.send_json({"type": "builder_job", "event": event.get("event"), "data": data})

        try:
            while True:
                try:
                    await websocket.send_json(
                        {"type": "builder_status", "builder": builder_manager.status()}
                    )
                    await builder_manager.follow_jobs(forward)
                    raise BuilderAdapterError(
                        "builder_stream_ended", "The Device Builder event stream ended."
                    )
                except (BuilderAdapterError, ApiError):
                    await websocket.send_json(
                        {"type": "resync_required", "builder": builder_manager.status()}
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                    await builder_manager.probe()
        except (WebSocketDisconnect, RuntimeError):
            pass

    @application.get("/api/v1/designer/schemas")
    async def designer_schemas(language: str = Query(default="de", pattern="^(de|en)$")) -> dict:
        return designer.schemas(language)

    @application.post("/api/v1/designer/projects/validate")
    async def validate_project(body: DesignerProjectRequest) -> dict:
        project, issues = designer.validate(body.project)
        return {
            "valid": not any(issue["severity"] == "error" for issue in issues),
            "issues": issues,
            "project": designer.project_payload(project),
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

    @application.post("/api/v1/designer/assets/images")
    async def upload_image_asset(body: AssetImageRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            content = base64.b64decode(body.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ApiError("invalid_request", "content_base64 is not valid base64.", 422) from exc
        try:
            result = filesystem.write_image_asset(body.name, content)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.asset.write",
                configuration=body.name,
                old_revision=None,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.asset.write",
            configuration=body.name,
            old_revision=None,
            new_revision=result["path"],
            result="success",
        )
        return result

    @application.post("/api/v1/designer/assets/fonts")
    async def upload_font_asset(body: AssetFontRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            content = base64.b64decode(body.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ApiError("invalid_request", "content_base64 is not valid base64.", 422) from exc
        try:
            result = filesystem.write_font_asset(body.name, content)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.asset.write",
                configuration=body.name,
                old_revision=None,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.asset.write",
            configuration=body.name,
            old_revision=None,
            new_revision=result["path"],
            result="success",
        )
        return result

    @application.post("/api/v1/designer/font-sources/check")
    async def check_font_source(body: FontSourceCheckRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            result = await asyncio.to_thread(
                font_sources.check,
                body.url,
                etag=body.etag,
                last_modified=body.last_modified,
                sha256=body.sha256,
            )
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.font_source.check",
                configuration=body.url,
                old_revision=body.sha256 or None,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.font_source.check",
            configuration=body.url,
            old_revision=body.sha256 or None,
            new_revision=result.get("sha256") or result.get("etag") or None,
            result="changed" if result["changed"] else "current",
        )
        return result

    @application.post("/api/v1/designer/font-sources/update")
    async def update_font_source(body: FontSourceUpdateRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            result = await asyncio.to_thread(font_sources.update, body.id, body.url)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.font_source.update",
                configuration=body.url,
                old_revision=None,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.font_source.update",
            configuration=body.url,
            old_revision=None,
            new_revision=result["sha256"],
            result="success",
        )
        return result

    @application.post("/api/v1/designer/fonts/glyph-coverage")
    async def font_glyph_coverage(body: FontGlyphCoverageRequest) -> dict:
        # This POST carries a bounded list of codepoints but is read-only;
        # use the same availability check as GET /assets/read instead of the
        # write-operation identity gate used by mutating POST endpoints.
        ensure_capability_available("designer.asset_read")
        invalid = [
            value for value in body.codepoints
            if value < 0 or value > 0x10FFFF or 0xD800 <= value <= 0xDFFF
        ]
        if invalid:
            raise ApiError("invalid_codepoint", "Glyph list contains an invalid Unicode codepoint.", 422)
        return await asyncio.to_thread(
            font_sources.glyph_coverage,
            body.path,
            list(dict.fromkeys(body.codepoints)),
        )

    @application.get("/api/v1/designer/assets/read/{name:path}")
    async def read_designer_asset(name: str) -> Response:
        ensure_capability_available("designer.asset_read")
        content, content_type = filesystem.read_asset(name)
        return Response(
            content=content,
            media_type=content_type,
            headers={"Cache-Control": "no-store"},
        )

    @application.get("/api/v1/designer/projects")
    async def list_designer_projects() -> dict:
        return {"projects": projects.list()}

    @application.get("/api/v1/designer/projects/{name}")
    async def get_designer_project(name: str) -> dict:
        return projects.read(name)

    @application.get("/api/v1/viewer/bindings/{name}")
    async def get_viewer_bindings(name: str, request: Request) -> dict:
        require_capability(request, "designer.project")
        projects.read(name)
        return viewer_bindings.read(name)

    @application.put("/api/v1/viewer/bindings/{name}")
    async def save_viewer_bindings(
        name: str, body: ViewerBindingsRequest, request: Request
    ) -> dict:
        user_id = require_capability(request, "designer.project_write")
        try:
            project_payload = projects.read(name)["project"]
            widget_types = project_widget_types(project_payload)
            target_types = {
                "text": {"label"},
                "value": {"slider", "bar", "arc"},
                "state_checked": {"switch"},
            }
            normalized = validate_bindings(body.bindings)
            for binding in normalized:
                actual_type = widget_types.get(binding["widget_id"])
                if actual_type not in target_types[binding["target"]]:
                    raise ApiError(
                        "invalid_binding_target",
                        "The selected Viewer target does not match the stored widget.",
                        422,
                        {"widget_id": binding["widget_id"], "widget_type": actual_type},
                    )
                runtime_manager.registry.get(binding["device_id"])
            result = viewer_bindings.save(name, normalized, body.expected_revision)
        except ApiError as exc:
            audit.record(
                user_id=user_id,
                action="designer.viewer_bindings.save",
                configuration=name,
                old_revision=body.expected_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        audit.record(
            user_id=user_id,
            action="designer.viewer_bindings.save",
            configuration=name,
            old_revision=result["old_revision"],
            new_revision=result["revision"],
            result="success",
        )
        return result

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
        viewer_bindings.delete(name)
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
