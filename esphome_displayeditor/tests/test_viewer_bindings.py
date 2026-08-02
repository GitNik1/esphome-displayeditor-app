from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.designer import DesignerService
from backend.errors import ApiError
from backend.project_store import ProjectStore
from backend.runtime.manager import DeviceManager, RuntimeState
from backend.runtime.registry import DeviceRegistry
from backend.runtime.secrets import SecretStore
from backend.settings import Settings
from backend.viewer_bindings import ViewerBindingStore

from .test_designer import project_with_button


def settings_for(tmp_path: Path, role: str = "administrator") -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    return Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=role,
        runtime_provider="native",
    )


def label_project() -> dict:
    project = project_with_button()
    widget = project["widgets"][0]
    widget["id"] = "temperature_label"
    widget["widget_type"] = "label"
    widget["properties"] = {"text": "--.- °C"}
    return project


def binding() -> dict:
    return {
        "widget_id": "temperature_label",
        "target": "text",
        "device_id": "display-1",
        "entity_id": "fake_sensor:7",
        "value_format": "{state:.1f} °C",
        "fallback": "--.- °C",
        "stale_after": 30,
    }


def numeric_project(widget_type: str) -> dict:
    project = project_with_button()
    widget = project["widgets"][0]
    widget.update({
        "id": f"{widget_type}_value",
        "widget_type": widget_type,
        "width": 120,
        "height": 120 if widget_type == "arc" else 24,
        "properties": {"value": 10, "min_value": 0, "max_value": 100},
    })
    return project


def test_binding_sidecar_is_revisioned_and_does_not_change_project(tmp_path: Path) -> None:
    projects = ProjectStore(tmp_path, DesignerService(tmp_path), 1024 * 1024)
    bindings = ViewerBindingStore(tmp_path)
    created = projects.save("display.lvgldesign", label_project(), None)
    project_path = projects.root / "display.lvgldesign"
    project_before = project_path.read_bytes()

    saved = bindings.save("display.lvgldesign", [binding()], None)
    assert bindings.read("display.lvgldesign")["bindings"] == [binding()]
    assert project_path.read_bytes() == project_before
    assert projects.read("display.lvgldesign")["revision"] == created["revision"]

    with pytest.raises(ApiError) as raised:
        bindings.save("display.lvgldesign", [], "sha256:" + "0" * 64)
    assert raised.value.error == "revision_conflict"
    assert saved["revision"].startswith("sha256:")


def test_viewer_api_filters_connection_data_and_validates_widget_target(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    registry = DeviceRegistry(settings.data_root)
    registry.upsert(
        {
            "id": "display-1",
            "name": "Display 1",
            "host": "192.168.1.42",
            "port": 6053,
            "encryption_key_ref": "display-secret",
        }
    )
    manager = DeviceManager(registry, SecretStore(settings.data_root), enabled=True)
    manager._runtime["display-1"] = RuntimeState(
        status="ready",
        entities=[
            {
                "type": "fake_sensor",
                "key": 7,
                "name": "Temperature",
                "unit_of_measurement": "°C",
            }
        ],
        states={
            "fake_sensor:7": {
                "type": "fake_sensor",
                "key": 7,
                "state": 21.5,
                "available": True,
                "received_at": "2026-07-31T12:00:00+00:00",
            }
        },
    )
    client = TestClient(create_app(settings, serve_frontend=False, runtime_manager=manager))
    headers = {"X-Remote-User-Id": "admin"}
    saved_project = client.put(
        "/api/v1/designer/projects/display.lvgldesign",
        headers=headers,
        json={"project": label_project(), "expected_revision": None},
    )
    assert saved_project.status_code == 200

    runtime = client.get("/api/v1/viewer/runtime", headers=headers)
    assert runtime.status_code == 200
    encoded = json.dumps(runtime.json())
    assert "192.168.1.42" not in encoded
    assert "display-secret" not in encoded
    device = runtime.json()["devices"][0]
    assert device["entities"][0]["entity_id"] == "fake_sensor:7"
    assert device["states"][0]["state"] == 21.5

    saved_binding = client.put(
        "/api/v1/viewer/bindings/display.lvgldesign",
        headers=headers,
        json={"bindings": [binding()], "expected_revision": None},
    )
    assert saved_binding.status_code == 200
    assert client.get(
        "/api/v1/viewer/bindings/display.lvgldesign", headers=headers
    ).json()["bindings"] == [binding()]

    invalid = {**binding(), "target": "value"}
    rejected = client.put(
        "/api/v1/viewer/bindings/display.lvgldesign",
        headers=headers,
        json={
            "bindings": [invalid],
            "expected_revision": saved_binding.json()["revision"],
        },
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"] == "invalid_binding_target"

    for widget_type in ("bar", "arc"):
        project_name = f"{widget_type}.lvgldesign"
        stored = client.put(
            f"/api/v1/designer/projects/{project_name}",
            headers=headers,
            json={"project": numeric_project(widget_type), "expected_revision": None},
        )
        assert stored.status_code == 200
        numeric_binding = {
            **binding(),
            "widget_id": f"{widget_type}_value",
            "target": "value",
        }
        accepted = client.put(
            f"/api/v1/viewer/bindings/{project_name}",
            headers=headers,
            json={"bindings": [numeric_binding], "expected_revision": None},
        )
        assert accepted.status_code == 200


def test_viewer_role_can_read_but_not_write_bindings(tmp_path: Path) -> None:
    settings = settings_for(tmp_path, role="viewer")
    ProjectStore(
        settings.data_root, DesignerService(settings.data_root), settings.max_file_size
    ).save("display.lvgldesign", label_project(), None)
    ViewerBindingStore(settings.data_root).save("display.lvgldesign", [binding()], None)
    client = TestClient(create_app(settings, serve_frontend=False))
    headers = {"X-Remote-User-Id": "viewer"}
    assert client.get(
        "/api/v1/viewer/bindings/display.lvgldesign", headers=headers
    ).status_code == 200
    assert client.put(
        "/api/v1/viewer/bindings/display.lvgldesign",
        headers=headers,
        json={"bindings": [], "expected_revision": None},
    ).status_code == 403


def test_viewer_websocket_snapshot_is_filtered(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ESPHOME_ALLOW_ANONYMOUS_WRITE", "1")
    settings = settings_for(tmp_path)
    registry = DeviceRegistry(settings.data_root)
    registry.upsert(
        {
            "id": "display-1",
            "name": "Display 1",
            "host": "192.168.1.42",
            "port": 6053,
            "encryption_key_ref": "display-secret",
        }
    )
    manager = DeviceManager(registry, SecretStore(settings.data_root), enabled=True)
    manager._runtime["display-1"] = RuntimeState(
        status="ready",
        entities=[{"type": "fake_sensor", "key": 7, "name": "Temperature"}],
        states={
            "fake_sensor:7": {
                "type": "fake_sensor",
                "key": 7,
                "state": 21.5,
                "available": True,
                "received_at": "2026-07-31T12:00:00+00:00",
            }
        },
    )
    with TestClient(
        create_app(settings, serve_frontend=False, runtime_manager=manager)
    ) as client:
        with client.websocket_connect("/api/v1/viewer/runtime/events") as websocket:
            snapshot = websocket.receive_json()
    encoded = json.dumps(snapshot)
    assert snapshot["type"] == "snapshot"
    assert snapshot["devices"][0]["states"][0]["entity_id"] == "fake_sensor:7"
    assert "192.168.1.42" not in encoded
    assert "display-secret" not in encoded
