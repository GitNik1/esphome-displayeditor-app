from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from backend.assistant_tools import AssistantToolService
from backend.errors import ApiError
from backend.mcp.app import create_mcp_app
from backend.mcp.auth import BearerTokenMiddleware
from backend.mcp.configuration import (
    normalise_allowed_hosts,
    normalise_allowed_origins,
    validate_mcp_settings,
)
from backend.mcp.identity import (
    MCPAuthorization,
    authorization_for_token,
    bind_authorization,
    current_authorization,
)
from backend.mcp.server import create_mcp_server
from backend.settings import Settings

from .test_designer import project_with_button


def mcp_settings(tmp_path: Path, **overrides) -> Settings:
    defaults = {
        "access_level": "write",
        "max_file_size": 1024 * 1024,
        "protect_sensitive_paths": True,
        "config_root": tmp_path / "esphome",
        "data_root": tmp_path / "data",
        "mcp_mode": "lan",
        "mcp_access_token": "test-token-" + "x" * 32,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_mcp_configuration_is_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least 32"):
        validate_mcp_settings(mcp_settings(tmp_path, mcp_access_token="short"))
    with pytest.raises(ValueError, match="at least one host"):
        validate_mcp_settings(mcp_settings(tmp_path, mcp_allowed_hosts=()))
    with pytest.raises(RuntimeError, match="disabled"):
        create_mcp_app(mcp_settings(tmp_path, mcp_mode="disabled"))
    with pytest.raises(ValueError, match="writable"):
        validate_mcp_settings(
            mcp_settings(
                tmp_path,
                access_level="read",
                mcp_access="project_write",
            )
        )


def test_mcp_transport_allowlists_are_normalised() -> None:
    assert normalise_allowed_hosts(("localhost", "display.local:8100", "[::1]")) == [
        "localhost:*",
        "display.local:8100",
        "[::1]:*",
    ]
    assert normalise_allowed_origins(("https://display.local",)) == [
        "https://display.local:*"
    ]
    with pytest.raises(ValueError, match="allowed host"):
        normalise_allowed_hosts(("https://display.local",))
    with pytest.raises(ValueError, match="allowed origin"):
        normalise_allowed_origins(("file://display.local",))


def test_mcp_token_identity_is_stable_secret_free_and_access_scoped() -> None:
    token = "secret-token-" + "x" * 32
    read_only = authorization_for_token(token, "read_only")
    same_token = authorization_for_token(token, "read_only")
    writable = authorization_for_token(token, "project_write")

    assert read_only.identity == same_token.identity == writable.identity
    assert read_only.identity.startswith("mcp:lan:")
    assert token not in read_only.identity
    assert token not in str(read_only.summary())
    assert "project:read" in read_only.scopes
    assert "project:write" not in read_only.scopes
    assert {
        "project:write",
        "configuration:draft",
        "configuration:publish",
        "changeset:read",
        "changeset:apply",
    } <= writable.scopes


def test_mcp_tools_enforce_request_scopes_server_side(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
    fallback = authorization_for_token(settings.mcp_access_token, "project_write")
    narrowed = MCPAuthorization(
        identity="mcp:lan:narrowed-client",
        token_id="narrowed-client",
        scopes=frozenset({"server:read"}),
    )
    server = create_mcp_server(settings, default_authorization=fallback)

    with bind_authorization(narrowed):
        server_info = asyncio.run(server.call_tool("display_server_info", {}))
        projects = asyncio.run(server.call_tool("display_projects", {}))
        proposal = asyncio.run(
            server.call_tool(
                "display_project_propose",
                {
                    "name": "display.lvgldesign",
                    "base_revision": "unreachable",
                    "operations": [],
                },
            )
        )

    assert server_info.structured_content["ok"] is True
    assert server_info.structured_content["authorization"]["identity"] == (
        "mcp:lan:narrowed-client"
    )
    assert projects.structured_content["ok"] is False
    assert projects.structured_content["error"] == "forbidden_scope"
    assert projects.structured_content["details"]["missing_scopes"] == [
        "project:read"
    ]
    assert proposal.structured_content["ok"] is False
    assert proposal.structured_content["error"] == "forbidden_scope"
    assert proposal.structured_content["details"]["missing_scopes"] == [
        "project:write"
    ]


def test_concurrency_limiter_rejects_a_second_in_flight_call_per_identity() -> None:
    from backend.assistant_tools.concurrency import ConcurrencyLimiter

    limiter = ConcurrencyLimiter(read_limit=1, write_limit=1)

    with limiter.slot("mcp:one", write=False):
        with pytest.raises(ApiError) as exc:
            with limiter.slot("mcp:one", write=False):
                pass
        assert exc.value.error == "too_many_concurrent_mcp_requests"
        # A different identity's own budget is unaffected.
        with limiter.slot("mcp:two", write=False):
            pass

    # The slot is released once the outer call finishes.
    with limiter.slot("mcp:one", write=False):
        pass


def test_scoped_tool_result_enforces_a_timeout(monkeypatch) -> None:
    import time

    import backend.mcp.support as support_module

    monkeypatch.setattr(support_module, "MCP_TOOL_TIMEOUT_SECONDS", 0.05)
    fallback = authorization_for_token("timeout-token-" + "x" * 32, "read_only")

    def slow_operation(_authorization: MCPAuthorization) -> dict:
        time.sleep(0.3)
        return {}

    result = support_module.scoped_tool_result(("server:read",), fallback, slow_operation)

    assert result["ok"] is False
    assert result["error"] == "tool_timeout"


def test_scoped_tool_result_warns_past_the_soft_output_target(monkeypatch) -> None:
    import backend.mcp.support as support_module

    monkeypatch.setattr(support_module, "MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS", 100)
    fallback = authorization_for_token("soft-target-token-" + "x" * 32, "read_only")

    def large_operation(_authorization: MCPAuthorization) -> dict:
        return {"payload": "x" * 200}

    result = support_module.scoped_tool_result(("server:read",), fallback, large_operation)

    assert result["ok"] is True
    assert "output_size_warning" in result


def test_mcp_http_rejects_oversized_tool_arguments(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
    headers = {
        "Authorization": f"Bearer {settings.mcp_access_token}",
        "Host": "localhost:8100",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    oversized_payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
            },
            "name": "display_project_propose",
            "arguments": {
                "name": "display.lvgldesign",
                "base_revision": "sha256:" + "0" * 64,
                "operations": [{"op": "update_widget", "padding": "x" * (300 * 1024)}],
            },
        },
    }

    with TestClient(create_mcp_app(settings)) as client:
        response = client.post(
            "/mcp",
            headers={
                **headers,
                "Mcp-Method": "tools/call",
                "Mcp-Name": "display_project_propose",
            },
            json=oversized_payload,
        )

    assert response.status_code == 413
    assert response.json()["error"] == "tool_arguments_too_large"


def test_mcp_http_allows_large_arguments_only_for_the_yaml_import_tool(
    tmp_path: Path,
) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
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
            "clientInfo": {"name": "large-argument-test", "version": "1.0"},
        },
    }

    def call(tool_name: str, yaml_size: int):
        payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
                "name": tool_name,
                "arguments": {
                    "yaml_content": "x" * yaml_size,
                    "project_name": "uploaded.lvgldesign",
                },
            },
        }
        with TestClient(create_mcp_app(settings)) as client:
            initialized = client.post("/mcp", headers=headers, json=initialize)
            session_headers = {
                **headers,
                "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
                "Mcp-Protocol-Version": "2026-07-28",
                "Mcp-Method": "tools/call",
                "Mcp-Name": tool_name,
            }
            return client.post("/mcp", headers=session_headers, json=payload)

    # 300 KiB clears the general 256 KiB cap but is allowed for this one
    # large-argument tool: the request reaches the tool handler instead of
    # being rejected at the transport layer. Whether "x" * 300KiB is valid
    # LVGL YAML is irrelevant here; only the size gate is under test.
    within_large_cap = call("display_project_import_yaml_propose", 300 * 1024)
    assert within_large_cap.status_code == 200
    assert "structuredContent" in within_large_cap.json()["result"]

    # Still bounded: even the large-argument tool is rejected past its own
    # cap. This stays under the outer 1 MiB whole-request transport limit
    # (MCP_REQUEST_MAX_BYTES) so it exercises our own 413, not the SDK's own
    # unrelated request-body-size rejection.
    over_large_cap = call("display_project_import_yaml_propose", 950 * 1024)
    assert over_large_cap.status_code == 413
    assert over_large_cap.json()["error"] == "tool_arguments_too_large"

    # A tool not on the allowlist stays capped at the general 256 KiB limit.
    not_allowlisted = call("display_project_propose", 300 * 1024)
    assert not_allowlisted.status_code == 413
    assert not_allowlisted.json()["error"] == "tool_arguments_too_large"


