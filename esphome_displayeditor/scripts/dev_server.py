#!/usr/bin/env python3
"""Run the real backend locally for UI work, outside Home Assistant.

The static preview (`python -m http.server`) shows the editor shell only:
every API call fails, so nothing can be imported, saved or published. This
starts the actual application instead, with the two development switches the
app factory honours (direct access without Ingress, anonymous administrator)
and a scratch configuration/data root seeded with the test configurations
from ``tests/data``.

The scratch root defaults to a short path below the system temp folder on
purpose: lock files below the data root carry 64-character hashed names, and
a long base path pushes them past Windows' 260-character MAX_PATH, which then
surfaces as a misleading "lock could not be opened safely" error.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "data"
DEFAULT_SCRATCH = Path(tempfile.gettempdir()) / "esphome-displayeditor-dev"
OPTIONS = {
    "access_level": "write",
    "default_role": "administrator",
    "runtime_provider": "disabled",
}


def prepare(scratch: Path, *, reset: bool) -> tuple[Path, Path, Path]:
    if reset and scratch.exists():
        shutil.rmtree(scratch)
    config_root = scratch / "esphome"
    data_root = scratch / "data"
    config_root.mkdir(parents=True, exist_ok=True)
    data_root.mkdir(parents=True, exist_ok=True)
    # Seed only missing files: edits made through the UI survive a restart.
    for fixture in sorted(FIXTURES.glob("*.yaml")):
        target = config_root / fixture.name
        if not target.exists():
            shutil.copyfile(fixture, target)
    options_path = scratch / "options.json"
    if not options_path.exists():
        options_path.write_text(json.dumps(OPTIONS, indent=2), encoding="utf-8")
    return config_root, data_root, options_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--scratch", type=Path, default=DEFAULT_SCRATCH,
                        help=f"configuration/data root (default: {DEFAULT_SCRATCH})")
    parser.add_argument("--reset", action="store_true",
                        help="delete the scratch root first and reseed it")
    args = parser.parse_args()

    config_root, data_root, options_path = prepare(args.scratch, reset=args.reset)
    os.environ.update({
        "ESPHOME_ALLOW_DIRECT_ACCESS": "1",
        "ESPHOME_ALLOW_ANONYMOUS_WRITE": "1",
        "ESPHOME_CONFIG_ROOT": str(config_root),
        "ESPHOME_DATA_ROOT": str(data_root),
        "ESPHOME_OPTIONS_PATH": str(options_path),
    })
    print(f"[dev] configurations: {config_root}")
    print(f"[dev] data:           {data_root}")

    import uvicorn

    sys.path.insert(0, str(ROOT))
    uvicorn.run("backend.app:create_app", factory=True, host=args.host,
                port=args.port, app_dir=str(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
