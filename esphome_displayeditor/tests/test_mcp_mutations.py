from __future__ import annotations

from contextlib import closing
from pathlib import Path
import json
import sqlite3

import pytest

from backend.assistant_tools import AssistantToolService
from backend.assistant_tools.changesets import ChangeSetStore
from backend.assistant_tools.limits import (
    MCP_APPLIED_CHANGESET_RETENTION_SECONDS,
    MCP_CHANGESET_TTL_SECONDS,
    MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS,
)
from backend.assistant_tools.placement import PlacementService
from backend.errors import ApiError
from backend.settings import Settings

from .test_designer import project_with_button


def write_settings(tmp_path: Path, *, mcp_access: str = "project_write") -> Settings:
    return Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
        mcp_mode="lan",
        mcp_access=mcp_access,
        mcp_access_token="test-token-" + "x" * 32,
    )


def test_changeset_proposal_apply_and_idempotent_retry(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)
    proposed = service.propose_project(
        "display.lvgldesign",
        created["revision"],
        [
            {
                "op": "add_widget",
                "widget_id": "status_label",
                "widget_type": "label",
                "surface": "root",
                "placement": {"x": 160, "y": 20, "width": 140, "height": 24},
                "properties": {"text": "Ready"},
            }
        ],
        identity="mcp:lan",
    )

    unchanged = service.projects.read("display.lvgldesign")
    assert unchanged["revision"] == created["revision"]
    assert {item["id"] for item in unchanged["project"]["widgets"]} == {"button_1"}
    assert proposed["status"] == "pending"
    assert proposed["preview"]["added_widget_ids"] == ["status_label"]

    applied = service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert applied["status"] == "applied"
    assert applied["idempotent"] is False
    stored = service.projects.read("display.lvgldesign")
    assert stored["revision"] == applied["applied_revision"]
    assert {item["id"] for item in stored["project"]["widgets"]} == {
        "button_1",
        "status_label",
    }

    retry = service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert retry["idempotent"] is True
    assert retry["applied_revision"] == applied["applied_revision"]
    actions = [entry["action"] for entry in service.audit.recent()]
    assert "mcp.project.propose" in actions
    assert "mcp.changeset.apply" in actions

    versions = service.projects.revisions.list("display.lvgldesign")
    assert versions[0]["origin"] == "mcp"
    assert versions[0]["actor"] == "mcp:lan"
    assert versions[0]["revision"] == applied["applied_revision"]
    # The idempotent retry writes nothing, so it must not add a version either.
    assert len(versions) == 2


def test_changeset_apply_rejects_a_newer_project_revision(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    created = service.projects.save("display.lvgldesign", project, None)
    proposed = service.propose_project(
        "display.lvgldesign",
        created["revision"],
        [
            {
                "op": "update_widget",
                "widget_id": "button_1",
                "properties": {"text": "From MCP"},
            }
        ],
        identity="mcp:lan",
    )
    project["widgets"][0]["properties"]["text"] = "From UI"
    newer = service.projects.save("display.lvgldesign", project, created["revision"])

    with pytest.raises(ApiError) as raised:
        service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")

    assert raised.value.error == "revision_conflict"
    assert service.projects.read("display.lvgldesign")["revision"] == newer["revision"]


def test_read_only_mcp_cannot_create_changesets(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path, mcp_access="read_only"))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    with pytest.raises(ApiError) as raised:
        service.propose_project(
            "display.lvgldesign",
            created["revision"],
            [
                {
                    "op": "update_widget",
                    "widget_id": "button_1",
                    "hidden": True,
                }
            ],
            identity="mcp:lan",
        )

    assert raised.value.error == "mcp_write_disabled"


