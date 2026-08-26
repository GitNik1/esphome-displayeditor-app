from __future__ import annotations

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

from backend.version import APP_VERSION
from scripts.build_mcpb import FIXED_TIMESTAMP, build_package, load_manifest


EXPECTED_FILES = {
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "manifest.json",
    "server/index.cjs",
}


def test_mcpb_manifest_uses_sensitive_runtime_configuration() -> None:
    manifest = load_manifest()

    assert manifest["manifest_version"] == "0.4"
    assert manifest["version"] == APP_VERSION
    assert manifest["tools_generated"] is True
    assert manifest["prompts_generated"] is True
    assert manifest["server"]["type"] == "node"
    assert manifest["server"]["mcp_config"]["env"] == {
        "ESPHOME_EDITOR_MCP_URL": "${user_config.mcp_url}",
        "ESPHOME_EDITOR_MCP_TOKEN": "${user_config.mcp_token}",
    }
    token_config = manifest["user_config"]["mcp_token"]
    assert token_config["sensitive"] is True
    assert token_config["required"] is True
    assert "default" not in token_config


def test_mcpb_build_is_bounded_and_reproducible(tmp_path: Path) -> None:
    first = build_package(tmp_path / "first.mcpb")
    second = build_package(tmp_path / "second.mcpb")

    assert hashlib.sha256(first.read_bytes()).digest() == hashlib.sha256(
        second.read_bytes()
    ).digest()
    assert first.stat().st_size < 256 * 1024
    checksum = first.with_name(f"{first.name}.sha256").read_text(encoding="ascii")
    assert checksum == f"{hashlib.sha256(first.read_bytes()).hexdigest()}  first.mcpb\n"

    with ZipFile(first) as archive:
        assert set(archive.namelist()) == EXPECTED_FILES
        assert all(info.date_time == FIXED_TIMESTAMP for info in archive.infolist())
        packaged_manifest = json.loads(archive.read("manifest.json"))
        bridge = archive.read("server/index.cjs")

    assert packaged_manifest["version"] == APP_VERSION
    assert b"mcp_test_" not in bridge
    assert b"ESPHOME_EDITOR_MCP_TOKEN" in bridge
