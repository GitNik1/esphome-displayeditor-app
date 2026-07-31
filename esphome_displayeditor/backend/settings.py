"""Runtime settings loaded from Home Assistant's options file."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    profile: str
    read_only: bool
    max_file_size: int
    protect_sensitive_paths: bool
    config_root: Path
    data_root: Path

    @classmethod
    def load(cls) -> "Settings":
        options_path = Path(os.getenv("ESPHOME_OPTIONS_PATH", "/data/options.json"))
        options: dict = {}
        try:
            options = json.loads(options_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            pass

        profile = str(options.get("profile", "native_filesystem"))
        read_only = bool(options.get("read_only", False)) or profile == "read_only"
        max_kib = min(max(int(options.get("max_file_size_kib", 1024)), 64), 4096)
        return cls(
            profile=profile,
            read_only=read_only,
            max_file_size=max_kib * 1024,
            protect_sensitive_paths=bool(options.get("protect_sensitive_paths", True)),
            config_root=Path(os.getenv("ESPHOME_CONFIG_ROOT", "/homeassistant/esphome")),
            data_root=Path(os.getenv("ESPHOME_DATA_ROOT", "/data")),
        )


def capabilities(settings: Settings) -> dict[str, bool]:
    writable = not settings.read_only
    return {
        "configuration.list": True,
        "configuration.read": True,
        "configuration.write_draft": writable,
        "configuration.publish": writable,
        "configuration.validate_yaml": True,
        "configuration.validate_esphome": False,
        "designer.project": True,
        "designer.export_yaml": True,
        # Import only reads a configuration and returns a project; it never
        # writes anything, so it stays available in the read-only profile.
        "designer.import_yaml": True,
        "designer.project_write": writable,
        "firmware.compile": False,
        "firmware.upload": False,
        "device.info": False,
        "device.entities": False,
        "device.states": False,
        "device.logs": False,
        "device.control": False,
    }