def test_project_binding_proposal_is_validated_and_applied(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    project["entities"] = [
        {
            "domain": "switch",
            "id": "heater",
            "readable": True,
            "writable": True,
            "data_type": "boolean",
            "trigger": "on_state",
            "commands": ["turn_on", "turn_off", "toggle"],
        }
    ]
    created = service.projects.save("display.lvgldesign", project, None)

    proposed = service.propose_project_bindings(
        "display.lvgldesign",
        created["revision"],
        [
            {
                "op": "set_project_binding",
                "binding_id": "heater_binding",
                "direction": "bidirectional",
                "entity_domain": "switch",
                "entity_id": "heater",
                "entity_command": "toggle",
                "widget_id": "button_1",
                "widget_property": "checked",
                "widget_event": "value",
            }
        ],
        identity="mcp:lan",
    )

    assert service.projects.read("display.lvgldesign")["project"]["bindings"] == []
    assert proposed["preview"]["added_binding_ids"] == ["heater_binding"]
    service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    binding = service.projects.read("display.lvgldesign")["project"]["bindings"][0]
    assert binding["source"] == {
        "domain": "switch",
        "id": "heater",
        "command": "toggle",
    }
    assert binding["target"]["widget_id"] == "button_1"
    assert "mcp.binding.propose" in [entry["action"] for entry in service.audit.recent()]


def test_project_binding_proposal_rejects_incompatible_or_custom_binding(
    tmp_path: Path,
) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    project["entities"] = [
        {
            "domain": "sensor",
            "id": "temperature",
            "readable": True,
            "writable": False,
            "data_type": "number",
            "trigger": "on_value",
            "commands": [],
        }
    ]
    project["bindings"] = [
        {
            "id": "imported_action",
            "kind": "custom_yaml",
            "raw_action": {"lvgl.widget.show": "button_1"},
        }
    ]
    created = service.projects.save("display.lvgldesign", project, None)

    with pytest.raises(ApiError) as incompatible:
        service.propose_project_bindings(
            "display.lvgldesign",
            created["revision"],
            [
                {
                    "op": "set_project_binding",
                    "binding_id": "bad",
                    "direction": "entity_to_widget",
                    "entity_domain": "sensor",
                    "entity_id": "temperature",
                    "widget_id": "button_1",
                    "widget_property": "checked",
                }
            ],
            identity="mcp:lan",
        )
    assert incompatible.value.error == "invalid_project"

    with pytest.raises(ApiError) as protected:
        service.propose_project_bindings(
            "display.lvgldesign",
            created["revision"],
            [{"op": "remove_project_binding", "binding_id": "imported_action"}],
            identity="mcp:lan",
        )
    assert protected.value.error == "protected_custom_binding"


def test_viewer_binding_sidecar_uses_dual_revisions_and_idempotent_apply(
    tmp_path: Path,
) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    project["widgets"][0].update(
        {
            "id": "temperature_label",
            "widget_type": "label",
            "properties": {"text": "--"},
        }
    )
    created = service.projects.save("display.lvgldesign", project, None)
    service.device_registry.upsert(
        {
            "id": "display-1",
            "name": "Display 1",
            "host": "192.0.2.10",
            "port": 6053,
            "encryption_key_ref": "display-secret",
        }
    )

    proposed = service.propose_viewer_bindings(
        "display.lvgldesign",
        created["revision"],
        None,
        [
            {
                "op": "set_viewer_binding",
                "widget_id": "temperature_label",
                "target": "text",
                "device_id": "display-1",
                "entity_id": "fake_sensor:7",
                "value_format": "{state:.1f} °C",
                "fallback": "--",
                "stale_after": 30,
            }
        ],
        identity="mcp:lan",
    )

    assert proposed["target_kind"] == "viewer_bindings"
    assert service.viewer_bindings.read("display.lvgldesign")["revision"] is None
    applied = service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert applied["idempotent"] is False
    viewer = service.read_project("display.lvgldesign", "viewer_bindings")
    assert viewer["viewer_binding_revision"] == applied["applied_revision"]
    assert viewer["viewer_bindings"][0]["entity_id"] == "fake_sensor:7"
    assert service.apply_changeset(
        proposed["change_set_id"], identity="mcp:lan"
    )["idempotent"] is True


def test_viewer_binding_apply_rejects_a_concurrent_sidecar_change(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    project["widgets"][0].update(
        {"id": "temperature_label", "widget_type": "label", "properties": {"text": "--"}}
    )
    created = service.projects.save("display.lvgldesign", project, None)
    service.device_registry.upsert(
        {
            "id": "display-1",
            "name": "Display 1",
            "host": "192.0.2.10",
            "port": 6053,
            "encryption_key_ref": "display-secret",
        }
    )
    proposed = service.propose_viewer_bindings(
        "display.lvgldesign",
        created["revision"],
        None,
        [
            {
                "op": "set_viewer_binding",
                "widget_id": "temperature_label",
                "target": "text",
                "device_id": "display-1",
                "entity_id": "fake_sensor:7",
            }
        ],
        identity="mcp:lan",
    )
    service.viewer_bindings.save(
        "display.lvgldesign",
        [
            {
                "widget_id": "temperature_label",
                "target": "text",
                "device_id": "display-1",
                "entity_id": "fake_sensor:8",
            }
        ],
        None,
    )

    with pytest.raises(ApiError) as conflict:
        service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert conflict.value.error == "revision_conflict"
    assert conflict.value.details["target"] == "viewer_bindings"


def test_yaml_configuration_import_creates_project_only_on_apply(tmp_path: Path) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    source = settings.config_root / "panel.yaml"
    source.write_text(
        """lvgl:
  displays: [main_display]
  widgets:
    - label:
        id: status_label
        text: Ready
""",
        encoding="utf-8",
    )
    service = AssistantToolService(settings)
    configuration = service.read_configuration("panel.yaml")

    proposed = service.propose_project_import(
        "panel.yaml",
        configuration["revision"],
        "panel.lvgldesign",
        identity="mcp:lan",
    )

    assert proposed["target_kind"] == "project_create"
    assert service.list_projects()["count"] == 0
    applied = service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert applied["idempotent"] is False
    created = service.projects.read("panel.lvgldesign")
    assert created["project"]["widgets"][0]["id"] == "status_label"
    assert service.apply_changeset(
        proposed["change_set_id"], identity="mcp:lan"
    )["idempotent"] is True


def test_raw_yaml_import_creates_project_only_on_apply(tmp_path: Path) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)
    yaml_content = (
        "lvgl:\n  displays: [main_display]\n  widgets:\n"
        "    - label:\n        id: status_label\n        text: Ready\n"
    )

    proposed = service.propose_project_import_from_yaml(
        yaml_content,
        "panel.lvgldesign",
        source_name="uploaded.yaml",
        identity="mcp:lan",
    )

    assert proposed["target_kind"] == "project_create"
    assert proposed["preview"]["source_name"] == "uploaded.yaml"
    assert service.list_projects()["count"] == 0
    applied = service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert applied["idempotent"] is False
    created = service.projects.read("panel.lvgldesign")
    assert created["project"]["widgets"][0]["id"] == "status_label"
    assert service.apply_changeset(
        proposed["change_set_id"], identity="mcp:lan"
    )["idempotent"] is True


def test_raw_yaml_import_rejects_content_over_the_configured_size_limit(
    tmp_path: Path,
) -> None:
    import dataclasses

    settings = dataclasses.replace(write_settings(tmp_path), max_file_size=1024)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)

    with pytest.raises(ApiError) as too_large:
        service.propose_project_import_from_yaml(
            "x" * 2000,
            "panel.lvgldesign",
            identity="mcp:lan",
        )
    assert too_large.value.error == "yaml_content_too_large"


