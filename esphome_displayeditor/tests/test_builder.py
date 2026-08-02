from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.builder.adapter import (
    BuilderAdapterError,
    BuilderResponse,
    BuilderServerInfo,
    DeviceBuilderWebSocketAdapter,
)
from backend.builder.compatibility import evaluate
from backend.builder.manager import BuilderManager
from backend.settings import Settings


class FakeBuilderAdapter:
    def __init__(self, *, esphome_version: str = "2026.7.2") -> None:
        self.info = BuilderServerInfo("1.0.0", esphome_version, False)
        self.commands: list[tuple[str, dict]] = []
        self.job = {
            "job_id": "job-1",
            "configuration": "display.yaml",
            "job_type": "compile",
            "status": "queued",
        }
        self.jobs: list[dict] = []

    async def probe(self) -> BuilderServerInfo:
        return self.info

    async def command(self, command: str, args: dict | None = None, **_kwargs) -> BuilderResponse:
        payload = args or {}
        self.commands.append((command, payload))
        events: tuple[dict, ...] = ()
        if command == "devices/list":
            result = []
        elif command == "devices/validate":
            result = None
            events = (
                {"event": "output", "data": "INFO Configuration is valid"},
                {"event": "result", "data": {"success": True, "code": 0}},
            )
        elif command in {"firmware/compile", "firmware/install"}:
            result = {
                **self.job,
                "job_id": f"job-{len(self.jobs) + 1}",
                "job_type": command.rsplit("/", 1)[1],
                "status": "queued",
            }
            self.job = result
            self.jobs.append(result)
        elif command == "firmware/get_jobs":
            result = self.jobs
        elif command == "firmware/get_job":
            result = next(
                (job for job in self.jobs if job["job_id"] == payload.get("job_id")),
                None,
            )
        elif command == "firmware/cancel":
            result = None
        else:
            raise AssertionError(f"unexpected command {command}")
        return BuilderResponse(self.info, result, events)

    async def follow_jobs(self, callback) -> None:
        await callback({"event": "snapshot", "data": self.job})


def make_settings(tmp_path: Path, *, access_level: str = "write_with_builder") -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "display.yaml").write_text(
        "esphome:\n  name: display\n", encoding="utf-8", newline=""
    )
    return Settings(
        access_level=access_level,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="administrator",
        runtime_provider="disabled",
        builder_url="http://esphome-builder:6052",
    )


def test_compatibility_matrix_is_fail_closed() -> None:
    assert evaluate("1.0.0", "2026.6.0").compatible
    assert evaluate("1.0.0", "2026.8.99").compatible
    assert not evaluate("1.0.0", "2026.9.0").compatible
    assert not evaluate("1.0.0", "dev").compatible
    assert not evaluate("", "2026.7.0").compatible


def test_builder_url_is_local_and_has_fixed_ws_path() -> None:
    adapter = DeviceBuilderWebSocketAdapter("http://esphome-builder:6052")
    assert adapter.ws_url == "ws://esphome-builder:6052/ws"
    with pytest.raises(BuilderAdapterError):
        DeviceBuilderWebSocketAdapter("https://example.com")
    with pytest.raises(BuilderAdapterError):
        DeviceBuilderWebSocketAdapter("http://127.0.0.1:6052")
    with pytest.raises(BuilderAdapterError):
        DeviceBuilderWebSocketAdapter("http://esphome-builder:6052/arbitrary")


