from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.security import RateLimiter
from backend.settings import Settings, capabilities


def make_settings(
    tmp_path: Path,
    *,
    default_role: str = "viewer",
    user_roles: tuple[tuple[str, str], ...] = (),
    read_only: bool = False,
    api_limit: int = 240,
    write_limit: int = 60,
) -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "display.yaml").write_text(
        "esphome:\n  name: display\n", encoding="utf-8"
    )
    return Settings(
        profile="read_only" if read_only else "native_filesystem",
        read_only=read_only,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=default_role,
        user_roles=user_roles,
        api_rate_limit_per_minute=api_limit,
        write_rate_limit_per_minute=write_limit,
    )


def test_hierarchical_role_capabilities(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)

    assert capabilities(settings, "viewer")["configuration.read"]
    assert not capabilities(settings, "viewer")["configuration.write_draft"]
    assert capabilities(settings, "editor")["configuration.write_draft"]
    assert not capabilities(settings, "editor")["configuration.publish"]
    assert capabilities(settings, "publisher")["configuration.publish"]
    assert not capabilities(settings, "publisher")["audit.read"]
    assert capabilities(settings, "administrator")["audit.read"]


def test_read_only_profile_overrides_administrator_role(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, default_role="administrator", read_only=True)

    granted = capabilities(settings, "administrator")
    assert granted["configuration.read"]
    assert not granted["configuration.write_draft"]
    assert not granted["configuration.publish"]


def test_user_assignment_overrides_default_role(tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path,
        default_role="viewer",
        user_roles=(("editor-id", "editor"), ("admin-id", "administrator")),
    )

    assert settings.role_for("unknown") == "viewer"
    assert settings.role_for("editor-id") == "editor"
    assert settings.role_for("admin-id") == "administrator"


def test_settings_load_role_assignments_and_limits(tmp_path: Path, monkeypatch) -> None:
    options = tmp_path / "options.json"
    options.write_text(
        json.dumps(
            {
                "default_role": "editor",
                "user_roles": [{"user_id": "publisher-id", "role": "publisher"}],
                "api_rate_limit_per_minute": 500,
                "write_rate_limit_per_minute": 25,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ESPHOME_OPTIONS_PATH", str(options))
    monkeypatch.setenv("ESPHOME_CONFIG_ROOT", str(tmp_path / "esphome-loaded"))
    monkeypatch.setenv("ESPHOME_DATA_ROOT", str(tmp_path / "data-loaded"))

    settings = Settings.load()

    assert settings.default_role == "editor"
    assert settings.role_for("publisher-id") == "publisher"
    assert settings.role_for("unknown") == "editor"
    assert settings.api_rate_limit_per_minute == 500
    assert settings.write_rate_limit_per_minute == 25


def test_invalid_options_fail_closed(tmp_path: Path, monkeypatch) -> None:
    options = tmp_path / "invalid-options.json"
    options.write_text(
        json.dumps(
            {
                "profile": "unexpected",
                "default_role": "root",
                "api_rate_limit_per_minute": "broken",
                "write_rate_limit_per_minute": None,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ESPHOME_OPTIONS_PATH", str(options))

    settings = Settings.load()

    assert settings.profile == "read_only"
    assert settings.read_only is True
    assert settings.default_role == "viewer"
    assert settings.api_rate_limit_per_minute == 240
    assert settings.write_rate_limit_per_minute == 60


def test_rate_limiter_has_separate_write_budget() -> None:
    limiter = RateLimiter(read_limit=4, write_limit=2, window_seconds=60)

    assert limiter.check("user", write=True, now=0).allowed
    assert limiter.check("user", write=True, now=1).allowed
    denied = limiter.check("user", write=True, now=2)
    assert not denied.allowed
    assert denied.retry_after == 58
    assert limiter.check("user", write=True, now=61).allowed


def test_backend_enforces_roles_and_audits_denials(tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path,
        user_roles=(
            ("editor-id", "editor"),
            ("publisher-id", "publisher"),
            ("admin-id", "administrator"),
        ),
    )
    client = TestClient(create_app(settings, serve_frontend=False))
    draft_url = "/api/v1/configurations/display.yaml/draft"

    viewer_capabilities = client.get(
        "/api/v1/capabilities", headers={"X-Remote-User-Id": "unknown"}
    ).json()
    assert viewer_capabilities["role"] == "viewer"
    assert not viewer_capabilities["capabilities"]["configuration.write_draft"]
    assert client.put(
        draft_url,
        headers={"X-Remote-User-Id": "unknown"},
        json={"content": "esphome:\n  name: forbidden\n"},
    ).status_code == 403

    saved = client.put(
        draft_url,
        headers={"X-Remote-User-Id": "editor-id"},
        json={"content": "esphome:\n  name: changed\n"},
    )
    assert saved.status_code == 200

    active = client.get("/api/v1/configurations/display.yaml").json()
    denied = client.post(
        "/api/v1/configurations/display.yaml/publish",
        headers={"X-Remote-User-Id": "editor-id"},
        json={"expected_revision": active["revision"]},
    )
    assert denied.status_code == 403
    assert denied.json()["details"]["required_role"] == "publisher"
    assert not capabilities(settings, "publisher")["firmware.upload"]

    assert client.get(
        "/api/v1/audit", headers={"X-Remote-User-Id": "editor-id"}
    ).status_code == 403
    events = client.get(
        "/api/v1/audit", headers={"X-Remote-User-Id": "admin-id"}
    ).json()["events"]
    assert any(event["action"] == "configuration.draft.save" for event in events)
    assert any(event["action"] == "authorization.denied" for event in events)


def test_api_rate_limit_returns_stable_429(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, api_limit=2)
    client = TestClient(create_app(settings, serve_frontend=False))

    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/health").status_code == 200
    denied = client.get("/api/v1/health")
    assert denied.status_code == 429
    assert denied.json()["error"] == "rate_limit_exceeded"
    assert int(denied.headers["Retry-After"]) >= 1


def test_production_app_rejects_non_ingress_source(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ESPHOME_CONFIG_ROOT", str(tmp_path / "esphome"))
    monkeypatch.setenv("ESPHOME_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv("ESPHOME_OPTIONS_PATH", str(tmp_path / "missing-options.json"))
    (tmp_path / "esphome").mkdir()

    client = TestClient(create_app(serve_frontend=False))
    denied = client.get(
        "/api/v1/health", headers={"X-Remote-User-Id": "spoofed-admin"}
    )

    assert denied.status_code == 403
    assert denied.json()["error"] == "ingress_required"
    assert denied.headers["Cache-Control"] == "no-store"
