from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.assistant_tools.changesets import ChangeSetStore
from backend.audit import AuditStore
from backend.project_revisions import ProjectRevisionStore
from backend.workflow import WorkflowStore

from .test_security import make_settings


def test_an_unexpected_error_is_a_json_500_with_a_reference(tmp_path: Path) -> None:
    app = create_app(make_settings(tmp_path), serve_frontend=False)

    def broken() -> dict:
        raise RuntimeError("boom")

    app.add_api_route("/api/v1/broken", broken)
    response = TestClient(app, raise_server_exceptions=False).get("/api/v1/broken")

    assert response.status_code == 500
    body = response.json()
    assert body["error"] == "internal_error"
    assert len(body["details"]["reference"]) == 8
    assert "boom" not in response.text


def test_a_validation_error_does_not_echo_the_request(tmp_path: Path) -> None:
    client = TestClient(create_app(make_settings(tmp_path), serve_frontend=False),
                        headers={"X-Remote-User-Id": "admin"})

    response = client.post("/api/v1/configurations/display.yaml/publish",
                           json={"expected_revision": "geheim-123"})

    assert response.status_code == 422
    assert "geheim-123" not in response.text
    assert set(response.json()["details"]["errors"][0]) == {"type", "loc", "msg"}


def test_a_failing_audit_write_is_logged_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    store = AuditStore(tmp_path)

    def locked():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store, "_connect", locked)
    with caplog.at_level(logging.WARNING, logger="backend.audit"):
        store.record(user_id="u", action="configuration.publish", configuration="a.yaml",
                     old_revision=None, new_revision=None, result="success")

    assert "could not be written" in caplog.text


def test_a_save_succeeds_although_the_audit_write_fails(tmp_path: Path, monkeypatch) -> None:
    def locked(self):
        raise sqlite3.OperationalError("database is locked")

    settings = make_settings(tmp_path, default_role="administrator")
    client = TestClient(create_app(settings, serve_frontend=False),
                        headers={"X-Remote-User-Id": "admin"})
    monkeypatch.setattr(AuditStore, "_connect", locked)

    saved = client.put("/api/v1/configurations/display.yaml/draft",
                       json={"content": "esphome:\n  name: draft\n"})

    assert saved.status_code == 200


def test_audit_rows_are_pruned_to_the_retention_limit(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("backend.audit._PRUNE_EVERY", 1)
    store = AuditStore(tmp_path, retention_rows=3)
    for index in range(10):
        store.record(user_id="u", action="x", configuration=f"{index}.yaml",
                     old_revision=None, new_revision=None, result="success")

    events = store.recent(100)

    assert len(events) == 3
    assert [event["configuration"] for event in events] == ["9.yaml", "8.yaml", "7.yaml"]


@pytest.mark.parametrize("factory", [AuditStore, WorkflowStore, ProjectRevisionStore, ChangeSetStore])
def test_stores_use_write_ahead_logging(tmp_path: Path, factory) -> None:
    store = factory(tmp_path)

    with closing(sqlite3.connect(store.path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
