"""Authentication middleware for the independently exposed MCP endpoint."""

from __future__ import annotations

import json
import secrets
from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from ..assistant_tools.limits import (
    MCP_LARGE_TOOL_ARGUMENTS_MAX_BYTES,
    MCP_REQUEST_MAX_BYTES,
    MCP_TOOL_ARGUMENTS_MAX_BYTES,
)
from ..security import RateLimiter
from ..errors import ApiError
from .identity import MCPAuthorization, bind_authorization


# Read-only tools, kept in sync with the tool registrations in server.py and
# discovery.py. Anything not on this list - including any future tool this
# list forgets to grow with - is billed against the smaller write bucket.
_READ_ONLY_TOOL_NAMES = frozenset(
    {
        "display_server_info",
        "display_catalog",
        "display_projects",
        "display_configurations",
        "display_configuration_read",
        "display_project_read",
        "display_project_validate",
        "display_project_revisions",
        "display_project_revision_read",
        "display_binding_targets",
        "display_yaml_transform",
        "display_preview",
        "display_device_read",
        "display_changeset_read",
    }
)

# Tools whose one legitimate argument is an inline file body (e.g. pasted
# YAML) rather than the usual small structured parameters, so the general
# MCP_TOOL_ARGUMENTS_MAX_BYTES cap would reject a normal call. These get the
# separate, still-bounded MCP_LARGE_TOOL_ARGUMENTS_MAX_BYTES ceiling instead;
# each tool's own handler independently enforces its real content-size limit
# (e.g. settings.max_file_size), so this is only the outer transport bound.
_LARGE_ARGUMENT_TOOL_NAMES = frozenset({"display_project_import_yaml_propose"})


class BearerTokenMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app: ASGIApp,
        *,
        token: str = "",
        authorization: MCPAuthorization | None = None,
        authenticate: Callable[[str], MCPAuthorization | None] | None = None,
        requests_per_minute: int,
        write_requests_per_minute: int | None = None,
        preauth_requests_per_minute: int | None = None,
    ) -> None:
        super().__init__(app)
        if authenticate is not None:
            self.authenticate = authenticate
        elif authorization is not None:
            self.authenticate = lambda supplied: (
                authorization if secrets.compare_digest(supplied, token) else None
            )
        else:
            raise ValueError("MCP bearer authentication is not configured.")
        self.rate_limiter = RateLimiter(
            read_limit=requests_per_minute,
            write_limit=write_requests_per_minute or requests_per_minute,
        )
        preauth_limit = preauth_requests_per_minute or requests_per_minute
        self.preauth_rate_limiter = RateLimiter(
            read_limit=preauth_limit,
            write_limit=preauth_limit,
        )

    async def dispatch(self, request: Request, call_next) -> Response:
        client_host = request.client.host if request.client else "unknown"
        for identity in ("mcp:preauth:global", f"mcp:preauth:{client_host}"):
            preauth = self.preauth_rate_limiter.check(identity, write=False)
            if not preauth.allowed:
                return self._rate_limited(preauth.retry_after)
        if request.url.path.rstrip("/") == "/health":
            return await call_next(request)

        authorization = request.headers.get("authorization", "")
        supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not supplied or len(authorization) > 4096:
            return self._unauthorized()
        try:
            authorization = self.authenticate(supplied)
        except ApiError:
            return JSONResponse(
                {
                    "error": "authentication_unavailable",
                    "message": "MCP authentication is temporarily unavailable.",
                },
                status_code=503,
            )
        if authorization is None:
            return self._unauthorized()
        is_write, arguments_too_large = await self._classify_request(request)
        if arguments_too_large:
            return self._arguments_too_large()
        decision = self.rate_limiter.check(authorization.identity, write=is_write)
        if not decision.allowed:
            return self._rate_limited(decision.retry_after)
        request.state.mcp_authorization = authorization
        with bind_authorization(authorization):
            return await call_next(request)

    @staticmethod
    def _unauthorized() -> JSONResponse:
        return JSONResponse(
            {"error": "unauthorized", "message": "A valid MCP bearer token is required."},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )

    @staticmethod
    async def _classify_request(request: Request) -> tuple[bool, bool]:
        """Return ``(is_write, arguments_too_large)`` for one HTTP request.

        Classification reads the actual JSON-RPC body rather than trusting
        client-supplied Mcp-Method/Mcp-Name headers: those are only
        cross-checked against the body by the SDK for the stateless
        2026-07-28 request path, not for legacy 2025-11-25 sessions, so
        trusting them here would let a legacy-protocol client mislabel a
        real write call as a read to spend the larger read-rate budget
        instead of the write one. Reading the body here is safe under
        BaseHTTPMiddleware: Starlette caches it via ``_CachedRequest`` so the
        downstream MCP app still sees the full stream afterwards.
        """
        if request.method != "POST":
            return False, False
        try:
            raw = await request.body()
        except Exception:
            return True, False
        if len(raw) > MCP_REQUEST_MAX_BYTES:
            return True, False
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, ValueError):
            # Not decodable JSON-RPC at all; treat conservatively so an
            # unparseable POST cannot bypass the smaller write bucket.
            return True, False
        return (
            BearerTokenMiddleware._body_is_write(payload),
            BearerTokenMiddleware._arguments_oversized(payload),
        )

    @classmethod
    def _body_is_write(cls, payload: object) -> bool:
        if isinstance(payload, list):
            # A JSON-RPC batch is billed as a write if any entry is.
            return any(cls._body_is_write(item) for item in payload)
        if not isinstance(payload, dict):
            return True
        method = payload.get("method")
        if method != "tools/call":
            # Non-tool-call methods (initialize, resources/read,
            # completion/complete, ...) are read traffic; a missing/empty
            # method is treated conservatively as a write.
            return not method
        params = payload.get("params")
        name = params.get("name") if isinstance(params, dict) else None
        return name not in _READ_ONLY_TOOL_NAMES

    @classmethod
    def _arguments_oversized(cls, payload: object) -> bool:
        if isinstance(payload, list):
            return any(cls._arguments_oversized(item) for item in payload)
        if not isinstance(payload, dict) or payload.get("method") != "tools/call":
            return False
        params = payload.get("params")
        arguments = params.get("arguments") if isinstance(params, dict) else None
        if arguments is None:
            return False
        name = params.get("name") if isinstance(params, dict) else None
        limit = (
            MCP_LARGE_TOOL_ARGUMENTS_MAX_BYTES
            if name in _LARGE_ARGUMENT_TOOL_NAMES
            else MCP_TOOL_ARGUMENTS_MAX_BYTES
        )
        try:
            size = len(json.dumps(arguments, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            return True
        return size > limit

    @staticmethod
    def _arguments_too_large() -> JSONResponse:
        return JSONResponse(
            {
                "error": "tool_arguments_too_large",
                "message": "The tool call arguments exceed the configured MCP limit.",
            },
            status_code=413,
        )

    @staticmethod
    def _rate_limited(retry_after: int) -> JSONResponse:
        return JSONResponse(
            {
                "error": "rate_limit_exceeded",
                "message": "The MCP request rate limit was exceeded.",
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
