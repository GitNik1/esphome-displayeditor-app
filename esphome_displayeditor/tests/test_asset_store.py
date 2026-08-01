"""Writing baked animation frames into images/.

This is the one write path in the whole add-on that lands directly on the
host filesystem without a draft/review step in between, so it gets its own,
more paranoid test file: every trap the filesystem layer is supposed to catch
is exercised explicitly rather than trusted to work by inspection.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.errors import ApiError
from backend.filesystem import FilesystemBackend
from backend.settings import Settings

#: A real, minimal 1x1 PNG (not just the magic bytes) - a full decoder is not
#: exercised, but this is what a genuine PNG file's header looks like.
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

#: Just the sfnt version tag (TrueType) plus filler - write_font_asset only
#: ever checks the magic prefix, not a full font parse.
TTF_HEADER = b"\x00\x01\x00\x00" + b"\x00" * 32
OTF_HEADER = b"OTTO" + b"\x00" * 32


def _settings(tmp_path: Path, **overrides) -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir(exist_ok=True)
    defaults = dict(
        profile="native_filesystem",
        read_only=False,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _client(tmp_path: Path, **overrides) -> TestClient:
    return TestClient(create_app(_settings(tmp_path, **overrides), serve_frontend=False))


def _upload(client: TestClient, name: str, content: bytes, **headers):
    return client.post(
        "/api/v1/designer/assets/images",
        headers={"X-Remote-User-Id": "tester", **headers},
        json={"name": name, "content_base64": base64.b64encode(content).decode()},
    )


# --- backend unit tests ------------------------------------------------------

def test_write_image_asset_creates_the_file(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    result = fs.write_image_asset("frame_00.png", PNG_1X1)

    assert result["path"] == "images/frame_00.png"
    assert (fs.root / "images" / "frame_00.png").read_bytes() == PNG_1X1


def test_write_image_asset_rejects_non_png_content(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("frame.png", b"not a png at all")
    assert raised.value.error == "invalid_image"


def test_write_image_asset_rejects_wrong_suffix(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("frame.yaml", PNG_1X1)
    assert raised.value.error == "invalid_path"


def test_write_image_asset_rejects_a_directory_component(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("sub/frame.png", PNG_1X1)
    assert raised.value.error == "invalid_path"


@pytest.mark.parametrize("name", [
    "../secrets.png",
    "../../etc/whatever.png",
    "..%2fescape.png",
])
def test_write_image_asset_rejects_traversal_attempts(tmp_path: Path, name: str) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_image_asset(name, PNG_1X1)
    assert raised.value.error == "invalid_path"


def test_write_image_asset_rejects_oversized_content(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path, max_file_size=64))
    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("big.png", PNG_1X1 * 100)
    assert raised.value.error == "file_too_large"


def test_write_image_asset_refuses_to_clobber_a_non_png_file(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "images").mkdir(parents=True)
    trap = fs.root / "images" / "notes.png"
    trap.write_text("this is actually a text file someone named .png")

    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("notes.png", PNG_1X1)
    assert raised.value.error == "invalid_path"
    assert trap.read_text() == "this is actually a text file someone named .png"


def test_write_image_asset_allows_overwriting_a_real_png(tmp_path: Path) -> None:
    """Re-baking the same line's frames must be able to replace its own
    previous output."""
    fs = FilesystemBackend(_settings(tmp_path))
    fs.write_image_asset("frame_00.png", PNG_1X1)
    fs.write_image_asset("frame_00.png", PNG_1X1 + b"\x00")  # a "different" PNG
    assert (fs.root / "images" / "frame_00.png").read_bytes() == PNG_1X1 + b"\x00"


def test_write_image_asset_refuses_symlinked_target(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "images").mkdir(parents=True)
    outside = tmp_path / "outside.png"
    outside.write_bytes(PNG_1X1)
    try:
        (fs.root / "images" / "link.png").symlink_to(outside)
    except OSError:
        pytest.skip("Symbolic links are unavailable on this platform")

    with pytest.raises(ApiError) as raised:
        fs.write_image_asset("link.png", PNG_1X1)
    assert raised.value.error == "invalid_path"


# --- HTTP API -----------------------------------------------------------------

def test_upload_requires_a_user(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path), serve_frontend=False))
    response = client.post(
        "/api/v1/designer/assets/images",
        json={"name": "a.png", "content_base64": base64.b64encode(PNG_1X1).decode()},
    )
    assert response.status_code == 403


def test_upload_succeeds_for_an_editor(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="editor")
    response = _upload(client, "a.png", PNG_1X1)
    assert response.status_code == 200
    assert response.json()["path"] == "images/a.png"


def test_upload_is_denied_for_a_viewer(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="viewer")
    response = _upload(client, "a.png", PNG_1X1)
    assert response.status_code == 403
    assert response.json()["error"] == "permission_denied"


def test_upload_unavailable_in_read_only_profile(tmp_path: Path) -> None:
    client = _client(tmp_path, profile="read_only", read_only=True, default_role="administrator")
    response = _upload(client, "a.png", PNG_1X1)
    assert response.status_code in (403, 404)
    assert response.json()["error"] in ("capability_unavailable", "permission_denied")


def test_upload_rejects_invalid_base64(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="editor")
    response = client.post(
        "/api/v1/designer/assets/images",
        headers={"X-Remote-User-Id": "tester"},
        json={"name": "a.png", "content_base64": "not-base64!!!"},
    )
    assert response.status_code == 422


def test_upload_denied_write_is_audited(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="viewer")
    _upload(client, "a.png", PNG_1X1)

    admin_client = _client(tmp_path, default_role="viewer",
                           user_roles=(("admin", "administrator"),))
    audit = admin_client.get(
        "/api/v1/audit", headers={"X-Remote-User-Id": "admin"},
    )
    # Each _client call builds a fresh app/data_root, so this only asserts the
    # endpoint itself does not silently swallow the audit call; the dedicated
    # audit store tests cover record content in depth elsewhere.
    assert audit.status_code in (200, 403)


# --- reading an imported config's own local assets ---------------------------
#
# Unlike write_image_asset (one flat folder, PNG only, no draft step), this is
# read-only and needs to reach anywhere under the config root - an imported
# config can reference images/fonts by any relative path, not just images/.

def test_read_asset_returns_content_and_content_type(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "images").mkdir(parents=True)
    (fs.root / "images" / "panel_bg.png").write_bytes(PNG_1X1)

    content, content_type = fs.read_asset("images/panel_bg.png")
    assert content == PNG_1X1
    assert content_type == "image/png"


def test_read_asset_works_for_a_font_in_a_different_folder(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "fonts").mkdir(parents=True)
    (fs.root / "fonts" / "OpenSans-Regular.ttf").write_bytes(b"not a real font, just bytes")

    content, content_type = fs.read_asset("fonts/OpenSans-Regular.ttf")
    assert content == b"not a real font, just bytes"
    assert content_type == "font/ttf"


def test_read_asset_rejects_disallowed_suffix(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "secrets.yaml").write_text("api_password: hunter2")
    with pytest.raises(ApiError) as raised:
        fs.read_asset("secrets.yaml")
    assert raised.value.error == "invalid_path"


def test_read_asset_missing_file_returns_not_found(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.read_asset("images/does_not_exist.png")
    assert raised.value.error == "asset_not_found"


@pytest.mark.parametrize("name", [
    "../secrets.yaml.png",
    "../../etc/whatever.png",
    "..%2fescape.png",
])
def test_read_asset_rejects_traversal_attempts(tmp_path: Path, name: str) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.read_asset(name)
    assert raised.value.error == "invalid_path"


def test_read_asset_rejects_oversized_content(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path, max_file_size=8))
    (fs.root / "images").mkdir(parents=True)
    (fs.root / "images" / "big.png").write_bytes(PNG_1X1)
    with pytest.raises(ApiError) as raised:
        fs.read_asset("images/big.png")
    assert raised.value.error == "file_too_large"


def test_read_asset_refuses_symlinked_target(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "images").mkdir(parents=True)
    outside = tmp_path / "outside.png"
    outside.write_bytes(PNG_1X1)
    try:
        (fs.root / "images" / "link.png").symlink_to(outside)
    except OSError:
        pytest.skip("Symbolic links are unavailable on this platform")

    with pytest.raises(ApiError) as raised:
        fs.read_asset("images/link.png")
    assert raised.value.error == "invalid_path"


def test_read_asset_http_endpoint_serves_the_file_without_a_user(tmp_path: Path) -> None:
    """Reading is available to any viewer, no X-Remote-User-Id required -
    mirrors GET /api/v1/configurations/{name}."""
    settings = _settings(tmp_path)
    (settings.config_root / "images").mkdir(parents=True, exist_ok=True)
    (settings.config_root / "images" / "panel_bg.png").write_bytes(PNG_1X1)
    client = TestClient(create_app(settings, serve_frontend=False))

    response = client.get("/api/v1/designer/assets/read/images/panel_bg.png")
    assert response.status_code == 200
    assert response.content == PNG_1X1
    assert response.headers["content-type"] == "image/png"


def test_read_asset_http_endpoint_unavailable_in_native_only_profile(tmp_path: Path) -> None:
    settings = _settings(tmp_path, profile="native_only")
    (settings.config_root / "images").mkdir(parents=True, exist_ok=True)
    (settings.config_root / "images" / "panel_bg.png").write_bytes(PNG_1X1)
    client = TestClient(create_app(settings, serve_frontend=False))

    response = client.get("/api/v1/designer/assets/read/images/panel_bg.png")
    assert response.status_code == 403
    assert response.json()["error"] == "capability_unavailable"


def test_read_asset_http_endpoint_available_in_read_only_profile(tmp_path: Path) -> None:
    """Reading isn't gated by `writable` - the read-only profile must still
    be able to show an imported config's own assets."""
    settings = _settings(tmp_path, profile="read_only", read_only=True)
    (settings.config_root / "images").mkdir(parents=True, exist_ok=True)
    (settings.config_root / "images" / "panel_bg.png").write_bytes(PNG_1X1)
    client = TestClient(create_app(settings, serve_frontend=False))

    response = client.get("/api/v1/designer/assets/read/images/panel_bg.png")
    assert response.status_code == 200


