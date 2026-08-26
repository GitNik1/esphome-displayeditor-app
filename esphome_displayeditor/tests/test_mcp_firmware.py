from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.assistant_tools import AssistantToolService
from backend.builder.adapter import BuilderAdapterError
from backend.builder.manager import BuilderManager
from backend.errors import ApiError
from backend.mcp.app import create_mcp_app
from backend.mcp.server import create_mcp_server
from backend.mcp.token_store import MCPTokenStore
from backend.settings import Settings

from .test_builder import FakeBuilderAdapter


def builder_settings(
    tmp_path: Path,
    *,
    access_level: str = "write_with_builder",
    mcp_access: str = "project_write",
) -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir(parents=True, exist_ok=True)
    (config_root / "display.yaml").write_text(
        "esphome:\n  name: panel\n", encoding="utf-8"
    )
    return Settings(
        access_level=access_level,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        mcp_mode="lan",
        mcp_access=mcp_access,
        mcp_access_token="test-token-" + "x" * 32,
        builder_url="http://esphome-builder:6052",
    )


def test_firmware_service_validate_build_install_lifecycle(tmp_path: Path) -> None:
    settings = builder_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    service = AssistantToolService(settings, builder=manager)

    async def run() -> None:
        with pytest.raises(ApiError) as unvalidated:
            await service.firmware.start_build("display.yaml", identity="mcp:one")
        assert unvalidated.value.error == "validation_required"

        validated = await service.firmware.validate("display.yaml", identity="mcp:one")
        assert validated["valid"] is True
        assert validated["revision"].startswith("sha256:")

        compiled = await service.firmware.start_build("display.yaml", identity="mcp:one")
        assert compiled["job"]["job_id"] == "job-1"

        # A second build for the same, still-active job is rejected.
        with pytest.raises(ApiError) as parallel:
            await service.firmware.start_build("display.yaml", identity="mcp:one")
        assert parallel.value.error == "job_already_running"

        with pytest.raises(ApiError) as unconfirmed:
            await service.firmware.start_install(
                "display.yaml", confirmed=False, identity="mcp:one"
            )
        assert unconfirmed.value.error == "upload_confirmation_required"

        adapter.jobs[0]["status"] = "completed"
        installed = await service.firmware.start_install(
            "display.yaml", confirmed=True, identity="mcp:one"
        )
        assert installed["job"]["job_id"] == "job-2"

        jobs = await service.firmware.list_jobs()
        assert jobs["count"] == 2
        job = await service.firmware.read_job("job-2")
        assert job["job_id"] == "job-2"
        cancelled = await service.firmware.cancel_job("job-2", identity="mcp:one")
        assert cancelled["cancelled"] is True

    asyncio.run(run())
    actions = [entry["action"] for entry in service.audit.recent()]
    assert "mcp.firmware.validate" in actions
    assert "mcp.firmware.compile" in actions
    assert "mcp.firmware.install" in actions
    assert "mcp.firmware.cancel" in actions


def test_firmware_service_invalidates_stale_validation_on_config_drift(
    tmp_path: Path,
) -> None:
    settings = builder_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    service = AssistantToolService(settings, builder=manager)

    async def run() -> None:
        await service.firmware.validate("display.yaml", identity="mcp:one")
        (settings.config_root / "display.yaml").write_text(
            "esphome:\n  name: changed\n", encoding="utf-8"
        )
        with pytest.raises(ApiError) as stale:
            await service.firmware.start_build("display.yaml", identity="mcp:one")
        assert stale.value.error == "validation_revision_mismatch"

    asyncio.run(run())


def test_mcp_registers_firmware_tools_only_with_builder_access_level(
    tmp_path: Path,
) -> None:
    with_builder = create_mcp_server(
        builder_settings(tmp_path, access_level="write_with_builder")
    )
    tool_names = {tool.name for tool in asyncio.run(with_builder.list_tools())}
    assert {
        "display_configuration_validate",
        "display_build",
        "display_install",
    } <= tool_names

    without_builder = create_mcp_server(
        builder_settings(tmp_path, access_level="write")
    )
    tool_names_without = {
        tool.name for tool in asyncio.run(without_builder.list_tools())
    }
    assert "display_configuration_validate" not in tool_names_without
    assert "display_build" not in tool_names_without
    assert "display_install" not in tool_names_without


def test_mcp_firmware_tools_translate_builder_adapter_errors(tmp_path: Path) -> None:
    class FailingAdapter(FakeBuilderAdapter):
        async def command(self, command, args=None, **kwargs):  # type: ignore[override]
            if command == "devices/validate":
                raise BuilderAdapterError("builder_timeout", "The builder timed out.")
            return await super().command(command, args, **kwargs)

    settings = builder_settings(tmp_path)
    manager = BuilderManager(settings, adapter=FailingAdapter())  # type: ignore[arg-type]
    server = create_mcp_server(settings, builder=manager)

    result = asyncio.run(
        server.call_tool(
            "display_configuration_validate", {"name": "display.yaml"}
        )
    ).structured_content

    assert result["ok"] is False
    assert result["error"] == "builder_timeout"


