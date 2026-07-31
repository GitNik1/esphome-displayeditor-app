"""Connection lifecycle, caches and bounded event distribution."""

from __future__ import annotations

import asyncio
import logging
import re
from collections import deque
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Callable

from ..errors import ApiError
from .native_client import AioEsphomeClient
from .registry import DeviceConfig, DeviceRegistry
from .secrets import SecretStore


_LOGGER = logging.getLogger(__name__)
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_value(value: Any, *, depth: int = 0) -> Any:
    if depth > 5:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {"binary_bytes": len(value)}
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_json_value(item, depth=depth + 1) for item in value[:256]]
    if isinstance(value, dict):
        return {
            str(key): _json_value(item, depth=depth + 1)
            for key, item in list(value.items())[:256]
            if not str(key).startswith("_")
        }
    if is_dataclass(value):
        return {
            item.name: _json_value(getattr(value, item.name), depth=depth + 1)
            for item in fields(value)
            if not item.name.startswith("_")
        }
    slots = getattr(type(value), "__slots__", ())
    if slots:
        return {
            name: _json_value(getattr(value, name), depth=depth + 1)
            for name in slots
            if isinstance(name, str) and not name.startswith("_") and hasattr(value, name)
        }
    return str(value)[:512]


def _model_type(value: Any, suffix: str) -> str:
    name = type(value).__name__
    if name.endswith(suffix):
        name = name[: -len(suffix)]
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def serialize_entity(value: Any) -> dict:
    result = _json_value(value)
    if not isinstance(result, dict):
        result = {"value": result}
    result["type"] = _model_type(value, "Info")
    return result


def serialize_state(value: Any) -> dict:
    result = _json_value(value)
    if not isinstance(result, dict):
        result = {"value": result}
    result["type"] = _model_type(value, "State")
    result["received_at"] = utc_now()
    result["available"] = True
    return result


def _state_key(state: dict) -> str:
    return f"{state.get('type', 'unknown')}:{state.get('key', state.get('object_id', 'unknown'))}"


def _safe_log(value: Any) -> dict:
    raw = getattr(value, "message", value)
    if isinstance(raw, bytes):
        text = raw.decode("utf-8", errors="replace")
    else:
        text = str(raw)
    text = _ANSI.sub("", text)
    text = "".join(char for char in text if char in "\t" or ord(char) >= 32)[:2048]
    level = getattr(value, "level", None)
    if isinstance(level, Enum):
        level = level.name
    elif isinstance(level, int):
        level = {
            0: "NONE",
            1: "ERROR",
            2: "WARN",
            3: "INFO",
            4: "CONFIG",
            5: "DEBUG",
            6: "VERBOSE",
            7: "VERY_VERBOSE",
        }.get(level, str(level))
    return {"received_at": utc_now(), "level": str(level or "INFO"), "message": text}


@dataclass
class RuntimeState:
    status: str = "configured"
    last_seen: str | None = None
    last_error: str | None = None
    api_version: str | None = None
    info: dict = field(default_factory=dict)
    entities: list[dict] = field(default_factory=list)
    states: dict[str, dict] = field(default_factory=dict)
    logs: deque[dict] = field(default_factory=lambda: deque(maxlen=1000))
    task: asyncio.Task | None = None
    client: Any = None


