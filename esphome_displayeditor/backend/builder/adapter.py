"""Strict WebSocket adapter for the official ESPHome Device Builder API."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import connect


_ALLOWED_COMMANDS = frozenset(
    {
        "devices/list",
        "devices/validate",
        "firmware/compile",
        "firmware/install",
        "firmware/get_jobs",
        "firmware/get_job",
        "firmware/follow_jobs",
        "firmware/cancel",
    }
)
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


class BuilderAdapterError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class BuilderServerInfo:
    server_version: str
    esphome_version: str
    requires_auth: bool


@dataclass(frozen=True)
class BuilderResponse:
    info: BuilderServerInfo
    result: Any
    events: tuple[dict[str, Any], ...]


def _safe_builder_ws_url(base_url: str) -> str:
    value = base_url.strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise BuilderAdapterError("invalid_builder_url", "The Device Builder URL is invalid.") from exc
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        raise BuilderAdapterError("invalid_builder_url", "The Device Builder URL scheme is not allowed.")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BuilderAdapterError("invalid_builder_url", "The Device Builder URL is not allowed.")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost":
        raise BuilderAdapterError("invalid_builder_url", "Loopback Device Builder targets are not allowed.")
    try:
        address = ip_address(host)
    except ValueError:
        # Home Assistant app DNS aliases are single-label names. Local DNS
        # names are allowed; public fully-qualified names are not.
        if "." in host and not host.endswith((".local", ".lan", ".home.arpa")):
            raise BuilderAdapterError("invalid_builder_url", "Only local Device Builder targets are allowed.") from None
    else:
        if address.is_loopback or not (address.is_private or address.is_link_local):
            raise BuilderAdapterError("invalid_builder_url", "Only private Device Builder targets are allowed.")
    scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    path = parsed.path.rstrip("/")
    if path and path != "/ws":
        raise BuilderAdapterError("invalid_builder_url", "The Device Builder URL path is not allowed.")
    return urlunsplit((scheme, netloc, "/ws", "", ""))


def sanitize_output(value: Any) -> str:
    text = _ANSI.sub("", str(value))
    return "".join(char for char in text if char in "\t\n\r" or ord(char) >= 32)[:4096]


class DeviceBuilderWebSocketAdapter:
    """One connection per operation; builder jobs remain server-persistent."""

    def __init__(self, base_url: str, *, timeout: int = 300) -> None:
        self.ws_url = _safe_builder_ws_url(base_url)
        self.timeout = timeout

    async def _handshake(self, websocket: Any) -> BuilderServerInfo:
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=min(self.timeout, 10))
            message = json.loads(raw)
        except (TimeoutError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise BuilderAdapterError("builder_handshake_failed", "The Device Builder handshake is invalid.") from exc
        if not isinstance(message, dict):
            raise BuilderAdapterError("builder_handshake_failed", "The Device Builder handshake is invalid.")
        server_version = message.get("server_version")
        esphome_version = message.get("esphome_version")
        if not isinstance(server_version, str) or not isinstance(esphome_version, str):
            raise BuilderAdapterError("builder_handshake_failed", "The Device Builder version is missing.")
        if message.get("requires_auth") is True:
            raise BuilderAdapterError("builder_auth_required", "The Device Builder requires separate authentication.")
        return BuilderServerInfo(server_version, esphome_version, False)

    async def probe(self) -> BuilderServerInfo:
        try:
            async with connect(
                self.ws_url,
                open_timeout=min(self.timeout, 10),
                close_timeout=5,
                max_size=2 * 1024 * 1024,
            ) as websocket:
                return await self._handshake(websocket)
        except BuilderAdapterError:
            raise
        except Exception as exc:
            raise BuilderAdapterError("builder_unreachable", "The Device Builder is not reachable.") from exc

    async def command(
        self,
        command: str,
        args: dict[str, Any] | None = None,
        *,
        on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> BuilderResponse:
        if command not in _ALLOWED_COMMANDS:
            raise BuilderAdapterError("builder_command_denied", "The Device Builder command is not allowed.")
        message_id = uuid.uuid4().hex
        events: list[dict[str, Any]] = []
        try:
            async with asyncio.timeout(self.timeout):
                async with connect(
                    self.ws_url,
                    open_timeout=min(self.timeout, 10),
                    close_timeout=5,
                    max_size=2 * 1024 * 1024,
                ) as websocket:
                    info = await self._handshake(websocket)
                    await websocket.send(
                        json.dumps(
                            {"command": command, "message_id": message_id, "args": args or {}},
                            separators=(",", ":"),
                        )
                    )
                    async for raw in websocket:
                        message = json.loads(raw)
                        if not isinstance(message, dict) or message.get("message_id") != message_id:
                            continue
                        if "error_code" in message:
                            raise BuilderAdapterError(
                                f"builder_{message.get('error_code', 'command_failed')}",
                                sanitize_output(message.get("details", "Device Builder command failed.")),
                            )
                        if "event" in message:
                            event = {
                                "event": sanitize_output(message.get("event", "")),
                                "data": message.get("data"),
                            }
                            events.append(event)
                            if on_event is not None:
                                await on_event(event)
                            continue
                        if "result" in message:
                            return BuilderResponse(info, message.get("result"), tuple(events))
        except BuilderAdapterError:
            raise
        except TimeoutError as exc:
            raise BuilderAdapterError("builder_timeout", "The Device Builder operation timed out.") from exc
        except Exception as exc:
            raise BuilderAdapterError("builder_connection_lost", "The Device Builder connection was lost.") from exc
        raise BuilderAdapterError("builder_protocol_error", "The Device Builder returned no result.")

    async def follow_jobs(
        self,
        on_event: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        # follow_jobs is intentionally long-lived. The outer caller owns
        # reconnect/backoff and therefore job resynchronisation.
        await self.command(
            "firmware/follow_jobs",
            {"snapshot": True},
            on_event=on_event,
        )