def test_mcp_http_firmware_lifecycle_end_to_end(tmp_path: Path) -> None:
    settings = builder_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    headers = {
        "Authorization": f"Bearer {settings.mcp_access_token}",
        "Host": "localhost:8100",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-28",
            "capabilities": {},
            "clientInfo": {"name": "firmware-test", "version": "1.0"},
        },
    }

    def call(request_id: int, tool_name: str, arguments: dict):
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
                "name": tool_name,
                "arguments": arguments,
            },
        }

    with TestClient(create_mcp_app(settings, builder=manager)) as client:
        initialized = client.post("/mcp", headers=headers, json=initialize)
        session_headers = {
            **headers,
            "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
            "Mcp-Protocol-Version": "2026-07-28",
        }

        def post(request_id: int, tool_name: str, arguments: dict):
            return client.post(
                "/mcp",
                headers={
                    **session_headers,
                    "Mcp-Method": "tools/call",
                    "Mcp-Name": tool_name,
                },
                json=call(request_id, tool_name, arguments),
            )

        validated = post(
            2, "display_configuration_validate", {"name": "display.yaml"}
        ).json()["result"]["structuredContent"]
        assert validated["ok"] is True

        built = post(3, "display_build", {"action": "start", "name": "display.yaml"}).json()[
            "result"
        ]["structuredContent"]
        assert built["ok"] is True
        job_id = built["job"]["job_id"]

        status = post(4, "display_build", {"action": "status", "job_id": job_id}).json()[
            "result"
        ]["structuredContent"]
        assert status["ok"] is True
        assert status["job"]["job_id"] == job_id

        adapter.jobs[0]["status"] = "completed"
        unconfirmed = post(
            5, "display_install", {"name": "display.yaml", "confirmed": False}
        ).json()["result"]["structuredContent"]
        assert unconfirmed["ok"] is False
        assert unconfirmed["error"] == "upload_confirmation_required"

        installed = post(
            6, "display_install", {"name": "display.yaml", "confirmed": True}
        ).json()["result"]["structuredContent"]
        assert installed["ok"] is True


def test_mcp_http_firmware_scopes_are_enforced_independently(tmp_path: Path) -> None:
    settings = builder_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    store = MCPTokenStore(settings.data_root)
    created = store.create(
        "Build-only client",
        ["server:read", "project:write", "configuration:draft", "firmware:compile"],
        3600,
    )
    headers = {
        "Authorization": f"Bearer {created['token']}",
        "Host": "localhost:8100",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-28",
            "capabilities": {},
            "clientInfo": {"name": "firmware-scope-test", "version": "1.0"},
        },
    }

    with TestClient(create_mcp_app(settings, builder=manager)) as client:
        initialized = client.post("/mcp", headers=headers, json=initialize)
        session_headers = {
            **headers,
            "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "display_install",
        }
        denied = client.post(
            "/mcp",
            headers=session_headers,
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                    "name": "display_install",
                    "arguments": {"name": "display.yaml", "confirmed": True},
                },
            },
        )

    assert denied.status_code == 200
    body = denied.json()["result"]["structuredContent"]
    assert body["ok"] is False
    assert body["error"] == "forbidden_scope"


def test_firmware_service_never_validates_or_builds_secrets_yaml(
    tmp_path: Path,
) -> None:
    """Even with a Device Builder attached, firmware validate/compile/install
    must reject secrets.yaml/secrets.yml regardless of protect_sensitive_paths."""
    import dataclasses

    settings = dataclasses.replace(
        builder_settings(tmp_path), protect_sensitive_paths=False
    )
    (settings.config_root / "secrets.yaml").write_text(
        "wifi_password: hunter2\n", encoding="utf-8"
    )
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    service = AssistantToolService(settings, builder=manager)

    async def run() -> None:
        with pytest.raises(ApiError) as validate_error:
            await service.firmware.validate("secrets.yaml", identity="mcp:one")
        assert validate_error.value.error == "secrets_file_protected"

        with pytest.raises(ApiError) as build_error:
            await service.firmware.start_build("secrets.yaml", identity="mcp:one")
        assert build_error.value.error == "secrets_file_protected"

        with pytest.raises(ApiError) as install_error:
            await service.firmware.start_install(
                "secrets.yaml", confirmed=True, identity="mcp:one"
            )
        assert install_error.value.error == "secrets_file_protected"

    asyncio.run(run())
    # The adapter never even saw a command for these calls: the guard fires
    # before any Device Builder interaction.
    assert not any(
        args.get("configuration") == "secrets.yaml" for _cmd, args in adapter.commands
    )
