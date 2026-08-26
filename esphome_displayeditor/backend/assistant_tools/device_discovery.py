"""Secret-free projections of the configured ESPHome device allow-list."""

from __future__ import annotations

from typing import Any

from ..runtime.registry import DeviceConfig, DeviceRegistry


class DeviceDiscoveryService:
    """Read registered device endpoints without returning secret references."""

    def __init__(self, registry: DeviceRegistry, *, runtime_available: bool) -> None:
        self.registry = registry
        self.runtime_available = runtime_available

    def list(self) -> list[dict[str, Any]]:
        return [self._public(item) for item in self.registry.list()]

    def read(self, device_id: str) -> dict[str, Any]:
        return self._public(self.registry.get(device_id))

    def _public(self, device: DeviceConfig) -> dict[str, Any]:
        return {
            "id": device.id,
            "name": device.name,
            "host": device.host,
            "port": device.port,
            "encrypted": bool(device.encryption_key_ref),
            "runtime_available": self.runtime_available,
            "live_data_available": False,
        }
