from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings

from .test_designer import project_with_button
from .test_help_assistant_loop import _text_response, _tool_use_response


def assistant_app_settings(
    tmp_path: Path,
    *,
    default_role: str = "administrator",
    assistant_mode: str = "enabled",
    assistant_api_key: str = "sk-test-" + "x" * 32,
) -> Settings:
    config_root = tmp_path / "esphome"
    config_root.mkdir(parents=True, exist_ok=True)
    return Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=default_role,
        mcp_mode="disabled",
        mcp_access="project_write",
        assistant_mode=assistant_mode,
        assistant_api_key=assistant_api_key,
    )


def _seed_project(settings: Settings) -> None:
    from backend.assistant_tools import AssistantToolService

    AssistantToolService(settings).projects.save(
        "display.lvgldesign", project_with_button(), None
    )


def test_assistant_ask_requires_administrator_role(tmp_path: Path) -> None:
    settings = assistant_app_settings(tmp_path, default_role="editor")
    _seed_project(settings)
    with TestClient(create_app(settings, serve_frontend=False)) as client:
        response = client.post(
            "/api/v1/assistant/ask",
            headers={"X-Remote-User-Id": "editor-user"},
            json={"project_name": "display.lvgldesign", "message": "hello"},
        )
    assert response.status_code == 403


def test_assistant_ask_unavailable_when_assistant_mode_disabled(tmp_path: Path) -> None:
    settings = assistant_app_settings(tmp_path, assistant_mode="disabled")
    _seed_project(settings)
    with TestClient(create_app(settings, serve_frontend=False)) as client:
        response = client.post(
            "/api/v1/assistant/ask",
            headers={"X-Remote-User-Id": "admin-user"},
            json={"project_name": "display.lvgldesign", "message": "hello"},
        )
    assert response.status_code == 403


def test_assistant_ask_unavailable_without_an_api_key(tmp_path: Path) -> None:
    settings = assistant_app_settings(tmp_path, assistant_api_key="")
    _seed_project(settings)
    with TestClient(create_app(settings, serve_frontend=False)) as client:
        response = client.post(
            "/api/v1/assistant/ask",
            headers={"X-Remote-User-Id": "admin-user"},
            json={"project_name": "display.lvgldesign", "message": "hello"},
        )
    assert response.status_code == 403


def test_assistant_ask_end_to_end_with_a_proposed_change_set(
    tmp_path: Path, monkeypatch
) -> None:
    import backend.help_assistant.loop as loop_module

    settings = assistant_app_settings(tmp_path)
    _seed_project(settings)

    from backend.assistant_tools import AssistantToolService

    revision = AssistantToolService(settings).projects.read("display.lvgldesign")[
        "revision"
    ]

    calls = {"count": 0}

    def fake_call(**_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return _tool_use_response(
                "propose_layout_change",
                {
                    "base_revision": revision,
                    "operations": [
                        {
                            "op": "add_widget",
                            "widget_id": "assistant_label",
                            "widget_type": "label",
                            "placement": {"x": 5, "y": 5},
                            "properties": {"text": "Hi"},
                        }
                    ],
                },
            )
        return _text_response("I added a label for you.")

    monkeypatch.setattr(loop_module, "call_messages_api", fake_call)

    with TestClient(create_app(settings, serve_frontend=False)) as client:
        response = client.post(
            "/api/v1/assistant/ask",
            headers={"X-Remote-User-Id": "admin-user"},
            json={
                "project_name": "display.lvgldesign",
                "message": "add a label",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"] == "I added a label for you."
    assert len(body["proposals"]) == 1
    assert body["proposals"][0]["tool"] == "propose_layout_change"
    assert body["proposals"][0]["preview"]["added_widget_ids"] == ["assistant_label"]
    assert body["tool_calls"] == [{"name": "propose_layout_change", "ok": True}]

    events = client_audit_events(settings)
    assert any(event["action"] == "assistant.ask" for event in events)

    change_set_id = body["proposals"][0]["change_set_id"]
    with TestClient(create_app(settings, serve_frontend=False)) as client:
        apply_response = client.post(
            f"/api/v1/assistant/changesets/{change_set_id}/apply",
            headers={"X-Remote-User-Id": "admin-user"},
        )
    assert apply_response.status_code == 200
    assert apply_response.json()["status"] == "applied"
    assert any(
        event["action"] == "assistant.apply" for event in client_audit_events(settings)
    )


def test_assistant_ask_rejects_project_name_not_belonging_to_this_request(
    tmp_path: Path, monkeypatch
) -> None:
    """The request body's project_name is the only project the model can
    ever touch for that request - proven end to end through the router, not
    just at the scope-builder unit level."""
    import backend.help_assistant.loop as loop_module
    from backend.assistant_tools import AssistantToolService

    settings = assistant_app_settings(tmp_path)
    _seed_project(settings)
    other = AssistantToolService(settings)
    other_created = other.projects.save("secret.lvgldesign", project_with_button(), None)

    calls = {"count": 0}

    def fake_call(**_kwargs):
        calls["count"] += 1
        if calls["count"] > 1:
            return _text_response("done")
        # A confused/compromised model tries to smuggle a different
        # project_name into the tool call arguments; the schema does not
        # even offer that parameter, and the handler ignores it if sent.
        return _tool_use_response(
            "propose_layout_change",
            {
                "project_name": "secret.lvgldesign",
                "base_revision": other_created["revision"],
                "operations": [
                    {
                        "op": "add_widget",
                        "widget_id": "smuggled",
                        "widget_type": "label",
                        "placement": {"x": 1, "y": 1},
                        "properties": {"text": "x"},
                    }
                ],
            },
        )

    monkeypatch.setattr(loop_module, "call_messages_api", fake_call)

    with TestClient(create_app(settings, serve_frontend=False)) as client:
        response = client.post(
            "/api/v1/assistant/ask",
            headers={"X-Remote-User-Id": "admin-user"},
            json={"project_name": "display.lvgldesign", "message": "hi"},
        )

    assert response.status_code == 200
    # The proposal landed against display.lvgldesign (base_revision only
    # matches that project); secret.lvgldesign was never touched.
    assert other.projects.read("secret.lvgldesign")["revision"] == other_created[
        "revision"
    ]


def client_audit_events(settings: Settings) -> list[dict]:
    from backend.audit import AuditStore

    return AuditStore(settings.data_root).recent()
