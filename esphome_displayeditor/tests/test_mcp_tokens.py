from __future__ import annotations

from datetime import timedelta
import http.client
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.api.routers import admin_mcp as admin_mcp_router
from backend.assistant_tools.limits import MCP_TOKEN_LAST_USED_FLUSH_SECONDS
from backend.audit import AuditStore
from backend.errors import ApiError
from backend.mcp.app import create_mcp_app
from backend.mcp.health import _probe_mcp_listener
from backend.mcp.identity import READ_SCOPES
from backend.mcp.token_store import MCPTokenAuthenticator, MCPTokenStore
from backend.mcp import token_store as token_store_module
from backend.settings import Settings


def token_settings(tmp_path: Path, *, role: str = "administrator") -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    return Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=role,
        mcp_mode="lan",
        mcp_access="project_write",
        mcp_access_token="legacy-token-" + "x" * 32,
    )


def test_managed_mcp_token_is_hashed_authenticates_and_revokes(
    tmp_path: Path,
) -> None:
    store = MCPTokenStore(tmp_path)
    created = store.create(
        "Claude Desktop",
        ["server:read", "project:read", "project:write"],
        24 * 60 * 60,
    )
    raw_token = created["token"]
    token_id = created["client"]["id"]

    stored_text = store.path.read_text(encoding="utf-8")
    stored_payload = json.loads(stored_text)
    assert raw_token.startswith("mcp_")
    assert raw_token not in stored_text
    assert len(stored_payload["tokens"][0]["secret_hash"]) == 64
    assert "secret_hash" not in store.list()[0]

    authorization = store.authenticate(
        raw_token,
        allowed_scopes=frozenset({"server:read", "project:read"}),
    )
    assert authorization is not None
    assert authorization.identity == f"mcp:token:{token_id}"
    assert authorization.scopes == {"server:read", "project:read"}

    revoked = store.revoke(token_id)
    assert revoked["status"] == "revoked"
    assert store.authenticate(raw_token, allowed_scopes=READ_SCOPES) is None
    assert store.revoke(token_id)["status"] == "revoked"


def test_managed_mcp_token_records_last_used_at_throttled(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """last_used_at is persisted promptly on first use, then throttled.

    Authentication happens in the MCP listener process while the admin UI
    lives in the main app process, so this has to survive being read from a
    different MCPTokenStore instance backed by the same file - throttling
    keeps every authenticated request from forcing a disk write.
    """
    store = MCPTokenStore(tmp_path)
    created = store.create("Client", ["server:read"], 3600)
    assert store.list()[0]["last_used_at"] is None

    first_use = store._now()
    monkeypatch.setattr(store, "_now", lambda: first_use)
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES) is not None
    assert (
        json.loads(store.path.read_text(encoding="utf-8"))["tokens"][0]["last_used_at"]
        == first_use.isoformat()
    )

    second_use = first_use + timedelta(seconds=5)
    monkeypatch.setattr(store, "_now", lambda: second_use)
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES) is not None
    assert (
        json.loads(store.path.read_text(encoding="utf-8"))["tokens"][0]["last_used_at"]
        == first_use.isoformat()
    )

    later_use = first_use + timedelta(seconds=MCP_TOKEN_LAST_USED_FLUSH_SECONDS + 1)
    monkeypatch.setattr(store, "_now", lambda: later_use)
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES) is not None
    assert (
        json.loads(store.path.read_text(encoding="utf-8"))["tokens"][0]["last_used_at"]
        == later_use.isoformat()
    )


def test_token_authentication_reuses_validated_file_cache(
    tmp_path: Path,
    monkeypatch,
) -> None:
    store = MCPTokenStore(tmp_path)
    created = store.create("Cached", ["server:read"], 3600)
    # The very first authenticated use always flushes last_used_at
    # immediately (see test_managed_mcp_token_records_last_used_at_throttled),
    # which invalidates the read cache once; warm that up before measuring.
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES)

    calls = 0
    original_loads = json.loads

    def counted_loads(value):
        nonlocal calls
        calls += 1
        return original_loads(value)

    monkeypatch.setattr(token_store_module.json, "loads", counted_loads)

    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES)
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES)
    assert store.authenticate("invalid", allowed_scopes=READ_SCOPES) is None
    assert calls == 1


def test_managed_mcp_token_expiry_and_validation_are_fail_closed(
    tmp_path: Path,
    monkeypatch,
) -> None:
    store = MCPTokenStore(tmp_path)
    created = store.create("Temporary", ["server:read"], 3600)
    current = store._now()
    monkeypatch.setattr(store, "_now", lambda: current + timedelta(hours=2))

    assert store.list()[0]["status"] == "expired"
    assert store.authenticate(created["token"], allowed_scopes=READ_SCOPES) is None
    with pytest.raises(ApiError) as invalid_scope:
        MCPTokenStore(tmp_path / "other").create("Bad", ["unknown:scope"], 3600)
    assert invalid_scope.value.error == "invalid_mcp_token_scopes"


