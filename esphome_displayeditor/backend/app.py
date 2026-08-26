"""FastAPI entry point for the Home Assistant Ingress application."""

from __future__ import annotations

import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.viewer_projection import viewer_entity, viewer_state
from .api.routers.system import create_system_router
from .api.routers.builder import create_builder_router
from .api.routers.audit import create_audit_router
from .api.routers.jobs import create_jobs_router
from .api.routers.devices import create_devices_router
from .api.routers.admin_devices import create_admin_devices_router
from .api.routers.admin_mcp import create_admin_mcp_router
from .api.routers.runtime_events import create_runtime_events_router
from .api.routers.designer_projects import create_designer_projects_router
from .api.routers.configuration_files import create_configuration_files_router
from .api.routers.firmware_workflow import create_firmware_workflow_router
from .api.routers.designer_transform import create_designer_transform_router
from .api.routers.designer_import import create_designer_import_router
from .api.routers.designer_assets import create_designer_assets_router
from .api.routers.assistant import create_assistant_router
from .assistant_tools import AssistantToolService
from .audit import AuditStore
from .builder import BuilderManager
from .builder.adapter import BuilderAdapterError
from .designer import DesignerService
from .errors import ApiError, capability_unavailable
from .filesystem import FilesystemBackend
from .font_sources import FontSourceService
from .mcp.token_store import MCPTokenStore
from .project_store import ProjectStore
from .runtime import DeviceManager, DeviceRegistry, SecretStore
from .security import RateLimiter
from .settings import CAPABILITY_MINIMUM_ROLE, Settings, capabilities
from .version import APP_VERSION
from .viewer_bindings import ViewerBindingStore
from .workflow import WorkflowStore


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
    mcp_tokens = MCPTokenStore(settings.data_root)
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
    assistant_service = AssistantToolService(settings, builder=builder_manager)

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
    application.state.mcp_tokens = mcp_tokens

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
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: http: https:; font-src 'self' data: http: https:; "
            # https: alongside 'self'/ws:/wss: - the CSS Font Loading API
            # (new FontFace().load(), used for the MDI icon catalog preview
            # and any project font with source_kind "web") is governed by
            # connect-src in this browser, not font-src, even though the
            # resource it fetches is a font. Without this, loading an
            # external web font failed with a CSP violation, not the more
            # obvious-looking network/CORS error it otherwise resembles.
            "connect-src 'self' ws: wss: https:; "
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

    application.include_router(
        create_system_router(
            version=application.version,
            settings=settings,
            builder=builder_manager,
            request_identity=request_identity,
        )
    )

    application.include_router(
        create_builder_router(
            builder=builder_manager,
            require_capability=require_capability,
        )
    )

    application.include_router(
        create_configuration_files_router(
            filesystem=filesystem,
            audit=audit,
            ensure_capability_available=ensure_capability_available,
            require_capability=require_capability,
        )
    )

    application.include_router(
        create_firmware_workflow_router(
            filesystem=filesystem,
            builder=builder_manager,
            workflow=workflow,
            audit=audit,
            settings=settings,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_jobs_router(
            builder=builder_manager,
            audit=audit,
            settings=settings,
            rate_limiter=rate_limiter,
            allow_direct_access=allow_direct_access,
            trusted_ingress_hosts=trusted_ingress_hosts,
            require_capability=require_capability,
        )
    )

    application.include_router(
        create_audit_router(audit=audit, require_capability=require_capability)
    )

    application.include_router(
        create_devices_router(
            runtime=runtime_manager,
            require_capability=require_capability,
            viewer_snapshot=viewer_runtime_snapshot,
        )
    )
    application.include_router(
        create_admin_devices_router(
            runtime=runtime_manager,
            audit=audit,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_admin_mcp_router(
            store=mcp_tokens,
            audit=audit,
            settings=settings,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_assistant_router(
            service=assistant_service,
            settings=settings,
            audit=audit,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_runtime_events_router(
            runtime=runtime_manager,
            settings=settings,
            rate_limiter=rate_limiter,
            allow_direct_access=allow_direct_access,
            trusted_ingress_hosts=trusted_ingress_hosts,
            viewer_snapshot=viewer_runtime_snapshot,
            viewer_event=viewer_runtime_event,
        )
    )

    application.include_router(
        create_designer_transform_router(
            designer=designer,
            filesystem=filesystem,
            audit=audit,
            ensure_capability_available=ensure_capability_available,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_designer_import_router(
            designer=designer,
            filesystem=filesystem,
            ensure_capability_available=ensure_capability_available,
        )
    )
    application.include_router(
        create_designer_assets_router(
            filesystem=filesystem,
            font_sources=font_sources,
            settings=settings,
            audit=audit,
            ensure_capability_available=ensure_capability_available,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_designer_projects_router(
            projects=projects,
            viewer_bindings=viewer_bindings,
            runtime=runtime_manager,
            audit=audit,
            require_capability=require_capability,
        )
    )

    if serve_frontend:
        frontend = Path(__file__).resolve().parents[1] / "frontend"
        application.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")

    return application
