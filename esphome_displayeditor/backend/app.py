"""FastAPI entry point for the Home Assistant Ingress application."""

from __future__ import annotations

import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.access import AccessControl, IngressPolicy, client_host
from .api.error_handlers import install_error_handlers
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
from .api.routers.project_revisions import create_project_revisions_router
from .api.routers.project_resync import create_project_resync_router
from .api.routers.configuration_files import create_configuration_files_router
from .api.routers.firmware_workflow import create_firmware_workflow_router
from .api.routers.designer_transform import create_designer_transform_router
from .api.routers.designer_import import create_designer_import_router
from .api.routers.designer_assets import create_designer_assets_router
from .api.routers.assistant import create_assistant_router
from .assistant_tools import AssistantToolService
from .builder import BuilderManager
from .errors import ApiError
from .font_sources import FontSourceService
from .mcp.token_store import MCPTokenStore
from .runtime import DeviceManager, SecretStore
from .security import RateLimiter
from .settings import Settings
from .stores import Stores
from .version import APP_VERSION

_ASSET_READ_PREFIX = "/api/v1/designer/assets/read/"


def _is_asset_read(request: Request) -> bool:
    return request.method in {"GET", "HEAD"} and request.url.path.startswith(_ASSET_READ_PREFIX)


def create_app(
    runtime_settings: Settings | None = None,
    *,
    serve_frontend: bool = True,
    runtime_manager: DeviceManager | None = None,
    builder_manager: BuilderManager | None = None,
) -> FastAPI:
    settings = runtime_settings or Settings.load()
    stores = Stores.open(settings)
    filesystem, audit, designer = stores.filesystem, stores.audit, stores.designer
    projects, revisions = stores.projects, stores.revisions
    font_sources = FontSourceService(
        filesystem,
        max_size=min(settings.request_max_size, 16 * 1024 * 1024),
    )
    mcp_tokens = MCPTokenStore(settings.data_root)
    rate_limiter = RateLimiter(
        settings.api_rate_limit_per_minute,
        settings.write_rate_limit_per_minute,
    )
    # Settings passed in (tests) mean nothing sits in front of the app.
    ingress = IngressPolicy.from_environment(allow_direct_access=runtime_settings is not None)

    if runtime_manager is None:
        runtime_manager = DeviceManager(
            stores.device_registry,
            SecretStore(settings.data_root),
            enabled=settings.runtime_provider == "native",
        )
    if builder_manager is None:
        builder_manager = BuilderManager(settings)
    access = AccessControl(settings, builder=builder_manager, audit=audit,
                           ingress=ingress, rate_limiter=rate_limiter)
    require_capability = access.require_capability
    ensure_capability_available = access.ensure_capability_available
    assistant_service = AssistantToolService(settings, builder=builder_manager, stores=stores)

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
    application.state.workflow = stores.workflow
    application.state.mcp_tokens = mcp_tokens

    @application.middleware("http")
    async def security_boundary(request: Request, call_next):
        if not ingress.admits_request(request):
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
            identity = user_id or f"client:{client_host(request)}"
            decision = rate_limiter.check(
                identity,
                write=request.method not in {"GET", "HEAD", "OPTIONS"},
                asset=_is_asset_read(request),
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
        if _is_asset_read(request):
            pass  # revalidated through its ETag - see designer_assets.read_asset
        elif request.url.path.startswith("/api/v1/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.method == "GET":
            response.headers["Cache-Control"] = "no-cache"
        return response

    install_error_handlers(application)

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
            request_identity=access.identity,
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
            workflow=stores.workflow,
            audit=audit,
            settings=settings,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_jobs_router(
            builder=builder_manager,
            audit=audit,
            require_capability=require_capability,
            authorize_websocket=access.authorize_websocket,
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
            authorize_websocket=access.authorize_websocket,
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
        create_project_resync_router(
            projects=projects,
            revisions=revisions,
            designer=designer,
            filesystem=filesystem,
            audit=audit,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_designer_projects_router(
            projects=projects,
            viewer_bindings=stores.viewer_bindings,
            runtime=runtime_manager,
            audit=audit,
            require_capability=require_capability,
        )
    )
    application.include_router(
        create_project_revisions_router(
            projects=projects,
            revisions=revisions,
            designer=designer,
            audit=audit,
            request_identity=access.identity,
            ensure_capability_available=ensure_capability_available,
            require_capability=require_capability,
        )
    )

    if serve_frontend:
        frontend = Path(__file__).resolve().parents[1] / "frontend"
        application.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")

    return application