def test_raw_yaml_import_rejects_empty_content_and_bad_source_name(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)

    with pytest.raises(ApiError) as empty:
        service.propose_project_import_from_yaml(
            "   ", "panel.lvgldesign", identity="mcp:lan"
        )
    assert empty.value.error == "invalid_yaml_content"

    with pytest.raises(ApiError) as bad_name:
        service.propose_project_import_from_yaml(
            "lvgl:\n  widgets: []\n",
            "panel.lvgldesign",
            source_name="../escape.yaml",
            identity="mcp:lan",
        )
    assert bad_name.value.error == "invalid_source_name"


def test_publish_configuration_writes_active_yaml_and_checks_revision(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: active\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    active = service.read_configuration("panel.yaml")
    service.filesystem.save_draft("panel.yaml", "esphome:\n  name: published\n")

    with pytest.raises(ApiError) as stale:
        service.publish_configuration(
            "panel.yaml", "sha256:" + "0" * 64, identity="mcp:lan"
        )
    assert stale.value.error == "revision_conflict"

    published = service.publish_configuration(
        "panel.yaml", active["revision"], identity="mcp:lan"
    )

    assert published["old_revision"] == active["revision"]
    assert (
        service.read_configuration("panel.yaml")["content"]
        == "esphome:\n  name: published\n"
    )
    with pytest.raises(ApiError) as no_draft:
        service.filesystem.read_draft("panel.yaml")
    assert no_draft.value.error == "draft_not_found"
    actions = [entry["action"] for entry in service.audit.recent()]
    assert "mcp.configuration.publish" in actions


def test_publish_configuration_requires_project_write_mode(tmp_path: Path) -> None:
    settings = write_settings(tmp_path, mcp_access="read_only")
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: active\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    active = service.read_configuration("panel.yaml")
    service.filesystem.save_draft("panel.yaml", "esphome:\n  name: published\n")

    with pytest.raises(ApiError) as denied:
        service.publish_configuration(
            "panel.yaml", active["revision"], identity="mcp:lan"
        )
    assert denied.value.error == "mcp_write_disabled"


def test_yaml_project_import_checks_source_revision_and_protected_paths(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    source = settings.config_root / "panel.yaml"
    source.write_text(
        "lvgl:\n  widgets:\n    - label: {id: status_label, text: Ready}\n",
        encoding="utf-8",
    )
    (settings.config_root / "secrets.yaml").write_text(
        "wifi_password: secret\n", encoding="utf-8"
    )
    (settings.config_root / "large.yaml").write_text(
        "#" * 70_000, encoding="utf-8"
    )
    service = AssistantToolService(settings)
    configuration = service.read_configuration("panel.yaml")
    proposed = service.propose_project_import(
        "panel.yaml",
        configuration["revision"],
        "panel.lvgldesign",
        identity="mcp:lan",
    )
    source.write_text(
        "lvgl:\n  widgets:\n    - label: {id: changed, text: Changed}\n",
        encoding="utf-8",
    )

    with pytest.raises(ApiError) as conflict:
        service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    assert conflict.value.error == "revision_conflict"
    assert conflict.value.details["target"] == "configuration"
    assert "secrets.yaml" not in {
        item["name"] for item in service.list_configurations()["configurations"]
    }
    with pytest.raises(ApiError) as protected:
        service.read_configuration("secrets.yaml")
    assert protected.value.error == "secrets_file_protected"
    first_chunk = service.read_configuration("large.yaml")
    assert len(first_chunk["content"]) == 64 * 1024
    assert first_chunk["next_offset"] == 64 * 1024
    assert service.read_configuration(
        "large.yaml", first_chunk["next_offset"]
    )["truncated"] is False


def test_configuration_merge_changeset_writes_only_a_revision_checked_draft(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    active_path = settings.config_root / "panel.yaml"
    active_content = "esphome:\n  name: panel\nlogger:\n"
    active_path.write_text(active_content, encoding="utf-8")
    service = AssistantToolService(settings)
    project = service.projects.save(
        "display.lvgldesign",
        project_with_button(),
        None,
    )
    configuration = service.filesystem.read_config("panel.yaml")

    proposed = service.propose_configuration_draft(
        "display.lvgldesign",
        project["revision"],
        "panel.yaml",
        configuration["revision"],
        None,
        identity="mcp:lan",
    )

    assert proposed["target_kind"] == "configuration_draft"
    assert proposed["preview"]["appended"] == ["lvgl"]
    assert "button_1" in proposed["preview"]["diff"]
    with pytest.raises(ApiError) as absent:
        service.filesystem.read_draft("panel.yaml")
    assert absent.value.error == "draft_not_found"

    applied = service.apply_changeset(
        proposed["change_set_id"],
        identity="mcp:lan",
    )
    assert applied["status"] == "applied"
    assert applied["idempotent"] is False
    draft = service.filesystem.read_draft("panel.yaml")
    assert draft["revision"] == applied["applied_revision"]
    assert "button_1" in draft["content"]
    assert active_path.read_text(encoding="utf-8") == active_content

    retry = service.apply_changeset(
        proposed["change_set_id"],
        identity="mcp:lan",
    )
    assert retry["idempotent"] is True
    assert retry["applied_revision"] == applied["applied_revision"]
    actions = [entry["action"] for entry in service.audit.recent()]
    assert "mcp.configuration_draft.propose" in actions


def test_configuration_merge_changeset_rejects_concurrent_draft_change(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: panel\nlogger:\n",
        encoding="utf-8",
    )
    service = AssistantToolService(settings)
    project = service.projects.save(
        "display.lvgldesign",
        project_with_button(),
        None,
    )
    configuration = service.filesystem.read_config("panel.yaml")
    original_draft = service.filesystem.save_draft(
        "panel.yaml",
        "esphome:\n  name: panel\nlogger:\n  level: INFO\n",
    )
    proposed = service.propose_configuration_draft(
        "display.lvgldesign",
        project["revision"],
        "panel.yaml",
        configuration["revision"],
        original_draft["revision"],
        identity="mcp:lan",
    )

    newer_content = "esphome:\n  name: panel\nlogger:\n  level: DEBUG\n"
    newer = service.filesystem.save_draft("panel.yaml", newer_content)
    with pytest.raises(ApiError) as conflict:
        service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")

    assert conflict.value.error == "revision_conflict"
    assert conflict.value.details["target"] == "configuration_draft"
    assert conflict.value.details["actual_revision"] == newer["revision"]
    assert service.filesystem.read_draft("panel.yaml")["content"] == newer_content


def test_configuration_merge_proposal_requires_write_access(
    tmp_path: Path,
) -> None:
    settings = write_settings(tmp_path, mcp_access="read_only")
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: panel\n",
        encoding="utf-8",
    )
    service = AssistantToolService(settings)
    project = service.projects.save(
        "display.lvgldesign",
        project_with_button(),
        None,
    )
    configuration = service.filesystem.read_config("panel.yaml")

    with pytest.raises(ApiError) as denied:
        service.propose_configuration_draft(
            "display.lvgldesign",
            project["revision"],
            "panel.yaml",
            configuration["revision"],
            None,
            identity="mcp:lan",
        )
    assert denied.value.error == "mcp_write_disabled"


def test_changesets_are_owned_and_expire(tmp_path: Path) -> None:
    store = ChangeSetStore(tmp_path)
    created = store.create(
        identity="mcp:one",
        project_name="display.lvgldesign",
        base_revision="sha256:" + "0" * 64,
        operations=[{"op": "update_widget"}],
        project={"format": "test"},
        preview={"operation_count": 1},
        now=100,
    )

    with pytest.raises(ApiError) as wrong_owner:
        store.read(created["change_set_id"], "mcp:two", now=101)
    assert wrong_owner.value.error == "changeset_not_found"
    with pytest.raises(ApiError) as expired:
        store.read(
            created["change_set_id"],
            "mcp:one",
            now=100 + MCP_CHANGESET_TTL_SECONDS,
        )
    assert expired.value.error == "changeset_expired"


def test_applied_changeset_is_retained_for_idempotent_retries(tmp_path: Path) -> None:
    store = ChangeSetStore(tmp_path)
    created = store.create(
        identity="mcp:one",
        project_name="display.lvgldesign",
        base_revision="sha256:" + "0" * 64,
        operations=[{"op": "update_widget"}],
        project={"format": "test"},
        preview={},
        now=100,
    )

    applied = store.mark_applied(
        created["change_set_id"],
        "mcp:one",
        "sha256:" + "1" * 64,
        now=101,
    )

    assert applied["status"] == "applied"
    with closing(sqlite3.connect(store.path)) as connection:
        payloads = connection.execute(
            """
            SELECT operations_json, project_json, preview_json, viewer_bindings_json
            FROM project_changesets WHERE id = ?
            """,
            (created["change_set_id"],),
        ).fetchone()
    assert payloads == ("[]", "{}", "{}", None)
    assert (
        store.read(
            created["change_set_id"],
            "mcp:one",
            now=100 + MCP_CHANGESET_TTL_SECONDS + 1,
        )["applied_revision"]
        == "sha256:" + "1" * 64
    )
    with pytest.raises(ApiError) as expired:
        store.read(
            created["change_set_id"],
            "mcp:one",
            now=101 + MCP_APPLIED_CHANGESET_RETENTION_SECONDS,
        )
    assert expired.value.error == "changeset_expired"


def test_changeset_storage_is_bounded_per_identity_and_by_bytes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import backend.assistant_tools.changesets as changeset_module

    monkeypatch.setattr(changeset_module, "MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY", 2)
    store = ChangeSetStore(tmp_path)
    change_set_ids = []
    for index in range(2):
        created = store.create(
            identity="mcp:one",
            project_name="display.lvgldesign",
            base_revision="sha256:" + "0" * 64,
            operations=[],
            project={"value": index},
            preview={},
            now=100 + index,
        )
        change_set_ids.append(created["change_set_id"])
        store.mark_applied(
            created["change_set_id"],
            "mcp:one",
            "sha256:" + "1" * 64,
            now=100 + index,
        )

    # A client still actively working must not be locked out by its own
    # applied history: hitting the per-identity record limit evicts the
    # oldest already-applied record instead of failing the new proposal.
    third = store.create(
        identity="mcp:one",
        project_name="display.lvgldesign",
        base_revision="sha256:" + "0" * 64,
        operations=[],
        project={"value": "third"},
        preview={},
        now=103,
    )
    assert third["change_set_id"]
    with pytest.raises(ApiError) as evicted:
        store.read(change_set_ids[0], "mcp:one", now=103)
    assert evicted.value.error == "changeset_not_found"
    assert (
        store.read(change_set_ids[1], "mcp:one", now=103)["change_set_id"]
        == change_set_ids[1]
    )

    monkeypatch.setattr(changeset_module, "MCP_CHANGESET_PAYLOAD_MAX_BYTES", 32)
    with pytest.raises(ApiError) as byte_limit:
        store.create(
            identity="mcp:two",
            project_name="display.lvgldesign",
            base_revision="sha256:" + "0" * 64,
            operations=[],
            project={"payload": "x" * 64},
            preview={},
            now=104,
        )
    assert byte_limit.value.error == "changeset_too_large"


def test_changeset_record_eviction_cannot_touch_pending_proposals(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import backend.assistant_tools.changesets as changeset_module

    monkeypatch.setattr(changeset_module, "MCP_ACTIVE_CHANGESET_LIMIT", 3)
    monkeypatch.setattr(changeset_module, "MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY", 2)
    store = ChangeSetStore(tmp_path)
    for index in range(2):
        store.create(
            identity="mcp:one",
            project_name="display.lvgldesign",
            base_revision="sha256:" + "0" * 64,
            operations=[],
            project={"value": index},
            preview={},
            now=100 + index,
        )

    with pytest.raises(ApiError) as record_limit:
        store.create(
            identity="mcp:one",
            project_name="display.lvgldesign",
            base_revision="sha256:" + "0" * 64,
            operations=[],
            project={},
            preview={},
            now=103,
        )
    assert record_limit.value.error == "changeset_record_limit_reached"


def test_grid_and_flex_placement_are_layout_managed() -> None:
    project = project_with_button()
    project["widgets"] = []
    proposed, _preview = PlacementService().apply(
        project,
        [
            {
                "op": "add_widget",
                "widget_id": "grid",
                "widget_type": "obj",
                "layout": {
                    "type": "GRID",
                    "grid_rows": [100, 100],
                    "grid_columns": [120, 120],
                },
                "placement": {"x": 10, "y": 10, "width": 300, "height": 240},
            },
            {
                "op": "add_widget",
                "widget_id": "grid_label",
                "widget_type": "label",
                "parent_id": "grid",
                "placement": {
                    "x": 99,
                    "y": 99,
                    "grid_cell": {"row_pos": 1, "column_pos": 1},
                },
            },
            {
                "op": "add_widget",
                "widget_id": "flex",
                "widget_type": "container",
                "layout": {"type": "FLEX", "flex_flow": "ROW"},
                "placement": {"x": 10, "y": 210, "width": 300, "height": 100},
            },
            {
                "op": "add_widget",
                "widget_id": "flex_button",
                "widget_type": "button",
                "parent_id": "flex",
                "placement": {"x": 80, "y": 40},
            },
        ],
    )

    grid_child = proposed["widgets"][0]["children"][0]
    assert (grid_child["x"], grid_child["y"]) == (0, 0)
    assert grid_child["grid_cell"]["row_pos"] == 1
    flex_child = proposed["widgets"][1]["children"][0]
    assert (flex_child["x"], flex_child["y"]) == (0, 0)
    assert flex_child["grid_cell"] == {}


def test_page_layer_and_msgbox_surfaces_are_explicit() -> None:
    project = project_with_button()
    project["widgets"] = []
    project["pages"] = [
        {"id": "page_1", "widgets": [], "layout": {}, "style_tree": {}, "extra": {}}
    ]
    project["top_layer"] = {"widgets": [], "layout": {}, "style_tree": {}, "extra": {}}
    project["msgboxes"] = [
        {
            "id": "dialog",
            "title": "Dialog",
            "buttons": [],
            "header_buttons": [],
        }
    ]
    proposed, _preview = PlacementService().apply(
        project,
        [
            {
                "op": "add_widget",
                "widget_id": "page_label",
                "widget_type": "label",
                "surface": "page:page_1",
            },
            {
                "op": "add_widget",
                "widget_id": "layer_label",
                "widget_type": "label",
                "surface": "top",
            },
            {
                "op": "add_widget",
                "widget_id": "dialog_ok",
                "widget_type": "button",
                "surface": "msgbox:dialog:buttons",
                "properties": {"text": "OK"},
            },
        ],
    )

    assert proposed["pages"][0]["widgets"][0]["id"] == "page_label"
    assert proposed["top_layer"]["widgets"][0]["id"] == "layer_label"
    assert proposed["msgboxes"][0]["buttons"][0]["id"] == "dialog_ok"


@pytest.mark.parametrize(
    ("operation", "error"),
    [
        (
            {
                "op": "add_widget",
                "widget_id": "button_1",
                "widget_type": "label",
            },
            "duplicate_id",
        ),
        (
            {
                "op": "add_widget",
                "widget_id": "outside",
                "widget_type": "label",
                "placement": {"x": 470, "y": 310, "width": 120, "height": 24},
            },
            "placement_overflow",
        ),
        (
            {
                "op": "add_widget",
                "widget_id": "bad",
                "widget_type": "tab",
                "parent_id": "button_1",
            },
            "invalid_child_role",
        ),
        (
            {
                "op": "update_widget",
                "widget_id": "button_1",
                "properties": {"not_a_property": "value"},
            },
            "unsupported_property",
        ),
    ],
)
def test_invalid_semantic_placements_are_rejected(operation: dict, error: str) -> None:
    with pytest.raises(ApiError) as raised:
        PlacementService().apply(project_with_button(), [operation])
    assert raised.value.error == error


def test_reparenting_rejects_widget_and_alignment_cycles() -> None:
    project = project_with_button()
    project["widgets"][0]["children"] = [
        {
            "id": "child",
            "widget_type": "label",
            "x": 0,
            "y": 0,
            "width": 40,
            "height": 20,
            "align": "TOP_LEFT",
            "align_to": "",
            "properties": {"text": "child"},
            "style_tree": {},
            "layout": {},
            "grid_cell": {},
            "children": [],
        }
    ]
    with pytest.raises(ApiError) as cycle:
        PlacementService().apply(
            project,
            [
                {
                    "op": "place_widget",
                    "widget_id": "button_1",
                    "parent_id": "child",
                }
            ],
        )
    assert cycle.value.error == "placement_cycle"

    project["widgets"].append(
        {
            "id": "peer",
            "widget_type": "label",
            "x": 200,
            "y": 20,
            "width": 40,
            "height": 20,
            "align": "TOP_LEFT",
            "align_to": "button_1",
            "properties": {"text": "peer"},
            "style_tree": {},
            "layout": {},
            "grid_cell": {},
            "children": [],
        }
    )
    project["top_layer"] = {"widgets": [], "layout": {}, "style_tree": {}, "extra": {}}
    with pytest.raises(ApiError) as cross_surface:
        PlacementService().apply(
            project,
            [
                {
                    "op": "place_widget",
                    "widget_id": "button_1",
                    "surface": "top",
                }
            ],
        )
    assert cross_surface.value.error == "invalid_alignment_target"


def test_secrets_yaml_is_unreadable_via_mcp_even_when_protect_sensitive_paths_is_off(
    tmp_path: Path,
) -> None:
    """secrets.yaml/secrets.yml must never be readable through MCP, regardless
    of the protect_sensitive_paths setting - that toggle only governs the
    REST/browser path. This is an independent, unconditional guard."""
    import dataclasses

    settings = dataclasses.replace(
        write_settings(tmp_path), protect_sensitive_paths=False
    )
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "secrets.yaml").write_text(
        "wifi_password: hunter2\n", encoding="utf-8"
    )
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: panel\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)

    # Confirm the REST-level protection really is off, so this test is
    # actually exercising the independent MCP-layer guard and not just
    # re-proving the filesystem-level one.
    assert "wifi_password: hunter2" in service.filesystem.read_config("secrets.yaml")[
        "content"
    ]

    with pytest.raises(ApiError) as active_read:
        service.read_configuration("secrets.yaml")
    assert active_read.value.error == "secrets_file_protected"

    service.filesystem.save_draft("secrets.yaml", "wifi_password: hunter2\n")
    with pytest.raises(ApiError) as draft_read:
        service.read_configuration("secrets.yaml", source="draft")
    assert draft_read.value.error == "secrets_file_protected"

    project = service.projects.save("display.lvgldesign", project_with_button(), None)
    with pytest.raises(ApiError) as merge_preview:
        service.transform_yaml(
            "display.lvgldesign",
            project["revision"],
            mode="merge_preview",
            configuration_name="secrets.yaml",
            configuration_revision="sha256:" + "0" * 64,
        )
    assert merge_preview.value.error == "secrets_file_protected"

    with pytest.raises(ApiError) as draft_propose:
        service.propose_configuration_draft(
            "display.lvgldesign",
            project["revision"],
            "secrets.yaml",
            "sha256:" + "0" * 64,
            None,
            identity="mcp:lan",
        )
    assert draft_propose.value.error == "secrets_file_protected"

    with pytest.raises(ApiError) as import_propose:
        service.propose_project_import(
            "secrets.yaml",
            "sha256:" + "0" * 64,
            "another.lvgldesign",
            identity="mcp:lan",
        )
    assert import_propose.value.error == "secrets_file_protected"


def seed_two_versions(service) -> str:
    project = project_with_button()
    created = service.projects.save("display.lvgldesign", project, None, origin="ui")
    project["canvas"]["width"] = 800
    service.projects.save(
        "display.lvgldesign", project, created["revision"], actor="mcp:lan", origin="mcp"
    )
    return created["revision"]


def test_revision_tools_expose_metadata_without_content(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    seed_two_versions(service)

    listing = service.list_project_revisions("display.lvgldesign")
    assert listing["exists"] is True
    assert [item["origin"] for item in listing["versions"]] == ["mcp", "ui"]
    assert [item["is_current"] for item in listing["versions"]] == [True, False]
    assert listing["truncated"] is False
    # Metadata only - the tool must never hand back a whole project blob.
    assert all("project" not in item and "content" not in item for item in listing["versions"])


def test_revision_summary_and_diff_views(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    seed_two_versions(service)
    oldest = service.list_project_revisions("display.lvgldesign")["versions"][-1]

    summary = service.read_project_revision("display.lvgldesign", oldest["id"])
    assert summary["view"] == "summary"
    assert summary["widget_count"] == 1
    assert summary["valid"] is True
    assert "diff" not in summary

    diff = service.read_project_revision("display.lvgldesign", oldest["id"], "diff")
    assert diff["against"] == "current"
    assert '-    "width": 480' in diff["diff"]
    assert '+    "width": 800' in diff["diff"]
    assert diff["diff_truncated"] is False


def test_revision_reads_reject_bad_arguments_and_foreign_versions(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    seed_two_versions(service)
    version_id = service.list_project_revisions("display.lvgldesign")["versions"][0]["id"]

    with pytest.raises(ApiError) as bad_view:
        service.read_project_revision("display.lvgldesign", version_id, "everything")
    assert bad_view.value.error == "invalid_request"

    with pytest.raises(ApiError) as bad_against:
        service.read_project_revision(
            "display.lvgldesign", version_id, "diff", "nonsense"
        )
    assert bad_against.value.error == "invalid_request"

    with pytest.raises(ApiError) as foreign:
        service.read_project_revision("other.lvgldesign", version_id)
    assert foreign.value.error == "revision_not_found"


def test_revision_diff_is_capped_at_the_soft_target(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    created = service.projects.save("display.lvgldesign", project, None, origin="ui")
    project["widgets"] = [
        {
            "id": f"label_{index}",
            "widget_type": "label",
            "x": 0, "y": index, "width": 40, "height": 12,
            "properties": {"text": f"row {index}"},
            "style_tree": {},
            "children": [],
        }
        for index in range(400)
    ]
    service.projects.save(
        "display.lvgldesign", project, created["revision"], origin="ui"
    )
    oldest = service.list_project_revisions("display.lvgldesign")["versions"][-1]

    diff = service.read_project_revision("display.lvgldesign", oldest["id"], "diff")
    assert diff["diff_truncated"] is True
    assert len(diff["diff"]) == MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS


def add_button_op(widget_id: str = "light_button") -> dict:
    return {
        "op": "add_widget",
        "widget_id": widget_id,
        "widget_type": "button",
        "surface": "root",
        "placement": {"x": 160, "y": 20, "width": 120, "height": 40},
        "properties": {"text": "Licht"},
    }


def direct_apply(service, name, base_revision, operations, identity="mcp:lan"):
    """The composition display_project_apply performs, without the MCP transport."""
    proposed = service.propose_project(name, base_revision, operations, identity=identity)
    return service.apply_changeset(proposed["change_set_id"], identity=identity)


def test_direct_apply_writes_without_a_review_step(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    applied = direct_apply(
        service, "display.lvgldesign", created["revision"], [add_button_op()]
    )

    assert applied["status"] == "applied"
    stored = service.projects.read("display.lvgldesign")
    assert stored["revision"] == applied["applied_revision"]
    assert {item["id"] for item in stored["project"]["widgets"]} == {
        "button_1",
        "light_button",
    }


def test_direct_apply_still_records_a_recoverable_version(tmp_path: Path) -> None:
    """The history is the safety net that replaces the review step."""
    service = AssistantToolService(write_settings(tmp_path))
    created = service.projects.save(
        "display.lvgldesign", project_with_button(), None, origin="ui"
    )

    direct_apply(service, "display.lvgldesign", created["revision"], [add_button_op()])

    versions = service.projects.revisions.list("display.lvgldesign")
    assert [item["origin"] for item in versions] == ["mcp", "ui"]
    assert versions[0]["actor"] == "mcp:lan"
    # The state before the agent touched it is still there and restorable.
    restored, _ = service.projects.revisions.content(
        "display.lvgldesign", versions[1]["id"]
    )
    assert restored is not None
    service.projects.save(
        "display.lvgldesign",
        json.loads(restored),
        versions[0]["revision"],
        actor="ha:user",
        origin="restore",
    )
    rolled_back = service.projects.read("display.lvgldesign")
    assert {item["id"] for item in rolled_back["project"]["widgets"]} == {"button_1"}


def test_direct_apply_still_refuses_a_stale_base_revision(tmp_path: Path) -> None:
    """Skipping review does not mean skipping concurrency safety."""
    service = AssistantToolService(write_settings(tmp_path))
    project = project_with_button()
    created = service.projects.save("display.lvgldesign", project, None)
    project["canvas"]["width"] = 800
    newer = service.projects.save("display.lvgldesign", project, created["revision"])

    with pytest.raises(ApiError) as raised:
        direct_apply(
            service, "display.lvgldesign", created["revision"], [add_button_op()]
        )

    assert raised.value.error == "revision_conflict"
    assert service.projects.read("display.lvgldesign")["revision"] == newer["revision"]


def test_direct_apply_still_validates_the_operations(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    with pytest.raises(ApiError):
        direct_apply(
            service,
            "display.lvgldesign",
            created["revision"],
            [add_button_op("invalid id")],
        )

    assert service.projects.read("display.lvgldesign")["revision"] == created["revision"]
    assert len(service.projects.revisions.list("display.lvgldesign")) == 1


def test_direct_apply_is_refused_for_read_only_mcp(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path, mcp_access="read_only"))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    with pytest.raises(ApiError) as raised:
        direct_apply(
            service, "display.lvgldesign", created["revision"], [add_button_op()]
        )

    assert raised.value.error == "mcp_write_disabled"


def test_direct_apply_leaves_an_audit_trail_for_both_halves(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path))
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    direct_apply(service, "display.lvgldesign", created["revision"], [add_button_op()])

    actions = [entry["action"] for entry in service.audit.recent()]
    assert "mcp.project.propose" in actions
    assert "mcp.changeset.apply" in actions