def test_token_store_skips_duplicate_and_malformed_records_instead_of_failing_closed(
    tmp_path: Path,
) -> None:
    """One corrupted record must not take every other valid token offline."""
    store = MCPTokenStore(tmp_path)
    store.create("Good client", ["server:read"], 3600)
    payload = json.loads(store.path.read_text(encoding="utf-8"))
    good = payload["tokens"][0]
    duplicate_of_good = dict(good)
    malformed = dict(good)
    malformed["id"] = "f" * 24
    malformed["scopes"] = [{}]
    payload["tokens"] = [good, duplicate_of_good, malformed]
    store.path.write_text(json.dumps(payload), encoding="utf-8")

    listed = store.list()

    assert [item["id"] for item in listed] == [good["id"]]
    assert store.skipped_invalid_record_count == 2

    # A subsequent write (e.g. creating another token) persists only the
    # surviving valid record, letting the store self-heal on disk.
    store.create("Second client", ["server:read"], 3600)
    on_disk = json.loads(store.path.read_text(encoding="utf-8"))
    assert len(on_disk["tokens"]) == 2


def test_token_authenticator_keeps_legacy_compatibility_and_global_ceiling(
    tmp_path: Path,
) -> None:
    store = MCPTokenStore(tmp_path)
    managed = store.create(
        "Narrow client",
        ["server:read", "project:write"],
        3600,
    )
    authenticator = MCPTokenAuthenticator(
        store,
        "legacy-token-" + "x" * 32,
        "read_only",
    )

    managed_auth = authenticator.authenticate(managed["token"])
    assert managed_auth is not None
    assert managed_auth.scopes == {"server:read"}
    assert authenticator.authenticate("legacy-token-" + "x" * 32) == (
        authenticator.legacy
    )
    assert authenticator.authenticate("wrong") is None


def test_admin_api_creates_lists_and_immediately_revokes_mcp_tokens(
    tmp_path: Path,
) -> None:
    settings = token_settings(tmp_path)
    client = TestClient(create_app(settings, serve_frontend=False))

    created = client.post(
        "/api/v1/admin/mcp/tokens",
        headers={"X-Remote-User-Id": "admin-user"},
        json={
            "name": "Claude Code",
            "scopes": ["server:read", "project:read", "project:write"],
            "expires_in_seconds": 86400,
        },
    )
    assert created.status_code == 201
    assert created.headers["Cache-Control"] == "no-store"
    raw_token = created.json()["token"]
    token_id = created.json()["client"]["id"]

    listing = client.get(
        "/api/v1/admin/mcp/tokens",
        headers={"X-Remote-User-Id": "admin-user"},
    )
    assert listing.status_code == 200
    assert listing.json()["clients"][0]["id"] == token_id
    assert raw_token not in listing.text

    revoked = client.delete(
        f"/api/v1/admin/mcp/tokens/{token_id}",
        headers={"X-Remote-User-Id": "admin-user"},
    )
    assert revoked.status_code == 200
    assert revoked.json()["client"]["status"] == "revoked"
    audit_events = AuditStore(settings.data_root).recent()
    assert [event["action"] for event in audit_events[:2]] == [
        "mcp.token.revoke",
        "mcp.token.create",
    ]
    assert raw_token not in json.dumps(audit_events)
    authenticator = MCPTokenAuthenticator(
        MCPTokenStore(settings.data_root),
        settings.mcp_access_token,
        settings.mcp_access,
    )
    assert authenticator.authenticate(raw_token) is None


def test_mcp_token_admin_api_requires_administrator(tmp_path: Path) -> None:
    settings = token_settings(tmp_path, role="viewer")
    client = TestClient(create_app(settings, serve_frontend=False))

    denied = client.get(
        "/api/v1/admin/mcp/tokens",
        headers={"X-Remote-User-Id": "viewer-user"},
    )
    assert denied.status_code == 403
    assert denied.json()["error"] == "permission_denied"
    assert client.get("/api/v1/admin/mcp/status").status_code == 403
    assert client.post("/api/v1/admin/mcp/test").status_code == 403


