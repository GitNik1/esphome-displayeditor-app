#!/usr/bin/env python3
"""Build the reproducible Claude Desktop MCPB package."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "clients" / "claude-desktop"
MANIFEST = SOURCE / "manifest.json"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class PackageError(RuntimeError):
    """Raised when the MCPB source cannot be packaged safely."""


def load_manifest() -> dict[str, object]:
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageError(f"Cannot read {MANIFEST.relative_to(ROOT)}.") from exc

    required = {"name", "version", "description", "author", "server"}
    missing = sorted(required - manifest.keys())
    if missing:
        raise PackageError(f"Manifest fields are missing: {', '.join(missing)}")
    if manifest.get("manifest_version") != "0.4":
        raise PackageError("The Claude Desktop package requires manifest version 0.4.")
    version = manifest.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise PackageError("The package version must be semantic MAJOR.MINOR.PATCH.")

    user_config = manifest.get("user_config")
    if not isinstance(user_config, dict):
        raise PackageError("The manifest requires user_config.")
    token_config = user_config.get("mcp_token")
    if not isinstance(token_config, dict) or token_config.get("sensitive") is not True:
        raise PackageError("mcp_token must be marked as sensitive.")
    if "default" in token_config:
        raise PackageError("mcp_token must never contain a default value.")

    server = manifest.get("server")
    if not isinstance(server, dict) or server.get("type") != "node":
        raise PackageError("The package requires a Node server entry point.")
    entry_point = server.get("entry_point")
    if entry_point != "server/index.cjs":
        raise PackageError("Unexpected MCPB server entry point.")
    return manifest


def package_sources() -> tuple[tuple[Path, str], ...]:
    return (
        (MANIFEST, "manifest.json"),
        (SOURCE / "server" / "index.cjs", "server/index.cjs"),
        (SOURCE / "README.md", "README.md"),
        (SOURCE / "PRIVACY.md", "PRIVACY.md"),
        (ROOT.parent / "LICENSE", "LICENSE"),
    )


def build_package(output: Path | None = None) -> Path:
    manifest = load_manifest()
    version = str(manifest["version"])
    destination = output or (
        ROOT / "dist" / f"esphome-display-editor-{version}.mcpb"
    )
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    sources = sorted(package_sources(), key=lambda item: item[1])
    for source, archive_name in sources:
        if not source.is_file():
            raise PackageError(f"Package source is missing: {archive_name}")
        if Path(archive_name).is_absolute() or ".." in Path(archive_name).parts:
            raise PackageError(f"Unsafe package path: {archive_name}")

    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for source, archive_name in sources:
            info = ZipInfo(archive_name, date_time=FIXED_TIMESTAMP)
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compresslevel=9)
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_name(f"{destination.name}.sha256").write_text(
        f"{checksum}  {destination.name}\n",
        encoding="ascii",
        newline="\n",
    )
    return destination


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(
        description="Build the reproducible ESPHome Display Editor MCPB package."
    )
    argument_parser.add_argument(
        "--output",
        type=Path,
        help="Optional destination .mcpb file (defaults to dist/).",
    )
    return argument_parser


def main() -> int:
    args = parser().parse_args()
    try:
        destination = build_package(args.output)
    except PackageError as exc:
        print(f"Error: {exc}")
        return 2
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
