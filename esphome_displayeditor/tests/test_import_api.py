"""The import endpoints.

Import is a read path: it parses a configuration and hands back a project.
Nothing about it may touch the file it read - that guarantee is asserted
directly at the bottom of this module rather than left to code review.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.filesystem import FilesystemBackend
from backend.settings import Settings

FIXTURE = Path(__file__).parent / "data" / "p4_86_panel.yaml"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    shutil.copy(FIXTURE, config_root / "p4-86-panel.yaml")
    (config_root / "secrets.yaml").write_text("wifi_password: hunter2\n", encoding="utf-8")
    settings = Settings(
        profile="native_filesystem",
        read_only=False,
        max_file_size=4 * 1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    return TestClient(create_app(settings, serve_frontend=False))


def test_probe_summarises_without_importing(client: TestClient) -> None:
    response = client.post("/api/v1/designer/import/probe",
                           json={"configuration": "p4-86-panel.yaml"})

    assert response.status_code == 200
    stats = response.json()
    assert stats["widget_count"] == 31
    assert stats["widget_types"] == {"animimg": 1, "button": 6, "label": 13, "obj": 11}
    assert stats["canvas"] == {"width": 720, "height": 720, "source": "display_model"}


def test_import_returns_a_saveable_project(client: TestClient) -> None:
    response = client.post("/api/v1/designer/import",
                           json={"configuration": "p4-86-panel.yaml"})

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["project"]["format_version"] == 2
    assert body["project"]["import_source"]["name"] == "p4-86-panel.yaml"
    # Assets belong to the source config; redefining them would collide.
    assert body["project"]["export_sections"] == ["lvgl"]


def test_an_imported_project_survives_save_and_export(client: TestClient) -> None:
    """The point of importing: the result has to work with the endpoints that
    already exist, with no special-casing."""
    project = client.post("/api/v1/designer/import",
                          json={"configuration": "p4-86-panel.yaml"}).json()["project"]

    saved = client.put(
        "/api/v1/designer/projects/p4.lvgldesign",
        headers={"X-Remote-User-Id": "test-user"},
        json={"project": project},
    )
    assert saved.status_code == 200

    exported = client.post("/api/v1/designer/projects/export-yaml", json={"project": project})
    assert exported.status_code == 200
    text = exported.json()["yaml"]
    assert "grid_cell_row_pos" in text
    assert "animimg" in text
    assert "was NOT modified" in text, "the header must warn about the source config"


def test_the_canvas_size_can_be_overridden(client: TestClient) -> None:
    response = client.post(
        "/api/v1/designer/import",
        json={"configuration": "p4-86-panel.yaml", "canvas": {"width": 480, "height": 320}},
    )

    project = response.json()["project"]
    assert project["canvas"] == {"width": 480, "height": 320}
    assert project["canvas_source"] == "user"


def test_pasted_content_is_accepted(client: TestClient) -> None:
    response = client.post(
        "/api/v1/designer/import",
        json={"content": "lvgl:\n  widgets:\n    - label: {id: hello, text: hi}\n"},
    )

    assert response.status_code == 200
    assert response.json()["stats"]["widget_count"] == 1


def test_a_configuration_without_lvgl_is_rejected_clearly(client: TestClient) -> None:
    response = client.post("/api/v1/designer/import",
                           json={"content": "esphome:\n  name: nothing\n"})

    assert response.status_code == 422
    assert response.json()["error"] == "import_failed"


def test_an_empty_request_is_rejected(client: TestClient) -> None:
    assert client.post("/api/v1/designer/import", json={}).status_code == 422


def test_secrets_stay_protected_on_the_import_path(client: TestClient) -> None:
    """Import reads through the same guarded accessor as everything else."""
    response = client.post("/api/v1/designer/import/probe",
                           json={"configuration": "secrets.yaml"})

    assert response.status_code == 403


def test_import_is_available_without_write_permission(tmp_path: Path) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    shutil.copy(FIXTURE, config_root / "panel.yaml")
    settings = Settings(
        profile="read_only",
        read_only=True,
        max_file_size=4 * 1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    client = TestClient(create_app(settings, serve_frontend=False))

    assert client.get("/api/v1/capabilities").json()["capabilities"]["designer.import_yaml"]
    # No X-Remote-User-Id header: import must not require write authorisation.
    assert client.post("/api/v1/designer/import",
                       json={"configuration": "panel.yaml"}).status_code == 200


def test_importing_cannot_write_to_the_source(tmp_path: Path, monkeypatch) -> None:
    """Structural proof rather than a promise: every write entry point is
    replaced with a landmine, and the source bytes are compared afterwards."""
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    source = config_root / "p4-86-panel.yaml"
    shutil.copy(FIXTURE, source)
    before = source.read_bytes()

    settings = Settings(
        profile="native_filesystem",
        read_only=False,
        max_file_size=4 * 1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    app_client = TestClient(create_app(settings, serve_frontend=False))

    def explode(*_args, **_kwargs):
        raise AssertionError("import must never write")

    monkeypatch.setattr(FilesystemBackend, "save_draft", explode)
    monkeypatch.setattr(FilesystemBackend, "publish", explode)
    monkeypatch.setattr(FilesystemBackend, "delete_draft", explode)

    response = app_client.post("/api/v1/designer/import",
                               json={"configuration": "p4-86-panel.yaml"})

    assert response.status_code == 200
    assert source.read_bytes() == before, "the imported configuration was modified"