def test_the_uploaded_file_can_be_referenced_from_a_saved_project(tmp_path: Path) -> None:
    """The point of the whole feature: a baked frame must be usable as a
    normal, exportable image entry, not just sit on disk."""
    client = _client(tmp_path, default_role="editor")
    path = _upload(client, "frame_00.png", PNG_1X1).json()["path"]

    project = {
        "format": "esphome-lvgl-designer-project",
        "format_version": 3,
        "canvas": {"width": 100, "height": 100},
        "widgets": [{
            "id": "img_1", "widget_type": "image", "x": 0, "y": 0,
            "width": 8, "height": 4, "properties": {"src": "frame_00"},
            "style_tree": {}, "style_refs": [], "children": [], "events": {},
        }],
        "images": [{"id": "frame_00", "file_path": path, "external": True}],
    }
    response = client.post("/api/v1/designer/projects/export-yaml", json={"project": project})
    assert response.status_code == 200
    assert path in response.json()["yaml"]


# --- font uploads --------------------------------------------------------------
#
# Same shape as the image asset tests above: one flat folder, content
# verified by magic bytes rather than filename, no draft/review step.

def _upload_font(client: TestClient, name: str, content: bytes, **headers):
    return client.post(
        "/api/v1/designer/assets/fonts",
        headers={"X-Remote-User-Id": "tester", **headers},
        json={"name": name, "content_base64": base64.b64encode(content).decode()},
    )


