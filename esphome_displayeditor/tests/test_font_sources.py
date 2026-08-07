from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.errors import ApiError
from backend.filesystem import FilesystemBackend
from backend.font_sources import FontSourceService
from backend.settings import Settings


TTF = b"\x00\x01\x00\x00" + b"font-revision"


class FakeResponse:
    def __init__(self, status_code=200, headers=None, content=b""):
        self.status_code = status_code
        self.headers = headers or {}
        self._content = content

    def iter_content(self, _size):
        yield self._content

    def close(self):
        pass


class FakeSession:
    trust_env = True

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


def settings(tmp_path: Path) -> Settings:
    root = tmp_path / "esphome"
    root.mkdir()
    return Settings(
        access_level="write",
        max_file_size=1024,
        protect_sensitive_paths=True,
        config_root=root,
        data_root=tmp_path / "data",
    )


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(
        "backend.font_sources.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )


def test_rejects_private_font_host_even_before_http(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.font_sources.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("127.0.0.1", 80))],
    )
    session = FakeSession([])
    service = FontSourceService(FilesystemBackend(settings(tmp_path)), max_size=4096, session=session)

    with pytest.raises(ApiError) as raised:
        service.check("http://localhost/font.ttf")

    assert raised.value.error == "invalid_font_url"
    assert session.calls == []


def test_conditional_check_reports_unchanged_on_304(tmp_path: Path) -> None:
    session = FakeSession([FakeResponse(304)])
    service = FontSourceService(FilesystemBackend(settings(tmp_path)), max_size=4096, session=session)

    result = service.check("https://example.com/font.ttf", etag='"v1"')

    assert result["changed"] is False
    assert session.calls[0][2]["headers"]["If-None-Match"] == '"v1"'


def test_check_compares_changed_etag_without_downloading(tmp_path: Path) -> None:
    session = FakeSession([FakeResponse(200, {"ETag": '"v2"', "Content-Length": "123"})])
    service = FontSourceService(FilesystemBackend(settings(tmp_path)), max_size=4096, session=session)

    result = service.check("https://example.com/font.ttf", etag='"v1"')

    assert result["changed"] is True
    assert result["etag"] == '"v2"'
    assert len(session.calls) == 1


def test_update_writes_hash_versioned_local_font(tmp_path: Path) -> None:
    session = FakeSession([FakeResponse(200, {"ETag": '"v2"'}, TTF)])
    filesystem = FilesystemBackend(settings(tmp_path))
    service = FontSourceService(filesystem, max_size=4096, session=session)

    result = service.update("icons_44", "https://example.com/icons.ttf")

    assert result["path"].startswith("fonts/icons_44-")
    assert result["path"].endswith(".ttf")
    assert (filesystem.root / result["path"]).read_bytes() == TTF
    assert result["sha256"][:12] in result["path"]


def test_pin_bundled_mdi_writes_the_shipped_font_without_any_network_call(tmp_path: Path) -> None:
    session = FakeSession([])  # any use would raise IndexError - proves no request happened
    filesystem = FilesystemBackend(settings(tmp_path))
    service = FontSourceService(filesystem, max_size=4 * 1024 * 1024, session=session)

    result = service.pin_bundled_mdi("icons_mdi", "https://raw.githubusercontent.com/x/materialdesignicons-webfont.ttf")

    assert session.calls == []
    assert result["path"].startswith("fonts/icons_mdi-")
    assert result["path"].endswith(".ttf")
    assert (filesystem.root / result["path"]).read_bytes().startswith((b"\x00\x01\x00\x00", b"OTTO", b"true"))
    assert result["url"] == "https://raw.githubusercontent.com/x/materialdesignicons-webfont.ttf"


def test_update_api_uses_the_bundled_mdi_font_when_mdi_local_is_on(tmp_path: Path) -> None:
    configured = settings(tmp_path)
    configured = Settings(**{**configured.__dict__, "default_role": "editor", "mdi_local": True})
    app = create_app(configured, serve_frontend=False)
    app.state.font_sources.session = FakeSession([])  # network use would raise IndexError
    client = TestClient(app)

    response = client.post(
        "/api/v1/designer/font-sources/update",
        headers={"X-Remote-User-Id": "editor"},
        json={
            "id": "icons_mdi",
            "url": "https://raw.githubusercontent.com/Templarian/MaterialDesign-Webfont/master/fonts/materialdesignicons-webfont.ttf",
        },
    )

    assert response.status_code == 200
    assert response.json()["path"].startswith("fonts/icons_mdi-")
    assert app.state.font_sources.session.calls == []


