"""Minimal stdlib-only Anthropic Messages API client.

No SDK dependency: the same "hand-roll the wire protocol instead of adding a
package" principle already used for the MCP Apps postMessage bridge (see
mcp/apps/preview.html) and the existing http.client-based loopback probe in
mcp/health.py. One HTTPS POST, bounded timeout and response size.
"""

from __future__ import annotations

import http.client
import json
import ssl
from typing import Any

from ..errors import ApiError

ANTHROPIC_API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5"
_HOST = "api.anthropic.com"
_PATH = "/v1/messages"
_MAX_RESPONSE_BYTES = 1024 * 1024


def call_messages_api(
    *,
    api_key: str,
    system: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tokens: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    body = json.dumps(
        {
            "model": DEFAULT_MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "tools": tools,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    connection = http.client.HTTPSConnection(
        _HOST,
        timeout=max(1.0, timeout_seconds),
        context=ssl.create_default_context(),
    )
    try:
        connection.request(
            "POST",
            _PATH,
            body=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": ANTHROPIC_API_VERSION,
                "Content-Length": str(len(body)),
            },
        )
        response = connection.getresponse()
        payload = response.read(_MAX_RESPONSE_BYTES + 1)
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        raise ApiError(
            "assistant_upstream_unavailable",
            "The AI help panel could not reach Anthropic's API.",
            502,
        ) from exc
    finally:
        connection.close()
    if len(payload) > _MAX_RESPONSE_BYTES:
        raise ApiError(
            "assistant_response_too_large",
            "Anthropic's API response exceeded the configured size limit.",
            502,
        )
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ApiError(
            "assistant_upstream_invalid_response",
            "Anthropic's API returned an invalid response.",
            502,
        ) from exc
    if response.status != 200:
        message = (
            decoded.get("error", {}).get("message")
            if isinstance(decoded, dict) and isinstance(decoded.get("error"), dict)
            else None
        )
        raise ApiError(
            "assistant_upstream_error",
            message or f"Anthropic's API returned status {response.status}.",
            502,
        )
    if not isinstance(decoded, dict):
        raise ApiError(
            "assistant_upstream_invalid_response",
            "Anthropic's API returned an unexpected response shape.",
            502,
        )
    return decoded