class DeviceManager:
    def __init__(
        self,
        registry: DeviceRegistry,
        secrets: SecretStore,
        *,
        enabled: bool = True,
        client_factory: Callable[[DeviceConfig, str], Any] = AioEsphomeClient,
    ) -> None:
        self.registry = registry
        self.secrets = secrets
        self.enabled = enabled
        self.client_factory = client_factory
        self._runtime: dict[str, RuntimeState] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._running = False

    async def start(self) -> None:
        self._running = True
        if not self.enabled:
            return
        for config in self.registry.list():
            self._start_device(config)

    async def stop(self) -> None:
        self._running = False
        tasks = [state.task for state in self._runtime.values() if state.task]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._runtime.clear()

    def _start_device(self, config: DeviceConfig) -> None:
        state = self._runtime.setdefault(config.id, RuntimeState())
        if state.task and not state.task.done():
            return
        state.task = asyncio.create_task(self._connection_loop(config), name=f"esphome-{config.id}")

    async def restart(self, device_id: str) -> None:
        if not self.enabled or not self._running:
            return
        config = self.registry.get(device_id)
        state = self._runtime.setdefault(device_id, RuntimeState())
        if state.task and not state.task.done():
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        state.task = None
        self._start_device(config)

    async def remove(self, device_id: str) -> None:
        state = self._runtime.pop(device_id, None)
        if state and state.task:
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        self._publish({"type": "device_removed", "device_id": device_id, "at": utc_now()})

    async def refresh_key_reference(self, key_ref: str) -> None:
        for config in self.registry.list():
            if config.encryption_key_ref == key_ref:
                await self.restart(config.id)

    async def _connection_loop(self, config: DeviceConfig) -> None:
        state = self._runtime.setdefault(config.id, RuntimeState())
        backoff = 1
        while self._running:
            key = self.secrets.get(config.encryption_key_ref)
            if key is None:
                self._set_status(config.id, "missing_key", "missing_encryption_key")
                await asyncio.sleep(60)
                continue
            stopped = asyncio.Event()

            async def on_stop(_expected: bool) -> None:
                stopped.set()

            client = None
            try:
                self._set_status(config.id, "connecting", None)
                client = self.client_factory(config, key)
                state.client = client
                await client.connect(on_stop)
                info, entities, _services = await client.snapshot()
                state.info = _json_value(info) or {}
                state.entities = [serialize_entity(entity) for entity in entities]
                state.api_version = client.api_version
                state.last_seen = utc_now()
                state.last_error = None
                client.subscribe_states(lambda value: self._on_state(config.id, value))
                client.subscribe_logs(lambda value: self._on_log(config.id, value))
                backoff = 1
                self._set_status(config.id, "ready", None)
                self._publish({"type": "snapshot", "device_id": config.id, "at": utc_now()})
                await stopped.wait()
                if self._running:
                    self._set_status(config.id, "disconnected", "connection_lost")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # dependency exceptions vary between supported releases
                code = self._classify_error(exc)
                self._set_status(config.id, "auth_failed" if code == "invalid_encryption_key" else "disconnected", code)
                _LOGGER.warning("ESPHome device %s connection failed (%s)", config.id, code)
            finally:
                state.client = None
                if client is not None:
                    try:
                        await client.disconnect()
                    except Exception:  # connection is already gone
                        pass
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    @staticmethod
    def _classify_error(exc: Exception) -> str:
        name = type(exc).__name__.lower()
        if (
            "encryptionkey" in name
            or "invalidkey" in name
            or "invalidauth" in name
            or "authentication" in name
        ):
            return "invalid_encryption_key"
        if isinstance(exc, (ModuleNotFoundError, ImportError)):
            return "runtime_dependency_unavailable"
        if "requiresencryption" in name or "encryptionplaintext" in name:
            return "encryption_required"
        if "resolve" in name:
            return "host_unresolved"
        if "timeout" in name:
            return "connection_timeout"
        return "connection_failed"

    def _set_status(self, device_id: str, status: str, error: str | None) -> None:
        state = self._runtime.setdefault(device_id, RuntimeState())
        state.status = status
        state.last_error = error
        if status != "ready":
            for item in state.states.values():
                item["available"] = False
        self._publish({"type": "connection", "device_id": device_id, "status": status, "error": error, "at": utc_now()})

    def _on_state(self, device_id: str, value: Any) -> None:
        state = serialize_state(value)
        runtime = self._runtime.setdefault(device_id, RuntimeState())
        runtime.states[_state_key(state)] = state
        runtime.last_seen = state["received_at"]
        self._publish({"type": "state", "device_id": device_id, "state": state})

    def _on_log(self, device_id: str, value: Any) -> None:
        log = _safe_log(value)
        self._runtime.setdefault(device_id, RuntimeState()).logs.append(log)
        self._publish({"type": "log", "device_id": device_id, "log": log})

    def _public(self, config: DeviceConfig) -> dict:
        runtime = self._runtime.get(config.id, RuntimeState())
        return {
            **config.public(has_key=self.secrets.has(config.encryption_key_ref)),
            "status": runtime.status if self.enabled else "disabled",
            "last_seen": runtime.last_seen,
            "last_error": runtime.last_error,
            "api_version": runtime.api_version,
            "entity_count": len(runtime.entities),
        }

    def list_devices(self) -> list[dict]:
        return [self._public(config) for config in self.registry.list()]

    def get_device(self, device_id: str) -> dict:
        return self._public(self.registry.get(device_id))

    def get_info(self, device_id: str) -> dict:
        self.registry.get(device_id)
        return self._runtime.get(device_id, RuntimeState()).info

    def get_entities(self, device_id: str) -> list[dict]:
        self.registry.get(device_id)
        return self._runtime.get(device_id, RuntimeState()).entities

    def get_states(self, device_id: str) -> list[dict]:
        self.registry.get(device_id)
        return list(self._runtime.get(device_id, RuntimeState()).states.values())

    def get_logs(self, device_id: str, limit: int) -> list[dict]:
        self.registry.get(device_id)
        logs = self._runtime.get(device_id, RuntimeState()).logs
        return list(logs)[-limit:]

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def _publish(self, event: dict) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait({"type": "resync_required", "at": utc_now()})
                except asyncio.QueueFull:
                    continue
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def ensure_enabled(self) -> None:
        if not self.enabled:
            raise ApiError("capability_unavailable", "The Native API runtime is disabled.", 403)
