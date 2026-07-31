from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.runtime.manager import DeviceManager
from backend.runtime.native_client import AioEsphomeClient
from backend.runtime.registry import DeviceConfig, DeviceRegistry
from backend.runtime.secrets import SecretStore
from backend.settings import Settings
from backend.errors import ApiError


VALID_KEY = base64.b64encode(bytes(range(32))).decode()


@dataclass
class FakeInfo:
    name: str = "test-device"
    esphome_version: str = "2026.7.0"


@dataclass
class FakeSensorInfo:
    key: int = 7
    name: str = "Temperature"
    object_id: str = "temperature"


@dataclass
class FakeSensorState:
    key: int = 7
    state: float = 21.5


class FakeClient:
    instances: list["FakeClient"] = []

    def __init__(self, config, key: str) -> None:
        assert key == VALID_KEY
        self.config = config
        self.on_stop = None
        self.state_callback = None
        self.log_callback = None
        self.api_version = "1.12"
        self.disconnected = False
        self.instances.append(self)

    async def connect(self, on_stop) -> None:
        self.on_stop = on_stop

    async def snapshot(self):
        return FakeInfo(), [FakeSensorInfo()], []

    def subscribe_states(self, callback) -> None:
        self.state_callback = callback

    def subscribe_logs(self, callback):
        self.log_callback = callback
        return lambda: None

    async def disconnect(self) -> None:
        self.disconnected = True


def make_settings(tmp_path: Path, *, role: str = "administrator") -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    return Settings(
        profile="native_filesystem",
        read_only=False,
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=role,
        runtime_provider="native",
    )


def test_registry_and_secret_store_are_separate(tmp_path: Path) -> None:
    registry = DeviceRegistry(tmp_path)
    secrets = SecretStore(tmp_path)
    registry.upsert(
        {
            "id": "display-1",
            "name": "Display 1",
            "host": "192.168.1.42",
            "port": 6053,
            "encryption_key_ref": "display-1",
        }
    )
    secrets.set("display-1", VALID_KEY)

    registry_text = registry.path.read_text(encoding="utf-8")
    secret_text = secrets.path.read_text(encoding="utf-8")
    assert VALID_KEY not in registry_text
    assert VALID_KEY in secret_text
    assert registry.get("display-1").host == "192.168.1.42"
    assert secrets.has("display-1")


def test_real_aioesphomeapi_adapter_constructs_encrypted_client() -> None:
    async def scenario() -> None:
        client = AioEsphomeClient(
            DeviceConfig(
                id="display-1",
                name="Display 1",
                host="192.0.2.10",
                port=6053,
                encryption_key_ref="display-1",
            ),
            VALID_KEY,
        )
        assert client.api_version is None
        await client.disconnect()

    asyncio.run(scenario())


def test_device_manager_connects_caches_and_marks_disconnect(tmp_path: Path) -> None:
    async def scenario() -> None:
        FakeClient.instances.clear()
        registry = DeviceRegistry(tmp_path)
        secrets = SecretStore(tmp_path)
        registry.upsert(
            {
                "id": "display-1",
                "name": "Display 1",
                "host": "display-1.local",
                "port": 6053,
                "encryption_key_ref": "display-1",
            }
        )
        secrets.set("display-1", VALID_KEY)
        manager = DeviceManager(registry, secrets, client_factory=FakeClient)
        await manager.start()
        for _ in range(20):
            if manager.get_device("display-1")["status"] == "ready":
                break
            await asyncio.sleep(0)
        assert manager.get_device("display-1")["status"] == "ready"
        assert manager.get_info("display-1")["name"] == "test-device"
        assert manager.get_entities("display-1")[0]["type"] == "fake_sensor"

        client = FakeClient.instances[0]
        client.state_callback(FakeSensorState())
        client.log_callback(SimpleNamespace(message=b"\x1b[31mhello\x1b[0m\n", level="INFO"))
        assert manager.get_states("display-1")[0]["state"] == 21.5
        assert manager.get_logs("display-1", 10)[0]["message"] == "hello"

        await client.on_stop(False)
        for _ in range(20):
            if manager.get_device("display-1")["status"] == "disconnected":
                break
            await asyncio.sleep(0)
        assert manager.get_device("display-1")["status"] == "disconnected"
        assert manager.get_states("display-1")[0]["available"] is False
        await asyncio.sleep(1.05)
        for _ in range(20):
            if len(FakeClient.instances) >= 2 and manager.get_device("display-1")["status"] == "ready":
                break
            await asyncio.sleep(0)
        assert len(FakeClient.instances) >= 2
        assert manager.get_device("display-1")["status"] == "ready"
        await manager.stop()

    asyncio.run(scenario())


