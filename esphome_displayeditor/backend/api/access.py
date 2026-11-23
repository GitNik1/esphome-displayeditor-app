"""Who is calling and what they may do: one implementation for the HTTP
middleware, the routes and the WebSocket endpoints.

WebSockets never pass the HTTP middleware, so the event streams
(``/jobs/events``, ``/devices/events`` and ``/viewer/runtime/events``) used to
carry their own copies of the Ingress check, the identity lookup and the
rate limit. Keeping all of it here stops those copies drifting apart.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Request, WebSocket
from starlette.requests import HTTPConnection

from ..audit import AuditStore
from ..builder import BuilderManager
from ..errors import ApiError, capability_unavailable
from ..security import RateLimiter
from ..settings import CAPABILITY_MINIMUM_ROLE, Settings, capabilities

LOCAL_DEVELOPMENT_USER = "local-development"
_DEFAULT_INGRESS_HOSTS = "172.30.32.2"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})


def client_host(connection: HTTPConnection) -> str:
    return connection.client.host if connection.client else "unknown"


def _is_loopback_health_check(request: Request, host: str) -> bool:
    """The container's own HEALTHCHECK (Dockerfile) probes from inside the
    container; refused like any non-Ingress client, the app was reported
    unhealthy forever. It only ever learns the status and the version."""
    return (host in _LOOPBACK_HOSTS and request.method == "GET"
            and request.url.path == "/api/v1/health")


@dataclass(frozen=True)
class IngressPolicy:
    """Only the Supervisor's Ingress proxy may reach the app, unless direct
    access is switched on (tests, local development)."""

    allow_direct_access: bool
    trusted_hosts: frozenset[str]

    @classmethod
    def from_environment(cls, *, allow_direct_access: bool = False) -> IngressPolicy:
        hosts = os.getenv("ESPHOME_TRUSTED_INGRESS_HOSTS", _DEFAULT_INGRESS_HOSTS)
        return cls(
            allow_direct_access=(
                allow_direct_access or os.getenv("ESPHOME_ALLOW_DIRECT_ACCESS") == "1"
            ),
            trusted_hosts=frozenset(host.strip() for host in hosts.split(",") if host.strip()),
        )

    def admits(self, host: str) -> bool:
        return self.allow_direct_access or host in self.trusted_hosts

    def admits_request(self, request: Request) -> bool:
        host = client_host(request)
        return self.admits(host) or _is_loopback_health_check(request, host)


class AccessControl:
    """Identity, role and capability checks shared by every route."""

    def __init__(
        self,
        settings: Settings,
        *,
        builder: BuilderManager,
        audit: AuditStore,
        ingress: IngressPolicy,
        rate_limiter: RateLimiter,
    ) -> None:
        self.settings = settings
        self.builder = builder
        self.audit = audit
        self.ingress = ingress
        self.rate_limiter = rate_limiter

    def identity(self, connection: HTTPConnection) -> tuple[str | None, str]:
        """The Ingress user and their role. Ingress sets the header; without
        it there is no user, except in local development."""
        user_id = connection.headers.get("X-Remote-User-Id", "").strip() or None
        if not user_id and os.getenv("ESPHOME_ALLOW_ANONYMOUS_WRITE") == "1":
            return LOCAL_DEVELOPMENT_USER, "administrator"
        return user_id, self.settings.role_for(user_id)

    def allows(self, role: str, capability: str) -> bool:
        return capabilities(
            self.settings, role, builder_available=self.builder.available
        ).get(capability, False)

    def ensure_capability_available(self, capability: str) -> None:
        if not self.allows("administrator", capability):
            raise capability_unavailable(capability, self.settings.access_level)

    def require_capability(self, request: Request, capability: str) -> str:
        self.ensure_capability_available(capability)
        user_id, role = self.identity(request)
        if not user_id:
            raise ApiError(
                "permission_denied",
                "A Home Assistant Ingress user is required for write operations.",
                403,
            )
        if not self.allows(role, capability):
            self.audit.record(
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

    async def authorize_websocket(self, websocket: WebSocket, capability: str) -> str | None:
        """Return the user for an event stream, or close the socket with the
        reason (before accepting it) and return ``None``. Same order as for
        HTTP: Ingress, availability, user and role, rate limit - a client
        outside Ingress learns nothing else."""
        if not self.ingress.admits(client_host(websocket)):
            await websocket.close(code=4403, reason="ingress_required")
            return None
        if not self.allows("administrator", capability):
            await websocket.close(code=4403, reason="capability_unavailable")
            return None
        user_id, role = self.identity(websocket)
        if not user_id or not self.allows(role, capability):
            await websocket.close(code=4403, reason="permission_denied")
            return None
        if not self.rate_limiter.check(user_id, write=False).allowed:
            await websocket.close(code=4429, reason="rate_limit_exceeded")
            return None
        return user_id