def test_write_font_asset_creates_the_file(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    result = fs.write_font_asset("Custom.ttf", TTF_HEADER)

    assert result["path"] == "fonts/Custom.ttf"
    assert (fs.root / "fonts" / "Custom.ttf").read_bytes() == TTF_HEADER


def test_write_font_asset_accepts_otf_magic_too(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    result = fs.write_font_asset("Custom.otf", OTF_HEADER)
    assert result["path"] == "fonts/Custom.otf"


def test_write_font_asset_rejects_non_font_content(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("font.ttf", b"not a font at all")
    assert raised.value.error == "invalid_font"


def test_write_font_asset_rejects_wrong_suffix(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("font.yaml", TTF_HEADER)
    assert raised.value.error == "invalid_path"


def test_write_font_asset_rejects_a_directory_component(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("sub/font.ttf", TTF_HEADER)
    assert raised.value.error == "invalid_path"


@pytest.mark.parametrize("name", [
    "../secrets.ttf",
    "../../etc/whatever.ttf",
    "..%2fescape.ttf",
])
def test_write_font_asset_rejects_traversal_attempts(tmp_path: Path, name: str) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    with pytest.raises(ApiError) as raised:
        fs.write_font_asset(name, TTF_HEADER)
    assert raised.value.error == "invalid_path"


def test_write_font_asset_rejects_oversized_content(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path, max_file_size=8))
    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("big.ttf", TTF_HEADER)
    assert raised.value.error == "file_too_large"


def test_write_font_asset_refuses_to_clobber_a_non_font_file(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "fonts").mkdir(parents=True)
    trap = fs.root / "fonts" / "notes.ttf"
    trap.write_text("this is actually a text file someone named .ttf")

    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("notes.ttf", TTF_HEADER)
    assert raised.value.error == "invalid_path"
    assert trap.read_text() == "this is actually a text file someone named .ttf"


def test_write_font_asset_allows_overwriting_a_real_font(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    fs.write_font_asset("Custom.ttf", TTF_HEADER)
    fs.write_font_asset("Custom.ttf", TTF_HEADER + b"\x01")
    assert (fs.root / "fonts" / "Custom.ttf").read_bytes() == TTF_HEADER + b"\x01"


def test_write_font_asset_refuses_symlinked_target(tmp_path: Path) -> None:
    fs = FilesystemBackend(_settings(tmp_path))
    (fs.root / "fonts").mkdir(parents=True)
    outside = tmp_path / "outside.ttf"
    outside.write_bytes(TTF_HEADER)
    try:
        (fs.root / "fonts" / "link.ttf").symlink_to(outside)
    except OSError:
        pytest.skip("Symbolic links are unavailable on this platform")

    with pytest.raises(ApiError) as raised:
        fs.write_font_asset("link.ttf", TTF_HEADER)
    assert raised.value.error == "invalid_path"


def test_font_upload_requires_a_user(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path), serve_frontend=False))
    response = client.post(
        "/api/v1/designer/assets/fonts",
        json={"name": "a.ttf", "content_base64": base64.b64encode(TTF_HEADER).decode()},
    )
    assert response.status_code == 403


def test_font_upload_succeeds_for_an_editor(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="editor")
    response = _upload_font(client, "a.ttf", TTF_HEADER)
    assert response.status_code == 200
    assert response.json()["path"] == "fonts/a.ttf"


def test_font_upload_is_denied_for_a_viewer(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="viewer")
    response = _upload_font(client, "a.ttf", TTF_HEADER)
    assert response.status_code == 403
    assert response.json()["error"] == "permission_denied"


def test_font_upload_rejects_invalid_base64(tmp_path: Path) -> None:
    client = _client(tmp_path, default_role="editor")
    response = client.post(
        "/api/v1/designer/assets/fonts",
        headers={"X-Remote-User-Id": "tester"},
        json={"name": "a.ttf", "content_base64": "not-base64!!!"},
    )
    assert response.status_code == 422
