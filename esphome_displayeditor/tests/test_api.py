from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

import pytest

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
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="administrator",
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


def test_merge_draft_replaces_only_the_lvgl_block_and_requires_write_capability(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "device.yaml").write_text(
        "esphome:\n  name: device\n\nlvgl:\n  widgets:\n  - label:\n      id: old\n      text: Old\n",
        encoding="utf-8", newline="",
    )
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False))
    project = project_with_button()

    denied = client.post(
        "/api/v1/designer/projects/merge-draft",
        json={"project": project, "target": "device.yaml"},
    )
    assert denied.status_code == 403

    allowed = client.post(
        "/api/v1/designer/projects/merge-draft",
        headers={"X-Remote-User-Id": "test-user"},
        json={"project": project, "target": "device.yaml"},
    )
    assert allowed.status_code == 200
    body = allowed.json()
    assert body["replaced"] == ["lvgl"]
    assert body["appended"] == []

    draft = client.get(
        "/api/v1/configurations/device.yaml/draft",
        headers={"X-Remote-User-Id": "test-user"},
    ).json()
    assert "esphome:\n  name: device" in draft["content"]
    assert "old" not in draft["content"]
    assert "button_1" in draft["content"]

    # The active file on disk must stay untouched - merge only ever writes
    # a draft, exactly like the existing save-draft endpoint does.
    active = (config_root / "device.yaml").read_text(encoding="utf-8")
    assert "old" in active
    assert "button_1" not in active


def test_merge_draft_replaces_a_draft_that_is_no_longer_valid_yaml(tmp_path: Path) -> None:
    """A draft left with repeated keys (the old block detection did that)
    must not block every later merge: the active file becomes the base."""
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "device.yaml").write_text(
        "esphome:\n  name: device\n", encoding="utf-8", newline="")
    settings = Settings(
        access_level="write", max_file_size=1024 * 1024, protect_sensitive_paths=True,
        config_root=config_root, data_root=tmp_path / "data", default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False),
                        headers={"X-Remote-User-Id": "test-user"})
    broken = "esphome:\n  name: device\nlvgl:\n  widgets: []\n  widgets: []\n"
    assert client.put("/api/v1/configurations/device.yaml/draft",
                      json={"content": broken}).status_code == 200

    merged = client.post("/api/v1/designer/projects/merge-draft",
                         json={"project": project_with_button(), "target": "device.yaml"})

    assert merged.status_code == 200
    assert merged.json()["issues"][0]["severity"] == "B"
    assert "saved draft was not valid YAML" in merged.json()["issues"][0]["message"]
    draft = client.get("/api/v1/configurations/device.yaml/draft").json()["content"]
    assert draft.count("widgets:") == 1 and "button_1" in draft


def test_export_zip_bundles_yaml_and_local_image(tmp_path: Path) -> None:
    import zipfile
    import io

    config_root = tmp_path / "esphome"
    (config_root / "images").mkdir(parents=True)
    (config_root / "images" / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\nfakepngdata")
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False))
    project = project_with_button()
    project["images"] = [{"id": "my_icon", "file_path": "images/icon.png"}]

    response = client.post("/api/v1/designer/projects/export-zip", json={"project": project})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "X-Missing-Assets" not in response.headers
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert "ui.yaml" in names
        assert "images/icon.png" in names
        assert archive.read("images/icon.png") == b"\x89PNG\r\n\x1a\nfakepngdata"
        assert b"button_1" in archive.read("ui.yaml")


