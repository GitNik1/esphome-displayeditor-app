"""Bounded loopback-only readiness probe for the separate MCP listener."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import http.client
import json
import time
from typing import Any

from ..assistant_tools.limits import (
    MCP_HEALTH_PROBE_TIMEOUT_SECONDS,
    MCP_HEALTH_RESPONSE_MAX_BYTES,
    MCP_PORT,
)


async def probe_mcp_listener() -> dict[str, Any]:
    """Probe the fixed local health endpoint without accepting a caller URL."""

    return await asyncio.to_thread(_probe_mcp_listener)


def _probe_mcp_listener() -> dict[str, Any]:
    started = time.perf_counter()
    checked_at = datetime.now(timezone.utc).isoformat()
    connection = http.client.HTTPConnection(
        "127.0.0.1",
        MCP_PORT,
        timeout=MCP_HEALTH_PROBE_TIMEOUT_SECONDS,
    )
    try:
        connection.request(
            "GET",
            "/health",
            headers={
                "Accept": "application/json",
                "Host": f"localhost:{MCP_PORT}",
            },
        )
        response = connection.getresponse()
        body = response.read(MCP_HEALTH_RESPONSE_MAX_BYTES + 1)
    except (OSError, TimeoutError, http.client.HTTPException):
        return _result("unavailable", checked_at, started)
    finally:
        connection.close()

    if response.status != 200 or len(body) > MCP_HEALTH_RESPONSE_MAX_BYTES:
        return _result("invalid_response", checked_at, started)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, TypeError):
        return _result("invalid_response", checked_at, started)
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return _result("invalid_response", checked_at, started)
    return _result("ok", checked_at, started)


def _result(status: str, checked_at: str, started: float) -> dict[str, Any]:
    return {
        "reachable": status == "ok",
        "status": status,
        "checked_at": checked_at,
        "latency_ms": max(0, round((time.perf_counter() - started) * 1000)),
    }
