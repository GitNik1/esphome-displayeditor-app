"""Shared MCP result encoding and tool annotations."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import concurrent.futures
import json
from typing import Any

from mcp.types import ToolAnnotations

from ..assistant_tools.concurrency import default_limiter
from ..assistant_tools.limits import (
    MCP_RESPONSE_MAX_BYTES,
    MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS,
    MCP_TOOL_TIMEOUT_SECONDS,
)
from ..builder.adapter import BuilderAdapterError
from ..errors import ApiError
from .identity import MCPAuthorization, WRITE_SCOPES, require_scopes


# One shared pool bounds a tool call's execution time without blocking the
# thread the MCP SDK already runs the (synchronous) tool handler on: the
# handler's real work runs here, and the caller only waits up to
# MCP_TOOL_TIMEOUT_SECONDS for it. Windows has no SIGALRM, so a
# signal-based deadline is not an option; this is the portable equivalent.
# A timed-out call keeps running to completion in the background - this is
# a caller-facing deadline, not preemptive cancellation.
_TIMEOUT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=64,
    thread_name_prefix="mcp-tool",
)


READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)
PROPOSAL = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=False,
    open_world_hint=False,
)
APPLY = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=True,
    open_world_hint=False,
)
# Producing a validation proof (a side effect on the workflow store) without
# touching project or YAML content: not read-only, but re-running it is safe
# and it talks to an external system (the ESPHome Device Builder).
VALIDATE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=True,
)
# Starting/cancelling a firmware compile or install job. Each call starts a
# distinct job (not idempotent) and talks to an external builder/device.
FIRMWARE_ACTION = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=False,
    open_world_hint=True,
)


def _finalize_result(result: dict[str, Any]) -> dict[str, Any]:
    serialized = json.dumps(result, ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MCP_RESPONSE_MAX_BYTES:
        return {
            "ok": False,
            "error": "response_too_large",
            "message": "The result exceeds the MCP response limit; request a smaller view.",
            "details": {"maximum_bytes": MCP_RESPONSE_MAX_BYTES},
        }
    if len(serialized) > MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS:
        # Below the hard byte ceiling, so still returned in full - but
        # large enough to warrant asking for a narrower view before a
        # client's own output-size warnings kick in.
        result["output_size_warning"] = (
            "This result exceeds the recommended "
            f"{MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS}-character size; "
            "consider a narrower view, pagination, or a smaller cursor page."
        )
    return result


def _error_result(error: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"ok": False, "error": error, "message": message, "details": details}


_TOOL_TIMEOUT_MESSAGE = "The MCP tool call exceeded its execution time limit."
_TOOL_TIMEOUT_DETAILS = {"timeout_seconds": MCP_TOOL_TIMEOUT_SECONDS}


def tool_result(operation: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        result = {"ok": True, **operation()}
    except ApiError as exc:
        return _error_result(exc.error, exc.message, exc.details)
    return _finalize_result(result)


async def async_tool_result(
    operation: Callable[[], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    """Async counterpart of ``tool_result`` for genuinely async tool bodies.

    Used only by tools that talk to the Device Builder (async, WebSocket-
    backed): those run as ``async def`` MCP tool handlers, awaited directly
    on the SDK's own event loop rather than offloaded to a thread pool, so
    this must not route through the synchronous ``_run_with_timeout``.
    """
    try:
        result = {"ok": True, **(await operation())}
    except ApiError as exc:
        return _error_result(exc.error, exc.message, exc.details)
    except BuilderAdapterError as exc:
        return _error_result(exc.code, exc.message, {})
    except TimeoutError:
        return _error_result("tool_timeout", _TOOL_TIMEOUT_MESSAGE, _TOOL_TIMEOUT_DETAILS)
    return _finalize_result(result)


def _run_with_timeout(operation: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    future = _TIMEOUT_EXECUTOR.submit(operation)
    try:
        return future.result(timeout=MCP_TOOL_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError as exc:
        raise ApiError(
            "tool_timeout", _TOOL_TIMEOUT_MESSAGE, 504, _TOOL_TIMEOUT_DETAILS
        ) from exc


def resource_json(operation: Callable[[], dict[str, Any]]) -> str:
    result = json.dumps(operation(), ensure_ascii=False)
    if len(result.encode("utf-8")) > MCP_RESPONSE_MAX_BYTES:
        raise ApiError(
            "response_too_large",
            "The resource exceeds the MCP response limit; use a narrower tool view.",
            413,
            {"maximum_bytes": MCP_RESPONSE_MAX_BYTES},
        )
    return result


def scoped_tool_result(
    required_scopes: tuple[str, ...],
    fallback: MCPAuthorization | None,
    operation: Callable[[MCPAuthorization], dict[str, Any]],
) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        authorization = require_scopes(required_scopes, fallback)
        with default_limiter().slot(
            authorization.identity,
            write=_is_write_scope(required_scopes),
        ):
            return _run_with_timeout(lambda: operation(authorization))

    return tool_result(run)


async def scoped_async_tool_result(
    required_scopes: tuple[str, ...],
    fallback: MCPAuthorization | None,
    operation: Callable[[MCPAuthorization], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    async def run() -> dict[str, Any]:
        authorization = require_scopes(required_scopes, fallback)
        with default_limiter().slot(
            authorization.identity,
            write=_is_write_scope(required_scopes),
        ):
            return await asyncio.wait_for(
                operation(authorization), timeout=MCP_TOOL_TIMEOUT_SECONDS
            )

    return await async_tool_result(run)


def scoped_resource_json(
    required_scopes: tuple[str, ...],
    fallback: MCPAuthorization | None,
    operation: Callable[[MCPAuthorization], dict[str, Any]],
) -> str:
    authorization = require_scopes(required_scopes, fallback)
    with default_limiter().slot(
        authorization.identity,
        write=_is_write_scope(required_scopes),
    ):
        return resource_json(lambda: _run_with_timeout(lambda: operation(authorization)))


def _is_write_scope(required_scopes: tuple[str, ...]) -> bool:
    return any(scope in WRITE_SCOPES for scope in required_scopes)
