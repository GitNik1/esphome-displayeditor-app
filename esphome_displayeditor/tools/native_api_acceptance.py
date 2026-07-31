"""Live encrypted Native API acceptance check.

The encryption key is read only from ``ESPHOME_ACCEPTANCE_KEY`` so it never
appears in the process command line. The tool prints counts and metadata, not
state values or log contents.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from backend.runtime.native_client import AioEsphomeClient  # noqa: E402
from backend.runtime.registry import DeviceConfig  # noqa: E402


async def run() -> dict:
    host = os.environ.get("ESPHOME_ACCEPTANCE_HOST", "").strip()
    key = os.environ.get("ESPHOME_ACCEPTANCE_KEY", "").strip()
    port = int(os.environ.get("ESPHOME_ACCEPTANCE_PORT", "6053"))
    if not host or not key:
        raise RuntimeError(
            "Set ESPHOME_ACCEPTANCE_HOST and ESPHOME_ACCEPTANCE_KEY before running the check."
        )
    config = DeviceConfig.validated(
        {
            "id": "acceptance-device",
            "name": "Acceptance device",
            "host": host,
            "port": port,
            "encryption_key_ref": "acceptance-key",
        }
    )
    client = AioEsphomeClient(config, key)
    disconnected = asyncio.Event()
    state_seen = asyncio.Event()
    log_seen = asyncio.Event()
    state_count = 0
    log_count = 0

    async def on_stop(_expected: bool) -> None:
        disconnected.set()

    def on_state(_value: object) -> None:
        nonlocal state_count
        state_count += 1
        state_seen.set()

    def on_log(_value: object) -> None:
        nonlocal log_count
        log_count += 1
        log_seen.set()

    try:
        async with asyncio.timeout(20):
            await client.connect(on_stop)
            info, entities, services = await client.snapshot()
        client.subscribe_states(on_state)
        unsubscribe_logs = client.subscribe_logs(on_log)
        try:
            # State/log traffic is device-dependent, so absence is reported
            # rather than treated as a failed encrypted handshake.
            try:
                async with asyncio.timeout(10):
                    await asyncio.gather(state_seen.wait(), log_seen.wait())
            except TimeoutError:
                pass
        finally:
            unsubscribe_logs()
        return {
            "encrypted_connection": True,
            "api_version": client.api_version,
            "device_name": str(getattr(info, "name", ""))[:80],
            "esphome_version": str(getattr(info, "esphome_version", ""))[:40],
            "entities": len(entities),
            "services": len(services),
            "states_observed": state_count,
            "logs_observed": log_count,
            "unexpected_disconnect": disconnected.is_set(),
        }
    finally:
        await client.disconnect()


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(run()), indent=2, ensure_ascii=False))
    except Exception as exc:
        print(
            json.dumps(
                {"encrypted_connection": False, "error": type(exc).__name__},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
