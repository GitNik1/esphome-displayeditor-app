from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings

from .test_designer import project_with_button


def test_health_capabilities_and_write_authorization(tmp_path: Path) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "display.yaml").write_text(
        "esphome:\n  name: display\n", encoding="utf-8", newline=""
    )
    settings = Settings(
        profile="native_filesystem",
        read_only=False,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    client = TestClient(create_app(settings, serve_frontend=False))

    assert client.get("/api/v1/health").json()["status"] == "ok"
    assert client.get("/api/v1/capabilities").json()["capabilities"]["configuration.publish"]
    denied = client.put(
        "/api/v1/configurations/display.yaml/draft",
        json={"content": "esphome:\n  name: draft\n"},
    )
    assert denied.status_code == 403
    allowed = client.put(
        "/api/v1/configurations/display.yaml/draft",
        headers={"X-Remote-User-Id": "test-user"},
        json={"content": "esphome:\n  name: draft\n"},
    )
    assert allowed.status_code == 200


def test_frontend_is_served(tmp_path: Path) -> None:
    settings = Settings(
        profile="read_only",
        read_only=True,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
    )
    client = TestClient(create_app(settings))
    response = client.get("/")
    assert response.status_code == 200
    assert "ESPHome Display Editor" in response.text
    assert client.get("/app.js").status_code == 200


def test_designer_project_api_requires_revision_and_ingress_user(tmp_path: Path) -> None:
    settings = Settings(
        profile="native_filesystem",
        read_only=False,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
    )
    client = TestClient(create_app(settings, serve_frontend=False))
    url = "/api/v1/designer/projects/display.lvgldesign"
    body = {"project": project_with_button(), "expected_revision": None}

    assert client.put(url, json=body).status_code == 403
    created = client.put(url, json=body, headers={"X-Remote-User-Id": "user-1"})
    assert created.status_code == 200
    revision = created.json()["revision"]
    assert client.get(url).json()["revision"] == revision
    assert client.get("/api/v1/designer/projects").json()["projects"][0]["name"] == "display.lvgldesign"

    conflict = client.put(url, json=body, headers={"X-Remote-User-Id": "user-1"})
    assert conflict.status_code == 409
    audit_events = client.get("/api/v1/audit").json()["events"]
    assert audit_events[0]["action"] == "designer.project.save"
    assert audit_events[0]["result"] == "project_exists"
    deleted = client.delete(
        f"{url}?expected_revision={revision}", headers={"X-Remote-User-Id": "user-1"}
    )
    assert deleted.status_code == 200