def test_mcp_auth_middleware_binds_request_identity() -> None:
    token = "request-token-" + "x" * 32
    authorization = authorization_for_token(token, "read_only")

    async def identity(_request: Request) -> JSONResponse:
        return JSONResponse(current_authorization().summary())

    app = Starlette(routes=[Route("/mcp", identity)])
    app.add_middleware(
        BearerTokenMiddleware,
        token=token,
        authorization=authorization,
        requests_per_minute=60,
    )

    with TestClient(app) as client:
        response = client.get(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json() == authorization.summary()
    assert token not in response.text


def test_mcp_auth_rate_limits_invalid_tokens_before_store_lookup() -> None:
    calls = 0

    def authenticate(_token: str) -> None:
        nonlocal calls
        calls += 1
        return None

    async def endpoint(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/mcp", endpoint)])
    app.add_middleware(
        BearerTokenMiddleware,
        authenticate=authenticate,
        requests_per_minute=60,
        preauth_requests_per_minute=1,
    )

    with TestClient(app) as client:
        first = client.get("/mcp", headers={"Authorization": "Bearer invalid-one"})
        second = client.get("/mcp", headers={"Authorization": "Bearer invalid-two"})

    assert first.status_code == 401
    assert second.status_code == 429
    assert calls == 1


def test_mcp_auth_uses_smaller_write_bucket_for_mutating_tools() -> None:
    token = "request-token-" + "x" * 32
    authorization = authorization_for_token(token, "project_write")

    async def endpoint(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/mcp", endpoint, methods=["POST"])])
    app.add_middleware(
        BearerTokenMiddleware,
        token=token,
        authorization=authorization,
        requests_per_minute=10,
        write_requests_per_minute=1,
        preauth_requests_per_minute=10,
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "display_project_propose",
    }

    with TestClient(app) as client:
        assert client.post("/mcp", headers=headers).status_code == 200
        denied = client.post("/mcp", headers=headers)

    assert denied.status_code == 429


def test_assistant_tools_read_project_catalog_and_bindings(tmp_path: Path) -> None:
    service = AssistantToolService(mcp_settings(tmp_path))
    project = project_with_button()
    project["entities"] = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project["bindings"] = [
        {
            "id": "temperature_binding",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "temperature"},
            "target": {"widget_id": "button_1", "property": "text"},
        }
    ]
    created = service.projects.save("display.lvgldesign", project, None)

    listing = service.list_projects()
    assert listing["projects"][0]["name"] == "display.lvgldesign"
    summary = service.read_project("display.lvgldesign", "summary")
    assert summary["revision"] == created["revision"]
    assert summary["summary"]["widget_count"] == 1
    assert summary["summary"]["binding_count"] == 1
    widget = service.read_project("display.lvgldesign", "widget", "button_1")
    assert widget["widget"]["widget_type"] == "button"
    bindings = service.read_project("display.lvgldesign", "bindings")
    assert bindings["bindings"][0]["target"]["widget_id"] == "button_1"
    catalog = service.catalog("widgets", "de", "button")
    assert catalog["widget"]["type_key"] == "button"
    assert service.validate_project("display.lvgldesign")["valid"]


def test_mcp_completions_are_context_aware_and_bounded(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    for index in range(55):
        (settings.config_root / f"panel-{index:02}.yaml").write_text(
            "esphome:\n  name: panel\n",
            encoding="utf-8",
        )
    service = AssistantToolService(settings)
    project = project_with_button()
    project["entities"] = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        },
        {
            "domain": "switch",
            "id": "relay",
            "readable": True,
            "writable": True,
            "data_type": "boolean",
            "trigger": "on_state",
            "commands": ["toggle"],
        },
    ]
    service.projects.save("display.lvgldesign", project, None)

    assert service.complete_argument("project_name", "display")["values"] == [
        "display.lvgldesign"
    ]
    assert service.complete_argument(
        "widget_id",
        "button",
        {"project_name": "display.lvgldesign"},
    )["values"] == ["button_1"]
    assert service.complete_argument(
        "entity_id",
        "rel",
        {
            "project_name": "display.lvgldesign",
            "entity_domain": "switch",
        },
    )["values"] == ["relay"]
    assert service.complete_argument(
        "name",
        "display",
        resource_reference="esphome-display://projects/{name}/summary",
    )["values"] == ["display.lvgldesign"]

    configurations = service.complete_argument("configuration_name")
    assert len(configurations["values"]) == 50
    assert configurations["total"] == 55
    assert configurations["has_more"] is True


def test_mcp_preview_is_revision_bound_structured_and_paginated(
    tmp_path: Path,
) -> None:
    service = AssistantToolService(mcp_settings(tmp_path))
    project = project_with_button()
    parent = project["widgets"][0]
    parent["widget_type"] = "obj"
    parent["properties"] = {}
    parent["layout"] = {
        "type": "GRID",
        "grid_rows": [50],
        "grid_columns": [120],
    }
    parent["children"] = [
        {
            "id": "status_label",
            "widget_type": "label",
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 20,
            "properties": {"text": "Ready"},
            "grid_cell": {"row_pos": 0, "column_pos": 0},
            "children": [],
        }
    ]
    created = service.projects.save("display.lvgldesign", project, None)

    first = service.preview_project(
        "display.lvgldesign",
        created["revision"],
        limit=1,
    )
    assert first["format"] == "structured_layout_v1"
    assert first["scanned_count"] == 2
    assert first["widgets"][0]["id"] == "button_1"
    assert first["widgets"][0]["layout"]["type"] == "GRID"
    assert first["widgets"][0]["resolved"] == {
        "left": 12.0,
        "top": 24.0,
        "width": 120.0,
        "height": 50.0,
        "managed": False,
        "origin_x": 0.0,
        "origin_y": 0.0,
    }
    assert first["next_cursor"]

    second = service.preview_project(
        "display.lvgldesign",
        created["revision"],
        limit=1,
        cursor=first["next_cursor"],
    )
    assert second["widgets"][0]["id"] == "status_label"
    assert second["widgets"][0]["parent_id"] == "button_1"
    assert second["widgets"][0]["parent_layout_type"] == "GRID"
    assert second["widgets"][0]["resolved"]["managed"] is True
    assert second["widgets"][0]["resolved"]["origin_x"] == 12.0
    assert second["widgets"][0]["resolved"]["origin_y"] == 24.0
    assert second["next_cursor"] is None

    parent["x"] = 20
    service.projects.save("display.lvgldesign", project, created["revision"])
    with pytest.raises(ApiError, match="changed before the preview") as stale:
        service.preview_project("display.lvgldesign", created["revision"])
    assert stale.value.error == "revision_conflict"


def test_mcp_device_discovery_is_paginated_and_secret_free(tmp_path: Path) -> None:
    service = AssistantToolService(mcp_settings(tmp_path))
    service.device_registry.upsert(
        {
            "id": "kitchen",
            "name": "Kitchen panel",
            "host": "kitchen.local",
            "port": 6053,
            "encryption_key_ref": "kitchen_key",
        }
    )
    service.device_registry.upsert(
        {
            "id": "office",
            "name": "Office panel",
            "host": "192.168.1.20",
            "port": 6053,
            "encryption_key_ref": "office_key",
        }
    )

    first = service.list_devices(limit=1)
    assert first["count"] == 2
    assert first["devices"][0]["id"] == "kitchen"
    assert first["devices"][0]["encrypted"] is True
    assert "encryption_key_ref" not in first["devices"][0]
    assert first["devices"][0]["live_data_available"] is False
    second = service.list_devices(limit=1, cursor=first["next_cursor"])
    assert second["devices"][0]["id"] == "office"

    detail = service.read_device("kitchen")
    assert detail["device"]["host"] == "kitchen.local"
    assert "encryption_key_ref" not in detail["device"]
    assert service.complete_argument("device_id", "kit")["values"] == [
        "kitchen"
    ]


def test_mcp_lists_use_signed_query_bound_cursors(tmp_path: Path) -> None:
    service = AssistantToolService(mcp_settings(tmp_path))
    service.projects.save("a.lvgldesign", project_with_button(), None)
    service.projects.save("b.lvgldesign", project_with_button(), None)

    first = service.list_projects(limit=1)
    assert [item["name"] for item in first["projects"]] == ["a.lvgldesign"]
    assert first["next_cursor"]
    second = service.list_projects(limit=1, cursor=first["next_cursor"])
    assert [item["name"] for item in second["projects"]] == ["b.lvgldesign"]
    assert second["next_cursor"] is None

    with pytest.raises(ApiError, match="pagination cursor") as tampered:
        service.list_projects(limit=1, cursor=first["next_cursor"] + "x")
    assert tampered.value.error == "invalid_cursor"

    service.projects.save("c.lvgldesign", project_with_button(), None)
    with pytest.raises(ApiError, match="result changed") as stale:
        service.list_projects(limit=1, cursor=first["next_cursor"])
    assert stale.value.error == "cursor_stale"


def test_mcp_binding_targets_are_compatible_filtered_and_paginated(
    tmp_path: Path,
) -> None:
    service = AssistantToolService(mcp_settings(tmp_path))
    project = project_with_button()
    project["entities"] = [
        {
            "domain": "sensor",
            "id": "temperature",
            "name": "Room temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        },
        {
            "domain": "switch",
            "id": "relay",
            "name": "Relay",
            "readable": True,
            "writable": True,
            "data_type": "boolean",
            "trigger": "on_state",
            "commands": ["set_state", "toggle"],
        },
    ]
    created = service.projects.save("display.lvgldesign", project, None)

    widgets = service.binding_targets(
        "display.lvgldesign",
        target="widgets",
        direction="entity_to_widget",
        entity_domain="sensor",
        entity_id="temperature",
        limit=1,
    )
    assert widgets["revision"] == created["revision"]
    assert widgets["targets"][0]["widget_id"] == "button_1"
    assert "text" in widgets["targets"][0]["compatible_inputs"]
    assert "checked" not in widgets["targets"][0]["compatible_inputs"]

    writable = service.binding_targets(
        "display.lvgldesign",
        target="entities",
        direction="widget_to_entity",
        widget_id="button_1",
    )
    assert [(item["domain"], item["id"]) for item in writable["targets"]] == [
        ("switch", "relay")
    ]
    assert writable["targets"][0]["compatible_outputs"] == [
        "click",
        "press",
        "release",
        "value",
    ]


def test_mcp_yaml_export_and_merge_preview_are_revision_bound(
    tmp_path: Path,
) -> None:
    settings = mcp_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    source = settings.config_root / "panel.yaml"
    source.write_text(
        "esphome:\n  name: panel\nlogger:\n",
        encoding="utf-8",
    )
    service = AssistantToolService(settings)
    created = service.projects.save(
        "display.lvgldesign",
        project_with_button(),
        None,
    )

    exported = service.transform_yaml(
        "display.lvgldesign",
        created["revision"],
        max_characters=32,
    )
    assert exported["mode"] == "export"
    assert exported["content"]
    assert exported["next_offset"] == 32

    configuration = service.filesystem.read_config("panel.yaml")
    merged = service.transform_yaml(
        "display.lvgldesign",
        created["revision"],
        mode="merge_preview",
        configuration_name="panel.yaml",
        configuration_revision=configuration["revision"],
    )
    assert "logger:" in merged["content"]
    assert "lvgl:" in merged["content"]
    assert "lvgl" in merged["appended"]

    with pytest.raises(ApiError, match="stored project changed") as stale:
        service.transform_yaml("display.lvgldesign", "stale-revision")
    assert stale.value.error == "revision_conflict"


def test_mcp_configuration_reader_can_select_an_exact_draft(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: active\n",
        encoding="utf-8",
    )
    service = AssistantToolService(settings)
    saved = service.filesystem.save_draft(
        "panel.yaml",
        "esphome:\n  name: draft\n",
    )

    active = service.read_configuration("panel.yaml")
    draft = service.read_configuration("panel.yaml", source="draft")

    assert active["source"] == "active"
    assert "name: active" in active["content"]
    assert draft["source"] == "draft"
    assert draft["revision"] == saved["revision"]
    assert "name: draft" in draft["content"]


def test_mcp_registers_only_read_only_tools(tmp_path: Path) -> None:
    server = create_mcp_server(mcp_settings(tmp_path))
    tools = asyncio.run(server.list_tools())

    names = {tool.name for tool in tools}
    assert names == {
        "display_server_info",
        "display_catalog",
        "display_configurations",
        "display_configuration_read",
        "display_device_read",
        "display_binding_targets",
        "display_preview",
        "display_projects",
        "display_project_read",
        "display_project_validate",
        "display_yaml_transform",
    }
    assert all(tool.annotations.read_only_hint for tool in tools)
    assert all(tool.annotations.destructive_hint is False for tool in tools)

    result = asyncio.run(server.call_tool("display_server_info", {}))
    assert result.structured_content["ok"] is True
    assert result.structured_content["access"] == "read_only"
    assert result.structured_content["features"]["prompts"] is True
    assert result.structured_content["features"]["completions"] is True


def test_mcp_read_only_mode_serves_prompts_resources_and_templates(
    tmp_path: Path,
) -> None:
    server = create_mcp_server(mcp_settings(tmp_path))

    prompts = asyncio.run(server.list_prompts())
    assert {prompt.name for prompt in prompts} == {
        "display_analyze_project",
        "display_review_yaml",
    }
    rendered = asyncio.run(
        server.get_prompt(
            "display_analyze_project",
            {"project_name": "display.lvgldesign", "focus": "layout"},
        )
    )
    assert "display.lvgldesign" in rendered.messages[0].content.text
    assert "layout" in rendered.messages[0].content.text

    resources = asyncio.run(server.list_resources())
    assert "esphome-display://server/info" in {str(resource.uri) for resource in resources}
    assert "esphome-display://devices" in {
        str(resource.uri) for resource in resources
    }
    templates = asyncio.run(server.list_resource_templates())
    assert "esphome-display://projects/{name}/summary" in {
        str(template.uri_template) for template in templates
    }
    assert "esphome-display://devices/{device_id}/summary" in {
        str(template.uri_template) for template in templates
    }


def test_mcp_apps_preview_is_ui_bound_and_still_a_plain_tool(tmp_path: Path) -> None:
    """display_preview must work identically for clients that never
    negotiated MCP Apps (same scope, same structured content) while also
    carrying the _meta.ui pointer supporting hosts use to render the
    sandboxed canvas."""
    from backend.assistant_tools.limits import MCP_APP_BUNDLE_MAX_BYTES

    settings = mcp_settings(tmp_path)
    service = AssistantToolService(settings)
    project = project_with_button()
    project["canvas"] = {"width": 320, "height": 240}
    created = service.projects.save("display.lvgldesign", project, None)
    server = create_mcp_server(settings)

    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    preview_tool = tools["display_preview"]
    assert preview_tool.meta == {
        "ui": {"resourceUri": "ui://display-editor/preview"}
    }
    assert preview_tool.annotations.read_only_hint is True

    resources = asyncio.run(server.list_resources())
    ui_resource = next(r for r in resources if str(r.uri) == "ui://display-editor/preview")
    assert ui_resource.mime_type == "text/html;profile=mcp-app"

    contents = asyncio.run(server.read_resource("ui://display-editor/preview"))
    html = contents[0].content
    assert len(html.encode("utf-8")) <= MCP_APP_BUNDLE_MAX_BYTES
    assert "<html" in html
    assert "ui/initialize" in html
    # No external origin is ever contacted by the bundle.
    assert "http://" not in html
    assert "https://" not in html

    result = asyncio.run(
        server.call_tool(
            "display_preview",
            {
                "name": "display.lvgldesign",
                "project_revision": created["revision"],
            },
        )
    )
    assert result.structured_content["ok"] is True
    assert result.structured_content["name"] == "display.lvgldesign"


def test_mcp_apps_changeset_review_only_registers_in_project_write_mode(
    tmp_path: Path,
) -> None:
    read_only_server = create_mcp_server(mcp_settings(tmp_path))
    read_only_resources = {
        str(r.uri) for r in asyncio.run(read_only_server.list_resources())
    }
    assert "ui://display-editor/changeset-review" not in read_only_resources
    # display_project_propose etc. are absent in read_only mode regardless.
    read_only_tools = {t.name for t in asyncio.run(read_only_server.list_tools())}
    assert "display_project_propose" not in read_only_tools


def test_mcp_apps_changeset_review_binds_all_propose_tools(tmp_path: Path) -> None:
    from backend.assistant_tools.limits import MCP_APP_BUNDLE_MAX_BYTES

    settings = mcp_settings(tmp_path, mcp_access="project_write")
    server = create_mcp_server(settings)

    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    review_bound_tools = {
        "display_project_propose",
        "display_project_import_propose",
        "display_project_import_yaml_propose",
        "display_configuration_draft_propose",
        "display_binding_propose",
        "display_viewer_binding_propose",
    }
    for name in review_bound_tools:
        assert tools[name].meta == {
            "ui": {"resourceUri": "ui://display-editor/changeset-review"}
        }, name
    # display_changeset_apply itself stays a plain tool: the Review view
    # calls it through the bridge, it is not the thing being previewed.
    assert tools["display_changeset_apply"].meta is None

    resources = asyncio.run(server.list_resources())
    ui_resource = next(
        r for r in resources if str(r.uri) == "ui://display-editor/changeset-review"
    )
    assert ui_resource.mime_type == "text/html;profile=mcp-app"

    contents = asyncio.run(
        server.read_resource("ui://display-editor/changeset-review")
    )
    html = contents[0].content
    assert len(html.encode("utf-8")) <= MCP_APP_BUNDLE_MAX_BYTES
    assert "display_changeset_apply" in html
    assert "http://" not in html
    assert "https://" not in html


def test_mcp_apps_changeset_review_propose_tool_still_functions_normally(
    tmp_path: Path,
) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
    service = AssistantToolService(settings)
    created = service.projects.save("display.lvgldesign", project_with_button(), None)
    server = create_mcp_server(settings)

    proposed = asyncio.run(
        server.call_tool(
            "display_project_propose",
            {
                "name": "display.lvgldesign",
                "base_revision": created["revision"],
                "operations": [
                    {
                        "op": "add_widget",
                        "widget_id": "review_label",
                        "widget_type": "label",
                        "placement": {"x": 10, "y": 10},
                        "properties": {"text": "Review"},
                    }
                ],
            },
        )
    ).structured_content
    assert proposed["ok"] is True
    assert proposed["target_kind"] == "project"

    applied = asyncio.run(
        server.call_tool(
            "display_changeset_apply",
            {"change_set_id": proposed["change_set_id"]},
        )
    ).structured_content
    assert applied["ok"] is True
    assert service.projects.read("display.lvgldesign")["revision"] == applied[
        "applied_revision"
    ]


def test_mcp_rejects_oversized_tool_responses(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path)
    service = AssistantToolService(settings)
    project = project_with_button()
    project["widgets"][0]["properties"]["text"] = "x" * (600 * 1024)
    service.projects.save("large.lvgldesign", project, None)
    server = create_mcp_server(settings)

    result = asyncio.run(
        server.call_tool(
            "display_project_read",
            {"name": "large.lvgldesign", "view": "widget", "widget_id": "button_1"},
        )
    )

    assert result.structured_content["ok"] is False
    assert result.structured_content["error"] == "response_too_large"


def test_project_write_mode_registers_and_executes_changeset_tools(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
    service = AssistantToolService(settings)
    created = service.projects.save("display.lvgldesign", project_with_button(), None)
    server = create_mcp_server(settings)
    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}

    assert {
        "display_project_propose",
        "display_project_import_propose",
        "display_project_import_yaml_propose",
        "display_configuration_draft_propose",
        "display_configuration_apply",
        "display_binding_propose",
        "display_viewer_binding_propose",
        "display_changeset_read",
        "display_changeset_apply",
    } <= set(tools)
    assert tools["display_configuration_apply"].annotations.destructive_hint is True
    assert (
        tools["display_project_import_yaml_propose"].annotations.destructive_hint
        is False
    )
    assert tools["display_project_propose"].annotations.destructive_hint is False
    assert tools["display_project_propose"].annotations.read_only_hint is False
    assert tools["display_changeset_apply"].annotations.destructive_hint is True
    assert tools["display_changeset_apply"].annotations.idempotent_hint is True
    assert {prompt.name for prompt in asyncio.run(server.list_prompts())} == {
        "display_analyze_project",
        "display_review_yaml",
        "display_create_project_from_yaml",
        "display_edit_layout",
        "display_bind_entities",
    }

    proposed = asyncio.run(
        server.call_tool(
            "display_project_propose",
            {
                "name": "display.lvgldesign",
                "base_revision": created["revision"],
                "operations": [
                    {
                        "op": "add_widget",
                        "widget_id": "mcp_label",
                        "widget_type": "label",
                        "placement": {"x": 160, "y": 20},
                        "properties": {"text": "MCP"},
                    }
                ],
            },
        )
    ).structured_content
    assert proposed["ok"] is True
    assert proposed["status"] == "pending"

    applied = asyncio.run(
        server.call_tool(
            "display_changeset_apply",
            {"change_set_id": proposed["change_set_id"]},
        )
    ).structured_content
    assert applied["ok"] is True
    assert applied["status"] == "applied"
    assert service.projects.read("display.lvgldesign")["revision"] == applied[
        "applied_revision"
    ]


def test_mcp_project_write_mode_imports_raw_yaml_and_publishes_a_draft(
    tmp_path: Path,
) -> None:
    settings = mcp_settings(tmp_path, mcp_access="project_write")
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: active\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    active = service.read_configuration("panel.yaml")
    service.filesystem.save_draft("panel.yaml", "esphome:\n  name: published\n")
    server = create_mcp_server(settings)

    imported = asyncio.run(
        server.call_tool(
            "display_project_import_yaml_propose",
            {
                "yaml_content": (
                    "lvgl:\n  widgets:\n"
                    "    - label:\n        id: status_label\n        text: Ready\n"
                ),
                "project_name": "uploaded.lvgldesign",
                "source_name": "uploaded.yaml",
            },
        )
    ).structured_content
    assert imported["ok"] is True
    assert imported["target_kind"] == "project_create"
    applied = asyncio.run(
        server.call_tool(
            "display_changeset_apply",
            {"change_set_id": imported["change_set_id"]},
        )
    ).structured_content
    assert applied["ok"] is True
    assert service.projects.read("uploaded.lvgldesign")["project"]["widgets"][0][
        "id"
    ] == "status_label"

    published = asyncio.run(
        server.call_tool(
            "display_configuration_apply",
            {"name": "panel.yaml", "expected_revision": active["revision"]},
        )
    ).structured_content
    assert published["ok"] is True
    assert published["revision"] != active["revision"]
    assert (
        service.read_configuration("panel.yaml")["content"]
        == "esphome:\n  name: published\n"
    )

    stale = asyncio.run(
        server.call_tool(
            "display_configuration_apply",
            {"name": "panel.yaml", "expected_revision": active["revision"]},
        )
    ).structured_content
    assert stale["ok"] is False
    assert stale["error"] == "revision_conflict"


def test_mcp_read_only_mode_does_not_register_configuration_publish(
    tmp_path: Path,
) -> None:
    server = create_mcp_server(mcp_settings(tmp_path))
    tools = {tool.name for tool in asyncio.run(server.list_tools())}
    assert "display_configuration_apply" not in tools
    assert "display_project_import_yaml_propose" not in tools


def test_mcp_http_requires_token_and_rejects_untrusted_hosts(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path)
    with TestClient(create_mcp_app(settings)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/mcp").status_code == 401
        assert (
            client.get("/mcp", headers={"Authorization": "Bearer wrong"}).status_code
            == 401
        )
        denied_host = client.get(
            "/mcp",
            headers={
                "Authorization": f"Bearer {settings.mcp_access_token}",
                "Host": "untrusted.invalid:8100",
            },
        )
        assert denied_host.status_code == 421
        denied_origin = client.get(
            "/mcp",
            headers={
                "Authorization": f"Bearer {settings.mcp_access_token}",
                "Host": "localhost:8100",
                "Origin": "https://untrusted.invalid",
            },
        )
        assert denied_origin.status_code == 403


def test_mcp_http_rate_limit_is_enforced_after_authentication(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path, api_rate_limit_per_minute=1)
    headers = {
        "Authorization": f"Bearer {settings.mcp_access_token}",
        "Host": "localhost:8100",
    }
    with TestClient(create_mcp_app(settings)) as client:
        client.get("/mcp", headers=headers)
        denied = client.get("/mcp", headers=headers)

    assert denied.status_code == 429
    assert int(denied.headers["Retry-After"]) >= 1


@pytest.mark.parametrize("protocol_version", ["2025-11-25", "2026-07-28"])
def test_mcp_streamable_http_initialization_is_compatible(
    tmp_path: Path, protocol_version: str
) -> None:
    settings = mcp_settings(tmp_path)
    headers = {
        "Authorization": f"Bearer {settings.mcp_access_token}",
        "Host": "localhost:8100",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": protocol_version,
            "capabilities": {},
            "clientInfo": {"name": "compatibility-test", "version": "1.0"},
        },
    }

    with TestClient(create_mcp_app(settings)) as client:
        response = client.post("/mcp", headers=headers, json=payload)

    assert response.status_code == 200, response.text
    assert response.headers.get("Mcp-Session-Id")
    assert '"serverInfo"' in response.text
    assert '"completions"' in response.text
    assert '"prompts"' in response.text


def test_mcp_http_completes_prompt_arguments(tmp_path: Path) -> None:
    settings = mcp_settings(tmp_path)
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
            "clientInfo": {"name": "completion-test", "version": "1.0"},
        },
    }
    completion = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "completion/complete",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
            },
            "ref": {"type": "ref/prompt", "name": "display_analyze_project"},
            "argument": {"name": "focus", "value": "lay"},
            "context": {"arguments": {}},
        },
    }

    with TestClient(create_mcp_app(settings)) as client:
        initialized = client.post("/mcp", headers=headers, json=initialize)
        session_headers = {
            **headers,
            "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "completion/complete",
        }
        response = client.post("/mcp", headers=session_headers, json=completion)

    assert response.status_code == 200, response.text
    assert '"values":["layout"]' in response.text
    assert '"total":1' in response.text


def test_settings_loads_mcp_options_without_exposing_token(
    tmp_path: Path, monkeypatch
) -> None:
    options = tmp_path / "options.json"
    options.write_text(
        """{
          "access_level": "write",
          "mcp_mode": "lan",
          "mcp_access": "project_write",
          "mcp_access_token": "abcdefghijklmnopqrstuvwxyz-123456789",
          "mcp_allowed_hosts": "display.local, 192.0.2.10",
          "mcp_allowed_origins": "https://display.local"
        }""",
        encoding="utf-8",
    )
    monkeypatch.setenv("ESPHOME_OPTIONS_PATH", str(options))

    settings = Settings.load()

    assert settings.mcp_mode == "lan"
    assert settings.mcp_access == "project_write"
    assert settings.mcp_allowed_hosts == ("display.local", "192.0.2.10")
    assert settings.mcp_allowed_origins == ("https://display.local",)
    assert settings.mcp_access_token not in repr(settings)
