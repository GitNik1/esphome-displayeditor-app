from __future__ import annotations

from pathlib import Path

import pytest

from backend.errors import ApiError
from backend.project_revisions import (
    PROJECT_REVISION_DEPTH,
    PROJECT_REVISION_LABEL_MAX_CHARS,
    PROJECT_REVISION_LOCKED_DEPTH,
    PROJECT_REVISION_MAX_BLOB_BYTES,
    ProjectRevisionStore,
)


def make_store(tmp_path: Path) -> ProjectRevisionStore:
    return ProjectRevisionStore(tmp_path)


def write(
    store: ProjectRevisionStore,
    body: str,
    *,
    name: str = "display.lvgldesign",
    actor: str = "ha:user",
    origin: str = "ui",
    action: str = "save",
    restored_from: int | None = None,
) -> bool:
    return store.record(
        project_name=name,
        content=body.encode("utf-8"),
        revision=f"sha256:{body}",
        actor=actor,
        origin=origin,
        action=action,
        restored_from=restored_from,
    )


def test_versions_are_listed_newest_first_with_their_own_author(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1", actor="ha:alice", origin="ui")
    write(store, "v2", actor="mcp:lan:abc", origin="mcp")

    versions = store.list("display.lvgldesign")
    assert [item["revision"] for item in versions] == ["sha256:v2", "sha256:v1"]
    # The MCP-authored version keeps its own attribution even though a later
    # version has since replaced it - the regression a pre-image model has.
    assert versions[0]["origin"] == "mcp"
    assert versions[0]["actor"] == "mcp:lan:abc"
    assert versions[1]["origin"] == "ui"


def test_content_round_trips_byte_identical(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    body = '{\n  "canvas": {\n    "width": 480\n  }\n}\n'
    store.record(
        project_name="display.lvgldesign",
        content=body.encode("utf-8"),
        revision="sha256:one",
        actor="ha:user",
        origin="ui",
        action="save",
    )
    version_id = store.list("display.lvgldesign")[0]["id"]

    raw, metadata = store.content("display.lvgldesign", version_id)
    assert raw.decode("utf-8") == body
    assert metadata["encoding"] == "zlib"
    assert metadata["byte_size"] == len(body.encode("utf-8"))


def test_content_of_another_project_is_not_returned(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1", name="a.lvgldesign")
    version_id = store.list("a.lvgldesign")[0]["id"]

    assert store.content("b.lvgldesign", version_id) is None


def test_consecutive_identical_content_is_skipped(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert write(store, "v1") is True
    assert write(store, "v1") is False
    assert len(store.list("display.lvgldesign")) == 1


def test_restoring_an_older_version_still_records_a_row(tmp_path: Path) -> None:
    """Dedup compares only against the immediately preceding row."""
    store = make_store(tmp_path)
    write(store, "v1")
    write(store, "v2")
    assert write(store, "v1", origin="restore") is True

    versions = store.list("display.lvgldesign")
    assert [item["revision"] for item in versions] == [
        "sha256:v1",
        "sha256:v2",
        "sha256:v1",
    ]
    # The displaced version stays put, so the restore is itself undoable.
    assert versions[0]["origin"] == "restore"
    assert versions[1]["origin"] == "ui"


def test_rolling_window_keeps_the_newest_versions(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    for index in range(PROJECT_REVISION_DEPTH + 4):
        write(store, f"v{index}")

    versions = store.list("display.lvgldesign")
    assert len(versions) == PROJECT_REVISION_DEPTH
    assert versions[0]["revision"] == f"sha256:v{PROJECT_REVISION_DEPTH + 3}"
    assert versions[-1]["revision"] == "sha256:v4"


def test_locked_versions_survive_pruning_and_sit_beside_the_window(
    tmp_path: Path,
) -> None:
    store = make_store(tmp_path)
    write(store, "keepme")
    pinned = store.list("display.lvgldesign")[0]["id"]
    store.set_locked("display.lvgldesign", pinned, True, "ha:user")

    for index in range(PROJECT_REVISION_DEPTH + 5):
        write(store, f"v{index}")

    versions = store.list("display.lvgldesign")
    assert len(versions) == PROJECT_REVISION_DEPTH + 1
    assert [item["id"] for item in versions if item["locked"]] == [pinned]
    assert versions[-1]["revision"] == "sha256:keepme"


def test_unlocking_returns_a_version_to_the_rolling_window(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "keepme")
    pinned = store.list("display.lvgldesign")[0]["id"]
    store.set_locked("display.lvgldesign", pinned, True, "ha:user")
    for index in range(PROJECT_REVISION_DEPTH):
        write(store, f"v{index}")

    store.set_locked("display.lvgldesign", pinned, False, "ha:user")
    write(store, "trigger")

    assert pinned not in {item["id"] for item in store.list("display.lvgldesign")}


def test_lock_quota_is_enforced(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    for index in range(PROJECT_REVISION_LOCKED_DEPTH + 1):
        write(store, f"v{index}")
    versions = store.list("display.lvgldesign")

    for item in versions[:PROJECT_REVISION_LOCKED_DEPTH]:
        store.set_locked("display.lvgldesign", item["id"], True, "ha:user")

    with pytest.raises(ApiError) as raised:
        store.set_locked(
            "display.lvgldesign",
            versions[PROJECT_REVISION_LOCKED_DEPTH]["id"],
            True,
            "ha:user",
        )
    assert raised.value.error == "revision_lock_limit"
    assert raised.value.status_code == 409


def test_locking_again_does_not_consume_another_slot(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    for index in range(PROJECT_REVISION_LOCKED_DEPTH):
        write(store, f"v{index}")
    versions = store.list("display.lvgldesign")
    for item in versions:
        store.set_locked("display.lvgldesign", item["id"], True, "ha:user")

    relocked = store.set_locked("display.lvgldesign", versions[0]["id"], True, "ha:user")
    assert relocked["locked"] is True


def test_label_and_lock_are_independent(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1")
    version_id = store.list("display.lvgldesign")[0]["id"]

    labelled = store.set_label("display.lvgldesign", version_id, "vor dem Umbau")
    assert labelled["label"] == "vor dem Umbau"
    assert labelled["locked"] is False

    locked = store.set_locked("display.lvgldesign", version_id, True, "ha:user")
    assert locked["locked"] is True
    assert locked["label"] == "vor dem Umbau"
    assert locked["locked_by"] == "ha:user"

    cleared = store.set_label("display.lvgldesign", version_id, "   ")
    assert cleared["label"] is None
    assert cleared["locked"] is True


def test_label_is_trimmed_to_the_maximum_length(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1")
    version_id = store.list("display.lvgldesign")[0]["id"]

    result = store.set_label("display.lvgldesign", version_id, "x" * 200)
    assert len(result["label"]) == PROJECT_REVISION_LABEL_MAX_CHARS


def test_annotating_another_projects_version_is_rejected(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1", name="a.lvgldesign")
    version_id = store.list("a.lvgldesign")[0]["id"]

    with pytest.raises(ApiError) as raised:
        store.set_label("b.lvgldesign", version_id, "nope")
    assert raised.value.error == "revision_not_found"


def test_delete_records_a_tombstone_without_content(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1")
    write(store, "v1", action="delete")

    versions = store.list("display.lvgldesign")
    assert versions[0]["action"] == "delete"
    assert versions[0]["encoding"] == "tombstone"
    # The content itself is still available from the row above the tombstone.
    raw, _ = store.content("display.lvgldesign", versions[1]["id"])
    assert raw == b"v1"


def test_oversized_content_is_recorded_without_the_blob(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.record(
        project_name="display.lvgldesign",
        content=b"x" * (PROJECT_REVISION_MAX_BLOB_BYTES + 1),
        revision="sha256:huge",
        actor="ha:user",
        origin="ui",
        action="save",
    )

    version = store.list("display.lvgldesign")[0]
    assert version["encoding"] == "skipped"
    assert version["byte_size"] == PROJECT_REVISION_MAX_BLOB_BYTES + 1
    raw, _ = store.content("display.lvgldesign", version["id"])
    assert raw == b""


def test_unknown_origin_and_action_are_coerced(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1", origin="something-else", action="mangle")

    version = store.list("display.lvgldesign")[0]
    assert version["origin"] == "unknown"
    assert version["action"] == "save"


def test_restored_from_is_preserved(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "v1")
    source = store.list("display.lvgldesign")[0]["id"]
    write(store, "v2")
    write(store, "v1", origin="restore", restored_from=source)

    assert store.list("display.lvgldesign")[0]["restored_from"] == source


def test_global_storage_cap_never_drops_a_projects_newest_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "backend.project_revisions.PROJECT_REVISION_STORAGE_MAX_BYTES", 1
    )
    store = make_store(tmp_path)
    write(store, "a1", name="a.lvgldesign")
    write(store, "a2", name="a.lvgldesign")
    write(store, "b1", name="b.lvgldesign")

    assert [item["revision"] for item in store.list("a.lvgldesign")] == ["sha256:a2"]
    assert [item["revision"] for item in store.list("b.lvgldesign")] == ["sha256:b1"]


def test_global_storage_cap_never_drops_a_locked_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = make_store(tmp_path)
    write(store, "pinned", name="a.lvgldesign")
    pinned = store.list("a.lvgldesign")[0]["id"]
    store.set_locked("a.lvgldesign", pinned, True, "ha:user")

    monkeypatch.setattr(
        "backend.project_revisions.PROJECT_REVISION_STORAGE_MAX_BYTES", 1
    )
    for index in range(4):
        write(store, f"a{index}", name="a.lvgldesign")
        write(store, f"b{index}", name="b.lvgldesign")

    assert pinned in {item["id"] for item in store.list("a.lvgldesign")}


def test_feed_is_global_and_clamped(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    write(store, "a1", name="a.lvgldesign")
    write(store, "b1", name="b.lvgldesign")

    events = store.recent(50)
    assert [item["project_name"] for item in events] == ["b.lvgldesign", "a.lvgldesign"]
    assert len(store.recent(0)) == 1
    assert len(store.recent(10_000)) == 2


def test_reopening_the_store_is_idempotent(tmp_path: Path) -> None:
    first = make_store(tmp_path)
    write(first, "v1")
    second = ProjectRevisionStore(tmp_path)

    assert second.enabled is True
    assert len(second.list("display.lvgldesign")) == 1


def test_two_stores_share_one_database(tmp_path: Path) -> None:
    """The app process and the MCP listener process each hold their own handle."""
    app_side = make_store(tmp_path)
    mcp_side = ProjectRevisionStore(tmp_path)

    write(app_side, "v1", origin="ui")
    write(mcp_side, "v2", origin="mcp")

    assert [item["origin"] for item in app_side.list("display.lvgldesign")] == [
        "mcp",
        "ui",
    ]


def test_a_broken_database_degrades_instead_of_raising(tmp_path: Path) -> None:
    (tmp_path / "database").mkdir()
    (tmp_path / "database" / "project_revisions.sqlite3").write_bytes(b"not a database")

    store = ProjectRevisionStore(tmp_path)

    assert store.enabled is False
    assert store.list("display.lvgldesign") == []
    assert store.recent() == []
    assert store.content("display.lvgldesign", 1) is None
    assert write(store, "v1") is False