def test_update_api_still_downloads_mdi_font_when_mdi_local_is_off(tmp_path: Path) -> None:
    configured = settings(tmp_path)
    configured = Settings(**{**configured.__dict__, "default_role": "editor", "mdi_local": False})
    app = create_app(configured, serve_frontend=False)
    app.state.font_sources.session = FakeSession([FakeResponse(200, {"ETag": '"v1"'}, TTF)])
    client = TestClient(app)

    response = client.post(
        "/api/v1/designer/font-sources/update",
        headers={"X-Remote-User-Id": "editor"},
        json={
            "id": "icons_mdi",
            "url": "https://raw.githubusercontent.com/Templarian/MaterialDesign-Webfont/master/fonts/materialdesignicons-webfont.ttf",
        },
    )

    assert response.status_code == 200
    assert len(app.state.font_sources.session.calls) == 1


def test_system_endpoint_reports_mdi_local_setting(tmp_path: Path) -> None:
    configured = settings(tmp_path)
    configured = Settings(**{**configured.__dict__, "mdi_local": False})
    client = TestClient(create_app(configured, serve_frontend=False))

    assert client.get("/api/v1/system").json()["mdi_local"] is False


def test_update_rejects_non_font_content(tmp_path: Path) -> None:
    session = FakeSession([FakeResponse(200, {}, b"not a font")])
    service = FontSourceService(FilesystemBackend(settings(tmp_path)), max_size=4096, session=session)

    with pytest.raises(ApiError) as raised:
        service.update("icons", "https://example.com/icons.ttf")

    assert raised.value.error == "invalid_font"


def test_update_api_denies_viewer_before_download(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), serve_frontend=False)
    app.state.font_sources.session = FakeSession([
        FakeResponse(200, {"ETag": '"v3"'}, TTF),
    ])
    client = TestClient(app)

    response = client.post(
        "/api/v1/designer/font-sources/update",
        headers={"X-Remote-User-Id": "editor"},
        json={"id": "icons_44", "url": "https://example.com/icons.ttf"},
    )

    assert response.status_code == 403  # default role remains viewer
    assert app.state.font_sources.session.calls == []


def test_update_api_is_available_with_asset_write_permission(tmp_path: Path) -> None:
    configured = settings(tmp_path)
    configured = Settings(**{**configured.__dict__, "default_role": "editor"})
    app = create_app(configured, serve_frontend=False)
    app.state.font_sources.session = FakeSession([
        FakeResponse(200, {"ETag": '"v3"'}, TTF),
    ])
    client = TestClient(app)

    response = client.post(
        "/api/v1/designer/font-sources/update",
        headers={"X-Remote-User-Id": "editor"},
        json={"id": "icons_44", "url": "https://example.com/icons.ttf"},
    )

    assert response.status_code == 200
    assert response.json()["path"].startswith("fonts/icons_44-")


def test_glyph_coverage_reports_available_and_missing_codepoints(tmp_path: Path, monkeypatch) -> None:
    filesystem = FilesystemBackend(settings(tmp_path))
    stored = filesystem.write_font_asset("icons.ttf", TTF)
    closed = []

    class FakeFont:
        def __init__(self, *_args, **_kwargs):
            pass

        def getBestCmap(self):
            return {0x41: "A", 0xF02DC: "mdi_home"}

        def close(self):
            closed.append(True)

    monkeypatch.setattr("backend.font_sources.TTFont", FakeFont)
    service = FontSourceService(filesystem, max_size=4096)

    result = service.glyph_coverage(stored["path"], [0x41, 0xF02DC, 0xF0335])

    assert result["available"] == [0x41, 0xF02DC]
    assert result["missing"] == [0xF0335]
    assert closed == [True]


def test_glyph_coverage_api_is_available_to_viewer(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), serve_frontend=False)
    app.state.font_sources.glyph_coverage = lambda path, codepoints: {
        "path": path,
        "available": codepoints,
        "missing": [],
        "available_count": len(codepoints),
        "missing_count": 0,
    }
    client = TestClient(app)

    response = client.post(
        "/api/v1/designer/fonts/glyph-coverage",
        headers={"X-Remote-User-Id": "viewer"},
        json={"path": "fonts/icons.ttf", "codepoints": [0xF02DC]},
    )

    assert response.status_code == 200
    assert response.json()["available"] == [0xF02DC]


def test_glyph_coverage_api_is_read_only_and_needs_no_ingress_identity(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), serve_frontend=False)
    app.state.font_sources.glyph_coverage = lambda path, codepoints: {
        "path": path,
        "available": codepoints,
        "missing": [],
        "available_count": len(codepoints),
        "missing_count": 0,
    }

    response = TestClient(app).post(
        "/api/v1/designer/fonts/glyph-coverage",
        json={"path": "fonts/icons.ttf", "codepoints": [0xF02DC]},
    )

    assert response.status_code == 200


def test_glyph_coverage_api_rejects_surrogate(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), serve_frontend=False))

    response = client.post(
        "/api/v1/designer/fonts/glyph-coverage",
        headers={"X-Remote-User-Id": "viewer"},
        json={"path": "fonts/icons.ttf", "codepoints": [0xD800]},
    )

    assert response.status_code == 422
    assert response.json()["error"] == "invalid_codepoint"
