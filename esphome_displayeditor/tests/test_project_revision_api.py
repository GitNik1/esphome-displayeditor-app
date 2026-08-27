from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.project_revisions import PROJECT_REVISION_LOCKED_DEPTH
from backend.settings import Settings

from .test_designer import project_with_button

ADMIN = {"X-Remote-User-Id": "admin-user"}
NAME = "display.lvgldesign"


def make_client(tmp_path: Path, *, default_role: str = "administrator") -> TestClient:
    config_root = tmp_path / "esphome"
    config_root.mkdir(exist_ok=True)
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role=default_role,
    )
    return TestClient(create_app(settings, serve_frontend=False))


def save(client: TestClient, project: dict, revision: str | None) -> dict:
    response = client.put(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        json={"project": project, "expected_revision": revision},
    )
    assert response.status_code == 200, response.text
    return response.json()


def seed(client: TestClient, widths: list[int]) -> list[dict]:
    project = project_with_button()
    results = []
    revision = None
    for width in widths:
        project["canvas"]["width"] = width
        result = save(client, project, revision)
        revision = result["revision"]
        results.append(result)
    return results


def versions(client: TestClient) -> list[dict]:
    response = client.get(f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN)
    assert response.status_code == 200, response.text
    return response.json()["versions"]


def test_versions_are_listed_with_the_current_one_marked(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    saved = seed(client, [480, 600, 800])

    body = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()
    assert body["exists"] is True
    assert body["current_revision"] == saved[-1]["revision"]
    assert body["depth"] == 10
    assert body["locked_used"] == 0
    assert [item["revision"] for item in body["versions"]] == [
        saved[2]["revision"],
        saved[1]["revision"],
        saved[0]["revision"],
    ]
    assert [item["is_current"] for item in body["versions"]] == [True, False, False]
    assert all(item["origin"] == "ui" for item in body["versions"])


def test_reading_a_version_reports_validation_without_raising(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 600])
    oldest = versions(client)[-1]

    body = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}", headers=ADMIN
    ).json()
    assert body["project"]["canvas"]["width"] == 480
    assert body["restorable"] is True


def test_a_version_of_another_project_is_not_found(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 600])
    version_id = versions(client)[0]["id"]

    response = client.get(
        f"/api/v1/designer/projects/other.lvgldesign/revisions/{version_id}",
        headers=ADMIN,
    )
    assert response.status_code == 404
    assert response.json()["error"] == "revision_not_found"


def test_diff_against_current_and_against_another_version(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 800])
    listed = versions(client)
    oldest = listed[-1]

    against_current = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}/diff", headers=ADMIN
    ).json()
    assert '-    "width": 480' in against_current["diff"]
    assert '+    "width": 800' in against_current["diff"]
    assert against_current["diff_truncated"] is False
    assert against_current["to"]["id"] is None

    against_version = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}/diff",
        params={"against": listed[0]["id"]},
        headers=ADMIN,
    ).json()
    assert against_version["to"]["id"] == listed[0]["id"]

    invalid = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}/diff",
        params={"against": "nonsense"},
        headers=ADMIN,
    )
    assert invalid.status_code == 400


