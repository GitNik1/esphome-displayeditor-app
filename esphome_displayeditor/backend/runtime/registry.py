"""Persistent allow-list of ESPHome devices without secret material."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass
from pathlib import Path

from ..errors import ApiError


_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_HOSTNAME = re.compile(
    r"^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$"
)


def _atomic_json_write(path: Path, value: object, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
        os.chmod(path, mode)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


@dataclass(frozen=True)
class DeviceConfig:
    id: str
    name: str
    host: str
    port: int = 6053
    encryption_key_ref: str = ""

    @classmethod
    def validated(cls, value: dict) -> "DeviceConfig":
        device_id = str(value.get("id", "")).strip().lower()
        name = str(value.get("name", "")).strip()
        host = str(value.get("host", "")).strip()
        key_ref = str(value.get("encryption_key_ref", "")).strip().lower()
        try:
            port = int(value.get("port", 6053))
        except (TypeError, ValueError):
            port = 0

        if not _SLUG.fullmatch(device_id):
            raise ApiError("invalid_device_id", "The device id is invalid.", 422)
        if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
            raise ApiError("invalid_device_name", "The device name is invalid.", 422)
        if not _SLUG.fullmatch(key_ref):
            raise ApiError("invalid_key_reference", "The encryption key reference is invalid.", 422)
        if not 1 <= port <= 65535:
            raise ApiError("invalid_device_port", "The device port is invalid.", 422)
        _validate_host(host)
        return cls(device_id, name, host, port, key_ref)

    def public(self, *, has_key: bool) -> dict:
        return {**asdict(self), "has_encryption_key": has_key}


def _validate_host(host: str) -> None:
    if not host or len(host) > 253 or any(char.isspace() for char in host):
        raise ApiError("invalid_device_host", "The device host is invalid.", 422)
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        if not _HOSTNAME.fullmatch(host):
            raise ApiError("invalid_device_host", "The device host is invalid.", 422) from None
        normalized = host.rstrip(".").lower()
        if normalized == "localhost" or (
            "." in normalized
            and not normalized.endswith((".local", ".lan", ".home.arpa"))
        ):
            raise ApiError(
                "invalid_device_host", "Only local device host names are allowed.", 422
            )
        return
    if (
        address.is_loopback
        or address.is_multicast
        or address.is_unspecified
        or not (address.is_private or address.is_link_local)
    ):
        raise ApiError("invalid_device_host", "The device host is not allowed.", 422)


class DeviceRegistry:
    """JSON-backed device allow-list. The file deliberately contains no keys."""

    def __init__(self, data_root: Path) -> None:
        self.path = data_root / "runtime" / "devices.json"
        self._lock = threading.RLock()

    def _load(self) -> dict[str, DeviceConfig]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError) as exc:
            raise ApiError("device_registry_unavailable", "The device registry cannot be read.", 500) from exc
        if not isinstance(raw, list):
            raise ApiError("device_registry_invalid", "The device registry is invalid.", 500)
        devices: dict[str, DeviceConfig] = {}
        for item in raw:
            if not isinstance(item, dict):
                raise ApiError("device_registry_invalid", "The device registry is invalid.", 500)
            device = DeviceConfig.validated(item)
            devices[device.id] = device
        return devices

    def list(self) -> list[DeviceConfig]:
        with self._lock:
            return sorted(self._load().values(), key=lambda item: (item.name.lower(), item.id))

    def get(self, device_id: str) -> DeviceConfig:
        with self._lock:
            device = self._load().get(device_id)
        if device is None:
            raise ApiError("device_not_found", "The configured device was not found.", 404)
        return device

    def upsert(self, value: dict, *, expected_id: str | None = None) -> DeviceConfig:
        device = DeviceConfig.validated(value)
        if expected_id is not None and device.id != expected_id:
            raise ApiError("device_id_mismatch", "The device id cannot be changed.", 409)
        with self._lock:
            devices = self._load()
            devices[device.id] = device
            _atomic_json_write(self.path, [asdict(item) for item in devices.values()])
        return device

    def delete(self, device_id: str) -> DeviceConfig:
        with self._lock:
            devices = self._load()
            device = devices.pop(device_id, None)
            if device is None:
                raise ApiError("device_not_found", "The configured device was not found.", 404)
            _atomic_json_write(self.path, [asdict(item) for item in devices.values()])
        return device
