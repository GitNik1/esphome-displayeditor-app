"""Fail-closed ESPHome Device Builder compatibility policy."""

from __future__ import annotations

import re
from dataclasses import dataclass


_VERSION = re.compile(r"^(\d{4})\.(\d{1,2})\.(\d+)(?:[.-].*)?$")
_MIN_ESPHOME = (2026, 6, 0)
_MAX_ESPHOME_EXCLUSIVE = (2026, 9, 0)


@dataclass(frozen=True)
class CompatibilityResult:
    compatible: bool
    adapter: str | None
    reason: str


def evaluate(server_version: str, esphome_version: str) -> CompatibilityResult:
    """Accept only the explicitly tested ESPHome 2026.6-2026.8 window."""
    if not server_version.strip():
        return CompatibilityResult(False, None, "missing_server_version")
    match = _VERSION.fullmatch(esphome_version.strip())
    if not match:
        return CompatibilityResult(False, None, "unknown_esphome_version")
    parsed = tuple(int(part) for part in match.groups())
    if not (_MIN_ESPHOME <= parsed < _MAX_ESPHOME_EXCLUSIVE):
        return CompatibilityResult(False, None, "unsupported_esphome_version")
    return CompatibilityResult(True, "device_builder_ws_v1", "compatible")
