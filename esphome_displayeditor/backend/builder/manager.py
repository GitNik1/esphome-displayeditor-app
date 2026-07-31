"""Device Builder discovery, compatibility and allow-listed operations."""

from __future__ import annotations

import asyncio
from typing import Any

from ..errors import ApiError
from ..settings import Settings
from .adapter import BuilderAdapterError, DeviceBuilderWebSocketAdapter, sanitize_output
from .compatibility import evaluate


class BuilderManager:
    def __init__(
        self,
        settings: Settings,
        *,
        adapter: DeviceBuilderWebSocketAdapter | None = None,
    ) -> None:
        self.enabled = (
            settings.profile == "full" and settings.builder_provider == "device_builder"
        )
        self.url = settings.builder_url
        self.adapter = adapter
        self.state = "disabled" if not self.enabled else "probing"
        self.reason = "builder_disabled" if not self.enabled else "not_probed"
        self.server_version: str | None = None
        self.esphome_version: str | None = None
        self.adapter_version: str | None = None
        self._probe_lock = asyncio.Lock()
        self._probe_task: asyncio.Task | None = None
        if self.enabled and self.adapter is None:
            try:
                self.adapter = DeviceBuilderWebSocketAdapter(
                    settings.builder_url, timeout=settings.api_timeout_seconds
                )
            except BuilderAdapterError as exc:
                self.state = "unavailable"
                self.reason = exc.code

    @property
    def available(self) -> bool:
        return self.enabled and self.state == "ready" and self.adapter is not None

    async def start(self) -> None:
        if not self.enabled or self.adapter is None:
            return
        await self.probe()
        self._probe_task = asyncio.create_task(self._probe_loop(), name="builder-probe")

    async def stop(self) -> None:
        if self._probe_task is not None:
            self._probe_task.cancel()
            await asyncio.gather(self._probe_task, return_exceptions=True)
            self._probe_task = None

    async def _probe_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            await self.probe()

    async def probe(self) -> dict[str, Any]:
        if not self.enabled:
            return self.status()
        if self.adapter is None:
            self.state = "unavailable"
            return self.status()
        async with self._probe_lock:
            self.state = "probing"
            try:
                info = await self.adapter.probe()
                compatibility = evaluate(info.server_version, info.esphome_version)
                self.server_version = info.server_version
                self.esphome_version = info.esphome_version
                self.adapter_version = compatibility.adapter
                if not compatibility.compatible:
                    self.state = "incompatible"
                    self.reason = compatibility.reason
                    return self.status()
                # Harmless capability checks: no YAML or firmware is changed.
                await self.adapter.command("devices/list")
                await self.adapter.command("firmware/get_jobs")
            except BuilderAdapterError as exc:
                self.state = "unavailable"
                self.reason = exc.code
            else:
                self.state = "ready"
                self.reason = "compatible"
        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "provider": "device_builder" if self.enabled else "disabled",
            "state": self.state,
            "compatible": self.available,
            "reason": self.reason,
            "server_version": self.server_version,
            "esphome_version": self.esphome_version,
            "adapter": self.adapter_version,
        }

    async def ensure_available(self) -> None:
        if not self.available:
            await self.probe()
        if not self.available:
            raise ApiError(
                "builder_unavailable",
                "The ESPHome Device Builder is disabled, unavailable or incompatible.",
                503,
                self.status(),
            )

    async def validate(self, configuration: str) -> dict[str, Any]:
        await self.ensure_available()
        assert self.adapter is not None
        response = await self.adapter.command(
            "devices/validate",
            {"configuration": configuration, "show_secrets": False},
        )
        output = [
            sanitize_output(event.get("data", ""))
            for event in response.events
            if event.get("event") == "output"
        ][-2000:]
        terminal = next(
            (event.get("data") for event in reversed(response.events) if event.get("event") == "result"),
            {},
        )
        valid = bool(isinstance(terminal, dict) and terminal.get("success"))
        return {"valid": valid, "output": output, "result": terminal}

    async def compile(self, configuration: str) -> dict[str, Any]:
        return await self._job_command("firmware/compile", {"configuration": configuration})

    async def install(self, configuration: str, port: str) -> dict[str, Any]:
        return await self._job_command(
            "firmware/install", {"configuration": configuration, "port": port}
        )

    async def _job_command(self, command: str, args: dict[str, Any]) -> dict[str, Any]:
        await self.ensure_available()
        assert self.adapter is not None
        result = (await self.adapter.command(command, args)).result
        if not isinstance(result, dict) or not isinstance(result.get("job_id"), str):
            raise ApiError("builder_protocol_error", "The Device Builder returned an invalid job.", 502)
        return result

    async def jobs(self) -> list[dict[str, Any]]:
        await self.ensure_available()
        assert self.adapter is not None
        result = (await self.adapter.command("firmware/get_jobs")).result
        if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
            raise ApiError("builder_protocol_error", "The Device Builder returned invalid jobs.", 502)
        return result

    async def job(self, job_id: str) -> dict[str, Any]:
        await self.ensure_available()
        assert self.adapter is not None
        result = (await self.adapter.command("firmware/get_job", {"job_id": job_id})).result
        if result is None:
            raise ApiError("job_not_found", "The Device Builder job was not found.", 404)
        if not isinstance(result, dict):
            raise ApiError("builder_protocol_error", "The Device Builder returned an invalid job.", 502)
        return result

    async def cancel(self, job_id: str) -> None:
        await self.ensure_available()
        assert self.adapter is not None
        await self.adapter.command("firmware/cancel", {"job_id": job_id})

    async def follow_jobs(self, callback: Any) -> None:
        await self.ensure_available()
        assert self.adapter is not None
        await self.adapter.follow_jobs(callback)
