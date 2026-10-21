"""Viewer scenarios through the MCP service: read, propose, review, apply."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.assistant_tools import AssistantToolService
from backend.errors import ApiError
from backend.mcp.server import create_mcp_server

from .test_mcp_mutations import write_settings
from .test_viewer_scenarios import CONFIG

PROJECT = "tester.lvgldesign"

BOARD = {
    "op": "upsert_scenario",
    "name": "Board erkannt",
    "actions": [
        {"lvgl.label.update": {"id": "version_label", "text": "1.0.18", "bg_color": "0x00FF00"}},
        {"switch.turn_on": "board_detected"},
    ],
}


@pytest.fixture
def service(tmp_path: Path) -> AssistantToolService:
    service = AssistantToolService(write_settings(tmp_path))
    imported = service.designer.import_yaml(CONFIG, source_name="tester.yaml")
    project = imported["project"]
    project["widgets"].append({"id": "version_label", "widget_type": "label",
                               "properties": {"text": "?"}})
    service.projects.save(PROJECT, project, None)
    return service


def _propose_and_apply(service: AssistantToolService, operations: list[dict]) -> dict:
    revision = service.read_viewer_scenarios(PROJECT)["revision"]
    proposed = service.propose_viewer_scenarios(PROJECT, revision, operations, identity="mcp:lan")
    service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    return proposed


def test_read_offers_format_and_import_suggestions(service: AssistantToolService) -> None:
    read = service.read_viewer_scenarios(PROJECT)

    assert read["yaml"] == "" and read["scenarios"] == []
    assert "Eingang NEXT" in read["suggestion_names"]
    assert read["revision"].startswith("sha256:")
    assert "transitions" in read["format"]["scenario"]


def test_proposal_is_reviewed_before_it_is_saved(service: AssistantToolService) -> None:
    before = service.read_viewer_scenarios(PROJECT)
    proposed = service.propose_viewer_scenarios(
        PROJECT, before["revision"],
        [{"op": "adopt_suggestions", "names": ["AUTO", "TR0", "Eingang NEXT"]}, BOARD],
        identity="mcp:lan",
    )

    assert service.read_viewer_scenarios(PROJECT)["scenarios"] == []
    preview = proposed["preview"]
    assert preview["added_scenarios"] == ["AUTO", "Board erkannt", "Eingang NEXT", "TR0"]
    assert preview["unknown_widget_ids"] == []

    service.apply_changeset(proposed["change_set_id"], identity="mcp:lan")
    after = service.read_viewer_scenarios(PROJECT)
    assert [s["name"] for s in after["scenarios"]] == ["AUTO", "TR0", "Eingang NEXT", "Board erkannt"]
    assert after["revision"] != before["revision"]
    assert "on: " in after["yaml"] or "on:\n" in after["yaml"]


def test_an_upsert_keeps_the_comments_of_other_scenarios(service: AssistantToolService) -> None:
    _propose_and_apply(service, [{"op": "set_scenarios_yaml", "yaml": (
        "# Hand-written - keep this note.\n"
        "- name: Licht gut\n"
        "  actions:\n"
        "    # sensor says 12 uW/cm2\n"
        "    - lvgl.label.update: {id: version_label, text: \"12\"}\n"
    )}])

    proposed = _propose_and_apply(service, [BOARD])

    text = service.read_viewer_scenarios(PROJECT)["yaml"]
    assert "# Hand-written - keep this note." in text
    assert "    # sensor says 12 uW/cm2" in text
    assert '{id: version_label, text: "12"}' in text
    assert proposed["preview"]["comments_preserved"] is True
    assert proposed["preview"]["added_scenarios"] == ["Board erkannt"]


def test_rename_follows_into_transition_tables(service: AssistantToolService) -> None:
    _propose_and_apply(service, [{"op": "adopt_suggestions"}])

    _propose_and_apply(service, [{
        "op": "upsert_scenario", "name": "TR0", "rename_to": "Messung 0",
        "actions": [{"lvgl.label.update": {"id": "next_label", "text": "TR0"}}],
    }])

    scenarios = {s["name"]: s for s in service.read_viewer_scenarios(PROJECT)["scenarios"]}
    assert "TR0" not in scenarios
    assert scenarios["Eingang NEXT"]["transitions"] == {"AUTO": "Messung 0", "Messung 0": "AUTO"}


def test_deleting_a_referenced_state_is_refused(service: AssistantToolService) -> None:
    _propose_and_apply(service, [{"op": "adopt_suggestions"}])
    revision = service.read_viewer_scenarios(PROJECT)["revision"]

    with pytest.raises(ApiError) as error:
        service.propose_viewer_scenarios(
            PROJECT, revision, [{"op": "delete_scenario", "name": "TR0"}], identity="mcp:lan")
    assert error.value.error == "invalid_viewer_scenarios"
    assert "TR0" in error.value.message


def test_unknown_widget_ids_are_flagged_not_fatal(service: AssistantToolService) -> None:
    revision = service.read_viewer_scenarios(PROJECT)["revision"]
    proposed = service.propose_viewer_scenarios(PROJECT, revision, [{
        "op": "upsert_scenario", "name": "Tippfehler",
        "actions": [{"lvgl.widget.show": ["version_lable"]}],
    }], identity="mcp:lan")

    assert proposed["preview"]["unknown_widget_ids"] == ["version_lable"]


def test_proposals_need_write_access(tmp_path: Path) -> None:
    service = AssistantToolService(write_settings(tmp_path, mcp_access="read_only"))
    with pytest.raises(ApiError) as error:
        service.propose_viewer_scenarios(PROJECT, "sha256:" + "0" * 64, [BOARD], identity="mcp:lan")
    assert error.value.error == "mcp_write_disabled"


def test_tools_are_registered_per_access_mode(tmp_path: Path) -> None:
    read_only = {t.name: t for t in asyncio.run(
        create_mcp_server(write_settings(tmp_path, mcp_access="read_only")).list_tools())}
    writable = {t.name: t for t in asyncio.run(
        create_mcp_server(write_settings(tmp_path)).list_tools())}

    assert read_only["display_viewer_scenarios_read"].annotations.read_only_hint
    assert "display_viewer_scenarios_propose" not in read_only
    assert writable["display_viewer_scenarios_propose"].meta == {
        "ui": {"resourceUri": "ui://display-editor/changeset-review"}}