def test_admin_api_reports_and_probes_fixed_mcp_listener(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def successful_probe() -> dict:
        return {
            "reachable": True,
            "status": "ok",
            "checked_at": "2026-08-21T12:00:00+00:00",
            "latency_ms": 4,
            "access": "project_write",
        }

    monkeypatch.setattr(admin_mcp_router, "probe_mcp_listener", successful_probe)
    settings = token_settings(tmp_path)
    client = TestClient(create_app(settings, serve_frontend=False))
    headers = {"X-Remote-User-Id": "admin-user"}

    status = client.get("/api/v1/admin/mcp/status", headers=headers)
    assert status.status_code == 200
    assert status.json() == {
        "mode": "lan",
        "access": "project_write",
        "port": 8100,
        "path": "/mcp",
        "health_path": "/health",
        "allowed_hosts": ["localhost", "127.0.0.1", "[::1]"],
        "configured": True,
        "skipped_invalid_token_records": 0,
    }
    probe = client.post("/api/v1/admin/mcp/test", headers=headers)
    assert probe.status_code == 200
    assert probe.json()["reachable"] is True
    assert probe.json()["access"] == "project_write"


def test_loopback_probe_accepts_only_bounded_mcp_health_response(
    monkeypatch,
) -> None:
    calls = []

    class FakeResponse:
        status = 200
        body = b'{"status":"ok","access":"read_only"}'

        @classmethod
        def read(cls, _limit: int) -> bytes:
            return cls.body

    class FakeConnection:
        def __init__(self, host: str, port: int, timeout: float) -> None:
            calls.append((host, port, timeout))

        def request(self, method: str, path: str, *, headers: dict) -> None:
            calls.append((method, path, headers))

        @staticmethod
        def getresponse() -> FakeResponse:
            return FakeResponse()

        @staticmethod
        def close() -> None:
            return None

    monkeypatch.setattr(http.client, "HTTPConnection", FakeConnection)
    result = _probe_mcp_listener()

    assert result["reachable"] is True
    assert result["status"] == "ok"
    assert "access" not in result
    assert calls[0][0:2] == ("127.0.0.1", 8100)
    assert calls[1][0:2] == ("GET", "/health")
    assert calls[1][2]["Host"] == "localhost:8100"

    FakeResponse.body = b"x" * 4097
    oversized = _probe_mcp_listener()
    assert oversized["reachable"] is False
    assert oversized["status"] == "invalid_response"


def test_mcp_listener_accepts_managed_token_and_observes_revocation(
    tmp_path: Path,
) -> None:
    settings = token_settings(tmp_path)
    store = MCPTokenStore(settings.data_root)
    created = store.create("Integration", ["server:read"], 3600)
    headers = {
        "Authorization": f"Bearer {created['token']}",
        "Host": "localhost:8100",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }

    with TestClient(create_mcp_app(settings)) as client:
        accepted = client.post("/mcp", headers=headers, json={})
        store.revoke(created["client"]["id"])
        denied = client.post("/mcp", headers=headers, json={})

    assert accepted.status_code != 401
    assert denied.status_code == 401


def test_mcp_http_narrow_token_cannot_reach_broader_scopes(tmp_path: Path) -> None:
    """A managed server:read-only token must be rejected for project:read tools.

    This exercises the real BearerTokenMiddleware -> contextvar -> tool-handler
    path end to end (unlike scope tests that call bind_authorization directly),
    so it also catches the identity ever silently widening to the legacy
    full-scope fallback if that propagation were to break.
    """
    settings = token_settings(tmp_path)
    store = MCPTokenStore(settings.data_root)
    created = store.create("Narrow client", ["server:read"], 3600)
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
            "clientInfo": {"name": "narrow-scope-test", "version": "1.0"},
        },
    }

    with TestClient(create_mcp_app(settings)) as client:
        initialized = client.post("/mcp", headers=headers, json=initialize)
        session_headers = {
            **headers,
            "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
            "Mcp-Protocol-Version": "2026-07-28",
        }
        info = client.post(
            "/mcp",
            headers={
                **session_headers,
                "Mcp-Method": "tools/call",
                "Mcp-Name": "display_server_info",
            },
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                    "name": "display_server_info",
                    "arguments": {},
                },
            },
        )
        projects = client.post(
            "/mcp",
            headers={
                **session_headers,
                "Mcp-Method": "tools/call",
                "Mcp-Name": "display_projects",
            },
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                    "name": "display_projects",
                    "arguments": {},
                },
            },
        )

    assert info.status_code == 200, info.text
    assert '"ok":true' in info.text
    assert f'"identity":"mcp:token:{created["client"]["id"]}"' in info.text

    assert projects.status_code == 200, projects.text
    assert '"ok":false' in projects.text
    assert '"forbidden_scope"' in projects.text
    assert "mcp:lan:" not in projects.text


def test_mcp_http_project_write_scope_cannot_publish_without_the_publish_scope(
    tmp_path: Path,
) -> None:
    """configuration:publish is a distinct scope from project:write/draft.

    An MCP token scoped for drafting project/configuration changes must not
    be able to make them active without also holding configuration:publish -
    the same Editor/Publisher separation the app's own roles use.
    """
    settings = token_settings(tmp_path)
    settings.config_root.mkdir(exist_ok=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: active\n", encoding="utf-8"
    )
    store = MCPTokenStore(settings.data_root)
    created = store.create(
        "Editor client",
        ["server:read", "project:write", "configuration:draft"],
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
            "clientInfo": {"name": "publish-scope-test", "version": "1.0"},
        },
    }

    with TestClient(create_mcp_app(settings)) as client:
        initialized = client.post("/mcp", headers=headers, json=initialize)
        session_headers = {
            **headers,
            "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"],
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "display_configuration_apply",
        }
        publish = client.post(
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
                    "name": "display_configuration_apply",
                    "arguments": {
                        "name": "panel.yaml",
                        "expected_revision": "sha256:" + "0" * 64,
                    },
                },
            },
        )

    assert publish.status_code == 200, publish.text
    assert '"ok":false' in publish.text
    assert '"forbidden_scope"' in publish.text
