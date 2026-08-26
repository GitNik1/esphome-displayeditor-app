"""Request-local MCP client identity and least-privilege scope checks."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
from typing import Iterator

from ..errors import ApiError


READ_SCOPES = frozenset(
    {
        "server:read",
        "project:read",
        "configuration:read",
        "device:read",
    }
)
WRITE_SCOPES = frozenset(
    {
        "project:write",
        "configuration:draft",
        "configuration:publish",
        "configuration:validate",
        "changeset:read",
        "changeset:apply",
        "firmware:compile",
        "firmware:install",
    }
)


@dataclass(frozen=True)
class MCPAuthorization:
    """Authenticated identity without retaining or exposing its bearer token."""

    identity: str
    token_id: str
    scopes: frozenset[str]

    def summary(self) -> dict[str, object]:
        return {
            "identity": self.identity,
            "token_id": self.token_id,
            "scopes": sorted(self.scopes),
        }


_CURRENT_AUTHORIZATION: ContextVar[MCPAuthorization | None] = ContextVar(
    "mcp_authorization",
    default=None,
)


def authorization_for_token(token: str, access: str) -> MCPAuthorization:
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
    scopes = READ_SCOPES | (WRITE_SCOPES if access == "project_write" else frozenset())
    return MCPAuthorization(
        identity=f"mcp:lan:{digest}",
        token_id=digest,
        scopes=scopes,
    )


@contextmanager
def bind_authorization(authorization: MCPAuthorization) -> Iterator[None]:
    token = _CURRENT_AUTHORIZATION.set(authorization)
    try:
        yield
    finally:
        _CURRENT_AUTHORIZATION.reset(token)


def current_authorization(
    fallback: MCPAuthorization | None = None,
) -> MCPAuthorization:
    authorization = _CURRENT_AUTHORIZATION.get() or fallback
    if authorization is None:
        raise ApiError(
            "mcp_authentication_required",
            "An authenticated MCP client identity is required.",
            401,
        )
    return authorization


def require_scopes(
    required: tuple[str, ...],
    fallback: MCPAuthorization | None = None,
) -> MCPAuthorization:
    authorization = current_authorization(fallback)
    missing = sorted(set(required) - authorization.scopes)
    if missing:
        raise ApiError(
            "forbidden_scope",
            "The authenticated MCP client does not have the required scope.",
            403,
            {"required_scopes": list(required), "missing_scopes": missing},
        )
    return authorization


def has_scopes(
    required: tuple[str, ...],
    fallback: MCPAuthorization | None = None,
) -> bool:
    try:
        require_scopes(required, fallback)
    except ApiError:
        return False
    return True