def test_device_api_is_allow_listed_role_checked_and_never_returns_key(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    manager = DeviceManager(
        DeviceRegistry(settings.data_root),
        SecretStore(settings.data_root),
        enabled=True,
        client_factory=FakeClient,
    )
    client = TestClient(
        create_app(settings, serve_frontend=False, runtime_manager=manager)
    )
    headers = {"X-Remote-User-Id": "admin"}
    body = {
        "id": "display-1",
        "name": "Display 1",
        "host": "192.168.1.42",
        "port": 6053,
        "encryption_key_ref": "display-1",
    }

    created = client.post("/api/v1/admin/devices", headers=headers, json=body)
    assert created.status_code == 201
    assert created.json()["has_encryption_key"] is False
    saved = client.put(
        "/api/v1/admin/device-secrets/display-1",
        headers=headers,
        json={"encryption_key": VALID_KEY},
    )
    assert saved.status_code == 204

    listed = client.get("/api/v1/devices", headers=headers)
    assert listed.status_code == 200
    encoded = json.dumps(listed.json())
    assert VALID_KEY not in encoded
    assert listed.json()["devices"][0]["has_encryption_key"] is True
    assert client.get("/api/v1/devices/not-configured", headers=headers).status_code == 404


def test_viewer_cannot_manage_devices(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, role="viewer")
    client = TestClient(create_app(settings, serve_frontend=False))
    response = client.post(
        "/api/v1/admin/devices",
        headers={"X-Remote-User-Id": "viewer"},
        json={
            "id": "display-1",
            "name": "Display 1",
            "host": "192.168.1.42",
            "port": 6053,
            "encryption_key_ref": "display-1",
        },
    )
    assert response.status_code == 403
    assert response.json()["details"]["required_role"] == "administrator"


def test_local_development_websocket_receives_initial_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ESPHOME_ALLOW_ANONYMOUS_WRITE", "1")
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings, serve_frontend=False)) as client:
        with client.websocket_connect("/api/v1/devices/events") as websocket:
            message = websocket.receive_json()
    assert message == {"type": "devices", "devices": []}


def test_connection_errors_do_not_log_secret(tmp_path: Path, caplog) -> None:
    class InvalidEncryptionKeyAPIError(Exception):
        pass

    class FailingClient(FakeClient):
        async def connect(self, on_stop) -> None:
            raise InvalidEncryptionKeyAPIError(f"invalid key: {VALID_KEY}")

    async def scenario() -> None:
        registry = DeviceRegistry(tmp_path)
        secrets = SecretStore(tmp_path)
        registry.upsert(
            {
                "id": "display-1",
                "name": "Display 1",
                "host": "192.168.1.42",
                "port": 6053,
                "encryption_key_ref": "display-1",
            }
        )
        secrets.set("display-1", VALID_KEY)
        manager = DeviceManager(registry, secrets, client_factory=FailingClient)
        await manager.start()
        for _ in range(20):
            if manager.get_device("display-1")["status"] == "auth_failed":
                break
            await asyncio.sleep(0)
        assert manager.get_device("display-1")["last_error"] == "invalid_encryption_key"
        await manager.stop()

    asyncio.run(scenario())
    assert VALID_KEY not in caplog.text


def test_registry_rejects_public_and_non_local_targets(tmp_path: Path) -> None:
    registry = DeviceRegistry(tmp_path)
    base = {
        "id": "display-1",
        "name": "Display 1",
        "port": 6053,
        "encryption_key_ref": "display-1",
    }
    for host in ("8.8.8.8", "example.com", "localhost"):
        with pytest.raises(ApiError) as exc:
            registry.upsert({**base, "host": host})
        assert exc.value.error == "invalid_device_host"


def test_registry_accepts_private_and_local_targets(tmp_path: Path) -> None:
    registry = DeviceRegistry(tmp_path)
    for index, host in enumerate(("192.168.1.42", "display.local", "display"), 1):
        device = registry.upsert(
            {
                "id": f"display-{index}",
                "name": f"Display {index}",
                "host": host,
                "port": 6053,
                "encryption_key_ref": f"display-{index}",
            }
        )
        assert device.host == host
