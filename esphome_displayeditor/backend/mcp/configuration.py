"""Validation and transport allowlist handling for MCP."""

from __future__ import annotations

from urllib.parse import urlsplit

from ..assistant_tools.limits import MCP_MIN_TOKEN_LENGTH
from ..settings import Settings


def validate_mcp_settings(settings: Settings) -> None:
    if settings.mcp_mode == "disabled":
        return
    if settings.mcp_mode != "lan":
        raise ValueError("Unsupported MCP mode; use 'disabled' or 'lan'.")
    if settings.mcp_access not in {"read_only", "project_write"}:
        raise ValueError("Unsupported MCP access; use 'read_only' or 'project_write'.")
    if settings.mcp_access == "project_write" and settings.access_level not in {
        "write",
        "write_with_builder",
    }:
        raise ValueError(
            "mcp_access 'project_write' requires a writable application access_level."
        )
    if len(settings.mcp_access_token) < MCP_MIN_TOKEN_LENGTH:
        raise ValueError(
            f"mcp_access_token must contain at least {MCP_MIN_TOKEN_LENGTH} characters."
        )
    normalise_allowed_hosts(settings.mcp_allowed_hosts)
    normalise_allowed_origins(settings.mcp_allowed_origins)


def normalise_allowed_hosts(values: tuple[str, ...]) -> list[str]:
    if not values:
        raise ValueError("mcp_allowed_hosts must contain at least one host.")
    result = []
    for value in values:
        host = value.strip()
        if (
            not host
            or len(host) > 255
            or any(char.isspace() for char in host)
            or "/" in host
            or "\\" in host
            or "://" in host
        ):
            raise ValueError(f"Invalid MCP allowed host: {value!r}.")
        if host.endswith(":*"):
            result.append(host)
        elif host.startswith("[") and host.endswith("]"):
            result.append(f"{host}:*")
        elif ":" not in host:
            result.append(f"{host}:*")
        else:
            result.append(host)
    return result


def normalise_allowed_origins(values: tuple[str, ...]) -> list[str]:
    result = []
    for value in values:
        origin = value.strip().rstrip("/")
        if not origin or len(origin) > 512 or any(char.isspace() for char in origin):
            raise ValueError(f"Invalid MCP allowed origin: {value!r}.")
        wildcard_port = origin.endswith(":*")
        parsed_origin = origin[:-2] if wildcard_port else origin
        try:
            parsed = urlsplit(parsed_origin)
            port = parsed.port
        except ValueError as exc:
            raise ValueError(f"Invalid MCP allowed origin: {value!r}.") from exc
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"Invalid MCP allowed origin: {value!r}.")
        if (
            parsed.path
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise ValueError(f"Invalid MCP allowed origin: {value!r}.")
        if port is None and not wildcard_port:
            origin = f"{origin}:*"
        result.append(origin)
    return result
