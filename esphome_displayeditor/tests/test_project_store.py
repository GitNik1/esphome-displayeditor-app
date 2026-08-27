from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.designer import DesignerService
from backend.errors import ApiError
from backend.project_store import ProjectStore

from .test_designer import project_with_button


def make_store(tmp_path: Path) -> ProjectStore:
    return ProjectStore(tmp_path, DesignerService(tmp_path), 1024 * 1024)


def test_project_create_read_list_update_delete(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    project = project_with_button()

    created = store.save("display.lvgldesign", project, None)
    assert created["old_revision"] is None
    assert store.list()[0]["name"] == "display.lvgldesign"
    loaded = store.read("display.lvgldesign")
    assert loaded["project"]["canvas"]["width"] == 480
    assert loaded["revision"] == created["revision"]

    project["canvas"]["width"] = 800
    updated = store.save("display.lvgldesign", project, created["revision"])
    assert updated["revision"] != created["revision"]
    deleted = store.delete("display.lvgldesign", updated["revision"])
    assert deleted["revision"] == updated["revision"]
    assert store.list() == []


@pytest.mark.parametrize(
    "name",
    ["../display.lvgldesign", "/display.lvgldesign", ".hidden.lvgldesign", "display.json"],
)
def test_invalid_project_names_are_rejected(tmp_path: Path, name: str) -> None:
    with pytest.raises(ApiError) as raised:
        make_store(tmp_path).save(name, project_with_button(), None)
    assert raised.value.error == "invalid_project_name"


def test_project_revision_conflicts_are_rejected(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    created = store.save("display.lvgldesign", project_with_button(), None)

    with pytest.raises(ApiError) as raised:
        store.save("display.lvgldesign", project_with_button(), None)
    assert raised.value.error == "project_exists"

    with pytest.raises(ApiError) as raised:
        store.save("display.lvgldesign", project_with_button(), "sha256:" + "0" * 64)
    assert raised.value.error == "revision_conflict"

    assert store.read("display.lvgldesign")["revision"] == created["revision"]


def test_invalid_project_is_not_stored(tmp_path: Path) -> None:
    project = project_with_button()
    project["widgets"][0]["id"] = "invalid id"
    store = make_store(tmp_path)
    with pytest.raises(ApiError) as raised:
        store.save("display.lvgldesign", project, None)
    assert raised.value.error == "invalid_project"
    assert store.list() == []


def test_current_revision_reports_the_stored_file(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.current_revision("display.lvgldesign") is None

    created = store.save("display.lvgldesign", project_with_button(), None)
    assert store.current_revision("display.lvgldesign") == created["revision"]


def test_every_save_records_a_version_with_its_own_author(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    project = project_with_button()

    created = store.save(
        "display.lvgldesign", project, None, actor="mcp:lan:abc", origin="mcp"
    )
    assert created["snapshot"] is True

    project["canvas"]["width"] = 800
    store.save(
        "display.lvgldesign",
        project,
        created["revision"],
        actor="ha:alice",
        origin="ui",
    )

    versions = store.revisions.list("display.lvgldesign")
    assert [item["origin"] for item in versions] == ["ui", "mcp"]
    # The MCP-authored version keeps its attribution now that a later version
    # has replaced it, which a pre-image model would have relabelled.
    assert versions[1]["actor"] == "mcp:lan:abc"

    stored, _ = store.revisions.content("display.lvgldesign", versions[1]["id"])
    assert json.loads(stored)["canvas"]["width"] == 480


def test_delete_records_a_tombstone_above_the_restorable_content(
    tmp_path: Path,
) -> None:
    store = make_store(tmp_path)
    created = store.save("display.lvgldesign", project_with_button(), None)
    store.delete(
        "display.lvgldesign", created["revision"], actor="ha:alice", origin="ui"
    )

    versions = store.revisions.list("display.lvgldesign")
    assert versions[0]["action"] == "delete"
    stored, _ = store.revisions.content("display.lvgldesign", versions[1]["id"])
    assert json.loads(stored)["canvas"]["width"] == 480


def test_a_rejected_save_records_nothing(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.save("display.lvgldesign", project_with_button(), None)

    with pytest.raises(ApiError):
        store.save("display.lvgldesign", project_with_button(), "sha256:" + "0" * 64)

    invalid = project_with_button()
    invalid["widgets"][0]["id"] = "invalid id"
    with pytest.raises(ApiError):
        store.save("other.lvgldesign", invalid, None)

    assert len(store.revisions.list("display.lvgldesign")) == 1
    assert store.revisions.list("other.lvgldesign") == []


def test_a_failing_revision_store_does_not_break_saving(tmp_path: Path) -> None:
    class BrokenRevisions:
        def record(self, **_kwargs: object) -> bool:
            raise RuntimeError("disk full")

    store = ProjectStore(
        tmp_path,
        DesignerService(tmp_path),
        1024 * 1024,
        revisions=BrokenRevisions(),  # type: ignore[arg-type]
    )

    saved = store.save("display.lvgldesign", project_with_button(), None)
    assert saved["snapshot"] is False
    assert store.read("display.lvgldesign")["revision"] == saved["revision"]