def test_frontend_is_served(tmp_path: Path) -> None:
    settings = Settings(
        access_level="read",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
    )
    client = TestClient(create_app(settings))
    response = client.get("/")
    assert response.status_code == 200
    assert "script-src 'self'" in response.headers["Content-Security-Policy"]
    assert "'wasm-unsafe-eval'" in response.headers["Content-Security-Policy"]
    assert "'unsafe-eval'" not in response.headers["Content-Security-Policy"]
    assert "font-src 'self' data: http: https:" in response.headers["Content-Security-Policy"]
    assert response.headers["Permissions-Policy"] == "camera=(), microphone=(), geolocation=()"
    assert "ESPHome Display Editor" in response.text
    assert 'id="open-viewer"' in response.text
    assert 'id="viewer-dialog"' in response.text
    assert 'id="viewer-event-log"' in response.text
    assert 'id="viewer-page-controls"' in response.text
    assert 'id="runtime-binding-current"' in response.text
    assert 'id="runtime-binding-additional-widgets"' in response.text
    assert 'id="runtime-binding-orphans"' in response.text
    assert 'id="glyph-preview-status"' in response.text
    assert 'id="yaml-line-numbers"' in response.text
    assert 'id="merge-dialog"' in response.text
    assert 'id="image-button-section"' in response.text
    assert 'id="widget-action-image"' in response.text
    assert 'styles.css?v=0.402.0' in response.text
    assert 'app.js?v=0.402.0' in response.text
    assert client.get("/app.js").status_code == 200
    viewer = client.get("/viewer/viewer.js")
    assert viewer.status_code == 200
    assert "class ViewerController" in viewer.text
    assert "applyViewerAction" in viewer.text
    action_controls = client.get("/viewer/action-controls.js")
    action_updates = client.get("/viewer/action-updates.js")
    assert action_controls.status_code == 200
    assert action_updates.status_code == 200
    assert "lvgl.widget.show" in action_controls.text
    assert "lvgl.label.update" in action_updates.text
    styles = client.get("/styles.css")
    assert styles.status_code == 200
    assert styles.headers["Cache-Control"] == "no-cache"
    assert ".config-list-panel" in styles.text
    assert "grid-template-rows: auto minmax(0, 1fr)" in styles.text
    assert "scrollbar-gutter: stable" in styles.text
    assert "#designer.active { display: flex; }" in styles.text
    assert "grid-template-rows: minmax(0, 1fr)" in styles.text


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
def test_viewer_runtime_actions_and_style_priority() -> None:
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        [
            shutil.which("node") or "node",
            str(root / "tests" / "frontend" / "viewer_runtime.test.mjs"),
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_designer_project_api_requires_revision_and_ingress_user(tmp_path: Path) -> None:
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
        default_role="administrator",
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
    audit_events = client.get(
        "/api/v1/audit", headers={"X-Remote-User-Id": "user-1"}
    ).json()["events"]
    assert audit_events[0]["action"] == "designer.project.save"
    assert audit_events[0]["result"] == "project_exists"
    deleted = client.delete(
        f"{url}?expected_revision={revision}", headers={"X-Remote-User-Id": "user-1"}
    )
    assert deleted.status_code == 200


def _draft_client(tmp_path: Path) -> tuple[TestClient, Path]:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "device.yaml").write_text("esphome:\n  name: device\n", encoding="utf-8", newline="")
    settings = Settings(
        access_level="write", max_file_size=1024 * 1024, protect_sensitive_paths=True,
        config_root=config_root, data_root=tmp_path / "data", default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False),
                        headers={"X-Remote-User-Id": "test-user"})
    return client, config_root


def test_a_draft_changed_elsewhere_is_not_overwritten_or_published(tmp_path: Path) -> None:
    """A draft reviewed in one tab and changed in another (or by MCP) used to
    be overwritten - or published unseen. Naming the reviewed revision
    refuses both; leaving it out keeps the old, unchecked behaviour."""
    client, config_root = _draft_client(tmp_path)
    url = "/api/v1/configurations/device.yaml"
    first = client.put(f"{url}/draft", json={"content": "esphome:\n  name: a\n",
                                              "expected_draft_revision": None})
    assert first.status_code == 200
    seen = first.json()["revision"]
    elsewhere = client.put(f"{url}/draft", json={"content": "esphome:\n  name: b\n"})
    assert elsewhere.status_code == 200  # an unchecked client, as before

    stale = client.put(f"{url}/draft", json={"content": "esphome:\n  name: c\n",
                                              "expected_draft_revision": seen})
    assert stale.status_code == 409
    assert stale.json()["details"]["target"] == "configuration_draft"
    assert client.put(f"{url}/draft", json={"content": "x: 1\n",
                                             "expected_draft_revision": None}).status_code == 409

    active = client.get(url).json()["revision"]
    refused = client.post(f"{url}/publish", json={"expected_revision": active,
                                                   "expected_draft_revision": seen})
    assert refused.status_code == 409
    assert "name: device" in (config_root / "device.yaml").read_text(encoding="utf-8")

    current = client.get(f"{url}/draft").json()["revision"]
    published = client.post(f"{url}/publish", json={"expected_revision": active,
                                                     "expected_draft_revision": current})
    assert published.status_code == 200
    assert "name: b" in (config_root / "device.yaml").read_text(encoding="utf-8")
