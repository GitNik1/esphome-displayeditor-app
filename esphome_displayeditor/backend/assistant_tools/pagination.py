"""Opaque, query-bound cursors for bounded MCP listings."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from ..errors import ApiError
from .limits import MCP_CURSOR_MAX_CHARACTERS


def cursor_fingerprint(value: Any) -> str:
    """Return a compact stable fingerprint for a result set or query."""
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class CursorCodec:
    """Sign offsets so clients cannot forge or reuse them across queries."""

    def __init__(self, secret: str) -> None:
        self._key = hashlib.sha256(
            f"esphome-display-editor:mcp-cursor:v1:{secret}".encode("utf-8")
        ).digest()

    def encode(self, *, scope: str, offset: int, fingerprint: str) -> str:
        payload = json.dumps(
            {"v": 1, "s": scope, "o": offset, "f": fingerprint},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        signature = hmac.new(self._key, payload, hashlib.sha256).digest()
        return f"{_encode(payload)}.{_encode(signature)}"

    def decode(self, cursor: str, *, scope: str, fingerprint: str) -> int:
        if not cursor:
            return 0
        if len(cursor) > MCP_CURSOR_MAX_CHARACTERS:
            raise ApiError("invalid_cursor", "The pagination cursor is invalid.", 422)
        try:
            encoded_payload, encoded_signature = cursor.split(".", 1)
            payload = _decode(encoded_payload)
            signature = _decode(encoded_signature)
            expected = hmac.new(self._key, payload, hashlib.sha256).digest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            value = json.loads(payload.decode("utf-8"))
            offset = int(value["o"])
        except (ValueError, TypeError, KeyError, UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError("invalid_cursor", "The pagination cursor is invalid.", 422) from None
        if value.get("v") != 1 or value.get("s") != scope or offset < 0:
            raise ApiError("invalid_cursor", "The pagination cursor is invalid.", 422)
        if value.get("f") != fingerprint:
            raise ApiError(
                "cursor_stale",
                "The paginated result changed; restart without a cursor.",
                409,
            )
        return offset