def test_restore_adds_a_version_and_leaves_the_displaced_one_in_place(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    saved = seed(client, [480, 600, 800])
    listed = versions(client)
    target = listed[-1]
    assert target["revision"] == saved[0]["revision"]

    response = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{target['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": saved[-1]["revision"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["restored_from"]["id"] == target["id"]

    after = versions(client)
    # The restored state is a new entry on top; nothing was rewound.
    assert after[0]["origin"] == "restore"
    assert after[0]["restored_from"] == target["id"]
    assert after[0]["revision"] == saved[0]["revision"]
    assert after[0]["is_current"] is True
    # The displaced version is still there, so the restore is itself undoable.
    assert after[1]["revision"] == saved[2]["revision"]
    assert after[1]["origin"] == "ui"
    assert len(after) == len(listed) + 1

    read_back = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    assert read_back["project"]["canvas"]["width"] == 480


def test_only_the_newest_matching_version_is_marked_current(tmp_path: Path) -> None:
    """A restored version is byte-identical to its source, so both rows share
    a revision - but only one of them is the state on disk."""
    client = make_client(tmp_path)
    saved = seed(client, [480, 800])
    source = versions(client)[-1]

    client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{source['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": saved[-1]["revision"]},
    )

    after = versions(client)
    assert after[0]["revision"] == after[-1]["revision"]
    assert [item["is_current"] for item in after] == [True, False, False]


def test_restoring_the_displaced_version_returns_to_the_starting_point(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    saved = seed(client, [480, 800])
    oldest = versions(client)[-1]

    client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": saved[-1]["revision"]},
    )
    displaced = versions(client)[1]
    current = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()["current_revision"]

    second = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{displaced['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": current},
    )
    assert second.status_code == 200, second.text
    read_back = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    assert read_back["project"]["canvas"]["width"] == 800


def test_restore_rejects_a_stale_expected_revision(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 600])
    oldest = versions(client)[-1]

    response = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{oldest['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": "sha256:" + "0" * 64},
    )
    assert response.status_code == 409
    assert response.json()["error"] == "revision_conflict"


def test_restoring_a_deleted_project_recreates_it(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    saved = seed(client, [480, 600])
    deleted = client.delete(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        params={"expected_revision": saved[-1]["revision"]},
    )
    assert deleted.status_code == 200

    listing = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()
    assert listing["exists"] is False
    assert listing["versions"][0]["action"] == "delete"
    content_row = listing["versions"][1]

    restored = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{content_row['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": None},
    )
    assert restored.status_code == 200, restored.text
    read_back = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    assert read_back["project"]["canvas"]["width"] == 600


def test_a_tombstone_cannot_be_restored(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    saved = seed(client, [480])
    client.delete(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        params={"expected_revision": saved[-1]["revision"]},
    )
    tombstone = versions(client)[0]

    response = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{tombstone['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": None},
    )
    assert response.status_code == 409
    assert response.json()["error"] == "revision_not_restorable"


def test_label_and_lock_do_not_affect_each_other(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 600])
    version_id = versions(client)[-1]["id"]

    labelled = client.patch(
        f"/api/v1/designer/projects/{NAME}/revisions/{version_id}",
        headers=ADMIN,
        json={"label": "vor dem Umbau"},
    ).json()
    assert labelled["label"] == "vor dem Umbau"
    assert labelled["locked"] is False

    locked = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{version_id}/lock", headers=ADMIN
    ).json()
    assert locked["locked"] is True
    assert locked["label"] == "vor dem Umbau"

    cleared = client.patch(
        f"/api/v1/designer/projects/{NAME}/revisions/{version_id}",
        headers=ADMIN,
        json={"label": None},
    ).json()
    assert cleared["label"] is None
    assert cleared["locked"] is True

    unlocked = client.delete(
        f"/api/v1/designer/projects/{NAME}/revisions/{version_id}/lock", headers=ADMIN
    ).json()
    assert unlocked["locked"] is False


def test_lock_quota_is_reported_as_a_conflict(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, list(range(480, 480 + PROJECT_REVISION_LOCKED_DEPTH + 1)))
    listed = versions(client)

    for item in listed[:PROJECT_REVISION_LOCKED_DEPTH]:
        assert (
            client.post(
                f"/api/v1/designer/projects/{NAME}/revisions/{item['id']}/lock",
                headers=ADMIN,
            ).status_code
            == 200
        )

    response = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions"
        f"/{listed[PROJECT_REVISION_LOCKED_DEPTH]['id']}/lock",
        headers=ADMIN,
    )
    assert response.status_code == 409
    assert response.json()["error"] == "revision_lock_limit"


def test_feed_is_chronological_across_projects(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    seed(client, [480, 600])
    client.put(
        "/api/v1/designer/projects/other.lvgldesign",
        headers=ADMIN,
        json={"project": project_with_button(), "expected_revision": None},
    )

    body = client.get("/api/v1/designer/revisions", headers=ADMIN).json()
    assert body["events"][0]["project_name"] == "other.lvgldesign"
    assert all(item["project_exists"] for item in body["events"])
    assert client.get(
        "/api/v1/designer/revisions", params={"limit": 1}, headers=ADMIN
    ).json()["limit"] == 1
    assert (
        client.get(
            "/api/v1/designer/revisions", params={"limit": 0}, headers=ADMIN
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    ("method", "suffix", "payload"),
    [
        ("patch", "", {"label": "x"}),
        ("post", "/lock", None),
        ("delete", "/lock", None),
        ("post", "/restore", {"expected_revision": None}),
    ],
)
def test_write_routes_require_the_editor_role(
    tmp_path: Path, method: str, suffix: str, payload: dict | None
) -> None:
    admin_client = make_client(tmp_path)
    seed(admin_client, [480, 600])
    version_id = versions(admin_client)[-1]["id"]

    viewer = make_client(tmp_path, default_role="viewer")
    response = getattr(viewer, method)(
        f"/api/v1/designer/projects/{NAME}/revisions/{version_id}{suffix}",
        headers={"X-Remote-User-Id": "viewer-user"},
        **({"json": payload} if payload is not None else {}),
    )
    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "permission_denied"
    assert body["details"]["required_role"] == "editor"


def test_actor_identities_are_hidden_from_non_administrators(tmp_path: Path) -> None:
    admin_client = make_client(tmp_path)
    seed(admin_client, [480, 600])

    admin_feed = admin_client.get("/api/v1/designer/revisions", headers=ADMIN).json()
    assert admin_feed["events"][0]["actor"] == "ha:admin-user"

    viewer = make_client(tmp_path, default_role="viewer")
    viewer_feed = viewer.get(
        "/api/v1/designer/revisions", headers={"X-Remote-User-Id": "viewer-user"}
    ).json()
    assert viewer_feed["events"][0]["actor"] is None
    # Origin and action stay visible - that is the point of the feed.
    assert viewer_feed["events"][0]["origin"] == "ui"