def test_builder_api_capabilities_jobs_validation_and_audit(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    headers = {"X-Remote-User-Id": "admin"}
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        system = client.get("/api/v1/system", headers=headers).json()
        assert system["backends"]["configuration"] == "filesystem"
        assert system["backends"]["builder"] == "ready"
        capability_data = client.get("/api/v1/capabilities", headers=headers).json()
        assert capability_data["capabilities"]["configuration.validate_esphome"]
        assert capability_data["capabilities"]["firmware.compile"]
        assert capability_data["capabilities"]["firmware.upload"]

        validation = client.post(
            "/api/v1/configurations/display.yaml/validate", headers=headers
        )
        assert validation.status_code == 200
        assert validation.json()["valid"] is True
        assert validation.json()["revision"].startswith("sha256:")

        compile_result = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        assert compile_result.status_code == 202
        assert compile_result.json()["job"]["job_id"] == "job-1"
        assert client.post(
            "/api/v1/configurations/display.yaml/install",
            headers=headers,
            json={"port": "OTA", "confirmed": False},
        ).status_code == 409
        adapter.jobs[0]["status"] = "completed"
        assert client.post(
            "/api/v1/configurations/display.yaml/install",
            headers=headers,
            json={"port": "OTA", "confirmed": True},
        ).status_code == 202
        assert client.get("/api/v1/jobs", headers=headers).json()["jobs"][0]["job_id"] == "job-1"
        assert client.get("/api/v1/jobs/job-1", headers=headers).status_code == 200
        assert client.post("/api/v1/jobs/job-1/cancel", headers=headers).status_code == 204

        events = client.get("/api/v1/audit", headers=headers).json()["events"]
        compile_event = next(item for item in events if item["action"] == "firmware.compile")
        assert compile_event["job_id"] == "job-1"
        assert compile_event["esphome_version"] == "2026.7.2"

    assert ("devices/list", {}) in adapter.commands
    assert ("firmware/get_jobs", {}) in adapter.commands
    assert ("devices/validate", {"configuration": "display.yaml", "show_secrets": False}) in adapter.commands
    assert ("firmware/install", {"configuration": "display.yaml", "port": "OTA"}) in adapter.commands


def test_compile_requires_a_current_successful_validation(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    headers = {"X-Remote-User-Id": "admin"}
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        missing = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        assert missing.status_code == 409
        assert missing.json()["error"] == "validation_required"

        assert client.post(
            "/api/v1/configurations/display.yaml/validate", headers=headers
        ).status_code == 200
        (settings.config_root / "display.yaml").write_text(
            "esphome:\n  name: changed\n", encoding="utf-8", newline=""
        )
        changed = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        assert changed.status_code == 409
        assert changed.json()["error"] == "validation_revision_mismatch"
    assert not any(command == "firmware/compile" for command, _args in adapter.commands)


def test_idempotency_replays_once_and_other_parallel_jobs_are_rejected(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    adapter = FakeBuilderAdapter()
    manager = BuilderManager(settings, adapter=adapter)  # type: ignore[arg-type]
    headers = {
        "X-Remote-User-Id": "admin",
        "Idempotency-Key": "compile-request-0001",
    }
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        assert client.post(
            "/api/v1/configurations/display.yaml/validate", headers=headers
        ).status_code == 200
        first = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        replay = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        blocked = client.post(
            "/api/v1/configurations/display.yaml/compile",
            headers={**headers, "Idempotency-Key": "compile-request-0002"},
        )
        revision = first.json()["revision"]
        assert client.put(
            "/api/v1/configurations/display.yaml/draft",
            headers=headers,
            json={"content": "esphome:\n  name: published-too-early\n"},
        ).status_code == 200
        publish_blocked = client.post(
            "/api/v1/configurations/display.yaml/publish",
            headers=headers,
            json={"expected_revision": revision},
        )
        conflict = client.post(
            "/api/v1/configurations/display.yaml/install",
            headers=headers,
            json={"port": "OTA", "confirmed": True},
        )
    assert first.status_code == 202
    assert first.json()["idempotent_replay"] is False
    assert replay.status_code == 202
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["job"] == first.json()["job"]
    assert blocked.status_code == 409
    assert blocked.json()["error"] == "job_already_running"
    assert publish_blocked.status_code == 409
    assert publish_blocked.json()["error"] == "job_already_running"
    assert (settings.config_root / "display.yaml").read_text(encoding="utf-8") == (
        "esphome:\n  name: display\n"
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "idempotency_conflict"
    assert sum(command == "firmware/compile" for command, _args in adapter.commands) == 1


def test_idempotency_survives_an_application_restart(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    headers = {
        "X-Remote-User-Id": "admin",
        "Idempotency-Key": "restart-safe-request",
    }
    first_adapter = FakeBuilderAdapter()
    with TestClient(
        create_app(
            settings,
            serve_frontend=False,
            builder_manager=BuilderManager(settings, adapter=first_adapter),  # type: ignore[arg-type]
        )
    ) as client:
        client.post("/api/v1/configurations/display.yaml/validate", headers=headers)
        first = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        assert first.status_code == 202

    second_adapter = FakeBuilderAdapter()
    with TestClient(
        create_app(
            settings,
            serve_frontend=False,
            builder_manager=BuilderManager(settings, adapter=second_adapter),  # type: ignore[arg-type]
        )
    ) as client:
        replay = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
    assert replay.status_code == 202
    assert replay.json()["idempotent_replay"] is True
    assert not any(command == "firmware/compile" for command, _args in second_adapter.commands)


def test_unknown_builder_version_keeps_build_capabilities_disabled(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    manager = BuilderManager(
        settings, adapter=FakeBuilderAdapter(esphome_version="2027.1.0")  # type: ignore[arg-type]
    )
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        data = client.get(
            "/api/v1/capabilities", headers={"X-Remote-User-Id": "admin"}
        ).json()
        assert data["capabilities"]["configuration.read"] is True
        assert data["capabilities"]["firmware.compile"] is False
        assert client.post(
            "/api/v1/configurations/display.yaml/compile",
            headers={"X-Remote-User-Id": "admin"},
        ).status_code == 403


def test_publisher_can_validate_but_cannot_compile_or_install(tmp_path: Path) -> None:
    base = make_settings(tmp_path)
    settings = Settings(**{**base.__dict__, "default_role": "publisher"})
    manager = BuilderManager(settings, adapter=FakeBuilderAdapter())  # type: ignore[arg-type]
    headers = {"X-Remote-User-Id": "publisher"}
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        assert client.post(
            "/api/v1/configurations/display.yaml/validate", headers=headers
        ).status_code == 200
        compile_response = client.post(
            "/api/v1/configurations/display.yaml/compile", headers=headers
        )
        install_response = client.post(
            "/api/v1/configurations/display.yaml/install",
            headers=headers,
            json={"port": "OTA", "confirmed": True},
        )
    assert compile_response.status_code == 403
    assert compile_response.json()["details"]["required_role"] == "installer"
    assert install_response.status_code == 403


def test_native_only_reports_configuration_backend_disabled(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, access_level="none")
    manager = BuilderManager(settings, adapter=FakeBuilderAdapter())  # type: ignore[arg-type]
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        system = client.get("/api/v1/system").json()
    assert system["backends"]["configuration"] == "disabled"


def test_request_size_limit_is_enforced_before_body_parsing(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    settings = Settings(**{**settings.__dict__, "request_max_size": 32})
    manager = BuilderManager(settings, adapter=FakeBuilderAdapter())  # type: ignore[arg-type]
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        response = client.put(
            "/api/v1/configurations/display.yaml/draft",
            headers={"X-Remote-User-Id": "admin"},
            json={"content": "x" * 64},
        )
    assert response.status_code == 413
    assert response.json()["error"] == "request_too_large"


def test_job_websocket_replays_snapshot_and_requests_resync(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ESPHOME_ALLOW_ANONYMOUS_WRITE", "1")
    settings = make_settings(tmp_path)
    manager = BuilderManager(settings, adapter=FakeBuilderAdapter())  # type: ignore[arg-type]
    with TestClient(
        create_app(settings, serve_frontend=False, builder_manager=manager)
    ) as client:
        with client.websocket_connect("/api/v1/jobs/events") as websocket:
            status = websocket.receive_json()
            snapshot = websocket.receive_json()
            resync = websocket.receive_json()
    assert status["type"] == "builder_status"
    assert snapshot == {
        "type": "builder_job",
        "event": "snapshot",
        "data": manager.adapter.job,
    }
    assert resync["type"] == "resync_required"
