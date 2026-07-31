"""Small compatibility boundary around aioesphomeapi."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from .registry import DeviceConfig


class AioEsphomeClient:
    def __init__(self, config: DeviceConfig, encryption_key: str) -> None:
        import aioesphomeapi

        self._module = aioesphomeapi
        self._client = aioesphomeapi.APIClient(
            config.host,
            config.port,
            noise_psk=encryption_key,
            client_info="ESPHome Display Editor",
        )

    async def connect(self, on_stop: Callable[[bool], Awaitable[None]]) -> None:
        # Suppress dependency logging here: connection errors are classified by
        # DeviceManager without ever including the PSK or peer-provided text.
        await self._client.connect(on_stop=on_stop, login=True, log_errors=False)

    async def snapshot(self) -> tuple[Any, list[Any], list[Any]]:
        return await self._client.device_info_and_list_entities()

    def subscribe_states(self, callback: Callable[[Any], None]) -> None:
        self._client.subscribe_states(callback)

    def subscribe_logs(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        return self._client.subscribe_logs(
            callback,
            log_level=self._module.LogLevel.LOG_LEVEL_INFO,
            dump_config=False,
        )

    @property
    def api_version(self) -> str | None:
        value = self._client.api_version
        return str(value) if value is not None else None

    async def disconnect(self) -> None:
        await self._client.disconnect()
