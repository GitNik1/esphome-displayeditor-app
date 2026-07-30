from __future__ import annotations

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

