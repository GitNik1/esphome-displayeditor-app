"""Runtime settings loaded from Home Assistant's options file."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


ROLES = ("viewer", "editor", "publisher", "installer", "administrator")
_ROLE_LEVEL = {role: level for level, role in enumerate(ROLES)}

CAPABILITY_MINIMUM_ROLE = {
    "configuration.list": "viewer",
    "configuration.read": "viewer",
    "configuration.write_draft": "editor",
    "configuration.publish": "publisher",
    "configuration.validate_yaml": "viewer",
    "configuration.validate_esphome": "publisher",
    "designer.project": "viewer",
    "designer.export_yaml": "viewer",
    "designer.import_yaml": "viewer",
    "designer.project_write": "editor",
    "designer.asset_write": "editor",
    "firmware.compile": "installer",
    "firmware.upload": "installer",
    "builder.manage": "administrator",
    "device.info": "viewer",
    "device.entities": "viewer",
    "device.states": "viewer",
    "device.logs": "viewer",
    "device.manage": "administrator",
    "device.control": "administrator",
    "audit.read": "administrator",
}


def _bounded_int(options: dict, key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(options.get(key, default))
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


@dataclass(frozen=True)
class Settings:
    profile: str
    read_only: bool
    max_file_size: int
    protect_sensitive_paths: bool
    config_root: Path
    data_root: Path
    default_role: str = "viewer"
    user_roles: tuple[tuple[str, str], ...] = ()
    api_rate_limit_per_minute: int = 240
    write_rate_limit_per_minute: int = 60
    runtime_provider: str = "native"
    request_max_size: int = 12 * 1024 * 1024
    api_timeout_seconds: int = 300
    builder_provider: str = "disabled"
    builder_url: str = "http://5c53de3b-esphome:6052"

    @classmethod
    def load(cls) -> "Settings":
        options_path = Path(os.getenv("ESPHOME_OPTIONS_PATH", "/data/options.json"))
        options: dict = {}
        try:
            options = json.loads(options_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            pass

        profile = str(options.get("profile", "native_filesystem"))
        if profile not in {"native_filesystem", "native_only", "read_only", "full"}:
            profile = "read_only"
        read_only = bool(options.get("read_only", False)) or profile == "read_only"
        max_kib = _bounded_int(options, "max_file_size_kib", 1024, 64, 4096)
        default_role = str(options.get("default_role", "viewer")).lower()
        if default_role not in ROLES:
            default_role = "viewer"
        assignments: dict[str, str] = {}
        raw_assignments = options.get("user_roles", [])
        if isinstance(raw_assignments, list):
            for entry in raw_assignments:
                if not isinstance(entry, dict):
                    continue
                user_id = str(entry.get("user_id", "")).strip()
                role = str(entry.get("role", "")).lower()
                if user_id and role in ROLES:
                    assignments[user_id] = role
        runtime_provider = str(options.get("runtime_provider", "native")).lower()
        if runtime_provider not in {"native", "disabled"}:
            runtime_provider = "disabled"
        builder_provider = str(options.get("builder_provider", "disabled")).lower()
        if builder_provider not in {"device_builder", "disabled"}:
            builder_provider = "disabled"
        builder_url = str(
            options.get("builder_url", "http://5c53de3b-esphome:6052")
        ).strip()
        return cls(
            profile=profile,
            read_only=read_only,
            max_file_size=max_kib * 1024,
            protect_sensitive_paths=bool(options.get("protect_sensitive_paths", True)),
            config_root=Path(os.getenv("ESPHOME_CONFIG_ROOT", "/homeassistant/esphome")),
            data_root=Path(os.getenv("ESPHOME_DATA_ROOT", "/data")),
            default_role=default_role,
            user_roles=tuple(assignments.items()),
            api_rate_limit_per_minute=_bounded_int(
                options, "api_rate_limit_per_minute", 240, 30, 2000
            ),
            write_rate_limit_per_minute=_bounded_int(
                options, "write_rate_limit_per_minute", 60, 5, 500
            ),
            runtime_provider=runtime_provider,
            request_max_size=_bounded_int(
                options, "request_max_size_kib", 12288, 256, 16384
            )
            * 1024,
            api_timeout_seconds=_bounded_int(
                options, "api_timeout_seconds", 300, 10, 900
            ),
            builder_provider=builder_provider,
            builder_url=builder_url,
        )

    def role_for(self, user_id: str | None) -> str:
        if user_id:
            for assigned_user, role in self.user_roles:
                if assigned_user == user_id:
                    return role
        return self.default_role


def role_allows(role: str, required_role: str) -> bool:
    return _ROLE_LEVEL.get(role, -1) >= _ROLE_LEVEL[required_role]


def capabilities(
    settings: Settings,
    role: str | None = None,
    *,
    builder_available: bool = False,
) -> dict[str, bool]:
    writable = not settings.read_only
    native_runtime = settings.runtime_provider == "native"
    filesystem = settings.profile != "native_only"
    builder = settings.profile == "full" and builder_available and writable
    available = {
        "configuration.list": filesystem,
        "configuration.read": filesystem,
        "configuration.write_draft": filesystem and writable,
        "configuration.publish": filesystem and writable,
        "configuration.validate_yaml": filesystem,
        "configuration.validate_esphome": builder,
        "designer.project": True,
        "designer.export_yaml": True,
        # Import only reads a configuration and returns a project; it never
        # writes anything, so it stays available in the read-only profile.
        "designer.import_yaml": True,
        "designer.project_write": writable,
        # Writes a baked animation frame straight into the ESPHome config's
        # images/ folder - needs real filesystem access, same as any other
        # write, and is unavailable in the native_only profile exactly like
        # configuration writes are.
        "designer.asset_write": filesystem and writable,
        "firmware.compile": builder,
        "firmware.upload": builder,
        "builder.manage": settings.profile == "full"
        and settings.builder_provider == "device_builder"
        and writable,
        "device.info": native_runtime,
        "device.entities": native_runtime,
        "device.states": native_runtime,
        "device.logs": native_runtime,
        "device.manage": native_runtime and writable,
        "device.control": False,
        "audit.read": True,
    }
    effective_role = role or settings.default_role
    return {
        capability: enabled
        and role_allows(effective_role, CAPABILITY_MINIMUM_ROLE[capability])
        for capability, enabled in available.items()
    }
