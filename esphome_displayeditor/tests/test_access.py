"""Ingress, identity and capability checks shared by HTTP and WebSockets
(backend/api/access.py), and the stores the app shares with its assistant."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import app as app_module
from backend.api.access import IngressPolicy
from backend.app import create_app
from backend.assistant_tools import AssistantToolService
from backend.settings import Settings
from backend.stores import Stores

EVENT_STREAMS = ("/api/v1/jobs/events", "/api/v1/devices/events", "/api/v1/viewer/runtime/events")


def make_settings(tmp_path: Path, **overrides) -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir(exist_ok=True)
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="viewer",
        runtime_provider="native",
    )
    return replace(settings, **overrides)


def refusal(client: TestClient, path: str, **headers: str) -> tuple[int, str]:
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(path, headers=headers):
            pass
    return refused.value.code, refused.value.reason


def production_app(root: Path, monkeypatch, options: str = ""):
    root.mkdir()
    monkeypatch.setenv("ESPHOME_CONFIG_ROOT", str(root / "esphome"))
    monkeypatch.setenv("ESPHOME_DATA_ROOT", str(root / "data"))
    monkeypatch.setenv("ESPHOME_OPTIONS_PATH", str(root / "options.json"))
    if options:
        (root / "options.json").write_text(options, encoding="utf-8")
    (root / "esphome").mkdir()
    return create_app(serve_frontend=False)


def test_event_streams_refuse_clients_outside_ingress(tmp_path: Path, monkeypatch) -> None:
    """WebSockets bypass the HTTP middleware; every stream must still check
    Ingress first - before it says whether the runtime or builder is on."""
    for name, options in (("default", ""), ("runtime-off", '{"runtime_provider": "disabled"}')):
        client = TestClient(production_app(tmp_path / name, monkeypatch, options))
        for path in EVENT_STREAMS:
            assert refusal(client, path, **{"X-Remote-User-Id": "spoofed-admin"}) == (
                4403, "ingress_required"), (name, path)


def test_event_streams_need_a_user_with_the_capability(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ESPHOME_ALLOW_ANONYMOUS_WRITE", raising=False)
    client = TestClient(create_app(make_settings(tmp_path), serve_frontend=False))
    assert refusal(client, "/api/v1/devices/events") == (4403, "permission_denied")
    with client.websocket_connect(
        "/api/v1/devices/events", headers={"X-Remote-User-Id": "viewer"}
    ) as websocket:
        assert websocket.receive_json() == {"type": "devices", "devices": []}


def test_event_stream_names_an_unavailable_capability(tmp_path: Path) -> None:
    """Without the Device Builder the job stream has nothing to offer; it says
    so like the HTTP routes do, instead of blaming the user's role."""
    client = TestClient(create_app(make_settings(tmp_path), serve_frontend=False))
    assert refusal(client, "/api/v1/jobs/events", **{"X-Remote-User-Id": "admin"}) == (
        4403, "capability_unavailable")
    disabled = TestClient(create_app(
        make_settings(tmp_path, runtime_provider="disabled"), serve_frontend=False))
    for path in EVENT_STREAMS[1:]:
        assert refusal(disabled, path, **{"X-Remote-User-Id": "admin"}) == (
            4403, "capability_unavailable")


def test_event_streams_share_the_rate_limit(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, api_rate_limit_per_minute=2)
    client = TestClient(create_app(settings, serve_frontend=False))
    headers = {"X-Remote-User-Id": "viewer"}
    with client.websocket_connect("/api/v1/devices/events", headers=headers) as websocket:
        websocket.receive_json()
    with client.websocket_connect("/api/v1/viewer/runtime/events", headers=headers) as websocket:
        websocket.receive_json()
    assert refusal(client, "/api/v1/devices/events", **headers) == (4429, "rate_limit_exceeded")


def test_ingress_hosts_come_from_the_environment(monkeypatch) -> None:
    monkeypatch.delenv("ESPHOME_ALLOW_DIRECT_ACCESS", raising=False)
    monkeypatch.setenv("ESPHOME_TRUSTED_INGRESS_HOSTS", " 172.30.32.2, ,10.0.0.5 ")
    policy = IngressPolicy.from_environment()
    assert policy.trusted_hosts == {"172.30.32.2", "10.0.0.5"}
    assert policy.admits("10.0.0.5")
    assert not policy.admits("192.168.1.20")
    assert IngressPolicy.from_environment(allow_direct_access=True).admits("192.168.1.20")
    monkeypatch.setenv("ESPHOME_ALLOW_DIRECT_ACCESS", "1")
    assert IngressPolicy.from_environment().admits("192.168.1.20")


def test_assistant_service_uses_the_given_stores(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    stores = Stores.open(settings)
    service = AssistantToolService(settings, stores=stores)
    assert service.projects is stores.projects
    assert service.audit is stores.audit
    assert service.workflow is stores.workflow
    assert service.filesystem is stores.filesystem
    assert service.viewer_bindings is stores.viewer_bindings
    assert service.device_registry is stores.device_registry
    assert service.projects.revisions is stores.revisions


def test_app_hands_its_stores_to_the_assistant(tmp_path: Path, monkeypatch) -> None:
    created: list[AssistantToolService] = []
    original = app_module.AssistantToolService

    def spy(*args, **kwargs) -> AssistantToolService:
        created.append(original(*args, **kwargs))
        return created[-1]

    monkeypatch.setattr(app_module, "AssistantToolService", spy)
    application = create_app(make_settings(tmp_path), serve_frontend=False)
    (service,) = created
    assert service.workflow is application.state.workflow
