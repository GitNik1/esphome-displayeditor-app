"""Re-reading a project's source config: what changed, what would be lost."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.project_revisions import PROJECT_REVISION_LOCKED_DEPTH
from backend.settings import Settings

ADMIN = {"X-Remote-User-Id": "admin-user"}
NAME = "display.lvgldesign"
CONFIG = "display.yaml"

BASE_YAML = """\
esphome:
  name: display
sensor:
  - platform: template
    id: tank_level
    name: Tank
display:
  - platform: ili9xxx
    id: my_display
    dimensions:
      width: 320
      height: 240
lvgl:
  displays: [my_display]
  widgets:
    - label:
        id: title
        x: 10
        y: 10
        width: 100
        height: 20
        text: Hallo
"""

#: Same file with a second sensor added, the way the Device Builder would.
WITH_SECOND_SENSOR = BASE_YAML.replace(
    "display:\n  - platform: ili9xxx",
    "  - platform: template\n    id: pump_state\n    name: Pump\n"
    "display:\n  - platform: ili9xxx",
)


def make_client(tmp_path: Path, yaml_text: str = BASE_YAML) -> TestClient:
    config_root = tmp_path / "esphome"
    config_root.mkdir(exist_ok=True)
    (config_root / CONFIG).write_text(yaml_text, encoding="utf-8")
    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="administrator",
    )
    return TestClient(create_app(settings, serve_frontend=False))


def write_config(client: TestClient, tmp_path: Path, text: str) -> None:
    (tmp_path / "esphome" / CONFIG).write_text(text, encoding="utf-8")


def import_and_store(client: TestClient) -> dict:
    """Import the config the way the browser does, then save it under NAME."""
    imported = client.post(
        "/api/v1/designer/import",
        headers=ADMIN,
        json={"configuration": CONFIG, "canvas": {"width": 320, "height": 240}},
    )
    assert imported.status_code == 200, imported.text
    project = imported.json()["project"]
    saved = client.put(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        json={"project": project, "expected_revision": None},
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


def source_changes(client: TestClient) -> dict:
    response = client.get(f"/api/v1/designer/projects/{NAME}/source", headers=ADMIN)
    assert response.status_code == 200, response.text
    return response.json()


def group(plan: dict, key: str) -> dict:
    return next(item for item in plan["groups"] if item["key"] == key)


def test_import_records_the_source_revision_as_a_baseline(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    plan = source_changes(client)
    assert plan["available"] is True
    assert plan["source"]["known_revision"] == plan["source"]["revision"]
    assert plan["changed"] is False


def test_a_sensor_added_after_the_import_shows_up_with_its_line(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    write_config(client, tmp_path, WITH_SECOND_SENSOR)

    plan = source_changes(client)
    assert plan["changed"] is True
    entities = group(plan, "entities")
    added = [item for item in entities["changes"] if item["kind"] == "added"]
    assert [item["label"] for item in added] == ["sensor.pump_state"]
    # The line number is what makes the dialog checkable against the file: it
    # points at the first line of that sensor's block, not at its id: line.
    id_line = WITH_SECOND_SENSOR.splitlines().index("    id: pump_state") + 1
    assert added[0]["line"] == id_line - 1
    assert entities["removes"] == 0
    assert group(plan, "layout")["changed"] == 0


def test_only_the_ticked_group_is_adopted(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    write_config(
        client,
        tmp_path,
        WITH_SECOND_SENSOR.replace("text: Hallo", "text: Geaendert"),
    )

    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": ["entities"], "expected_revision": stored["revision"]},
    )
    assert applied.status_code == 200, applied.text
    project = applied.json()["project"]
    assert [entity["id"] for entity in project["entities"]] == [
        "pump_state",
        "tank_level",
    ]
    # Layout was not ticked, so the label the config changed stays as it was.
    assert project["widgets"][0]["properties"]["text"] == "Hallo"
    assert applied.json()["dropped_bindings"] == []


def test_adopting_the_layout_reports_the_widget_it_removes(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    write_config(client, tmp_path, BASE_YAML.replace("id: title", "id: heading"))

    layout = group(source_changes(client), "layout")
    kinds = {item["kind"]: item["label"] for item in layout["changes"]}
    assert kinds["removed"] == "label title"
    assert kinds["added"] == "label heading"
    assert [item["label"] for item in layout["losses"]] == ["label title"]


def test_a_binding_onto_a_removed_widget_is_named_and_then_dropped(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    stored = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    project = stored["project"]
    project["bindings"] = [
        {
            "id": "show_level",
            "direction": "entity_to_widget",
            "source": {"domain": "sensor", "id": "tank_level"},
            "target": {"widget_id": "title", "property": "text"},
        }
    ]
    saved = client.put(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        json={"project": project, "expected_revision": stored["revision"]},
    )
    assert saved.status_code == 200, saved.text
    write_config(client, tmp_path, BASE_YAML.replace("id: title", "id: heading"))

    plan = source_changes(client)
    assert [item["id"] for item in plan["binding_losses"]] == ["show_level"]

    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": ["layout"], "expected_revision": saved.json()["revision"]},
    )
    # Without the prune this is a 422: the binding would point at a widget the
    # adopted layout no longer has, which project validation refuses outright.
    assert applied.status_code == 200, applied.text
    assert [item["id"] for item in applied.json()["dropped_bindings"]] == ["show_level"]
    assert applied.json()["project"]["bindings"] == []


def test_the_resync_is_a_normal_version_and_can_be_rolled_back(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    write_config(client, tmp_path, WITH_SECOND_SENSOR)
    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": ["entities"], "expected_revision": stored["revision"]},
    )
    assert applied.status_code == 200, applied.text

    versions = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()["versions"]
    assert versions[0]["origin"] == "resync"

    restored = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{versions[1]['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": applied.json()["revision"]},
    )
    assert restored.status_code == 200, restored.text
    project = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    assert [entity["id"] for entity in project["project"]["entities"]] == ["tank_level"]


def test_the_version_says_what_the_import_was_and_what_it_displaced(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    write_config(client, tmp_path, WITH_SECOND_SENSOR)
    before = source_changes(client)["source"]

    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": ["entities"], "expected_revision": stored["revision"]},
    )
    assert applied.status_code == 200, applied.text

    versions = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()["versions"]
    details = versions[0]["details"]
    assert details["groups"] == ["entities"]
    assert details["source"]["name"] == CONFIG
    # Both ends of the move, so the timeline can show the config itself
    # changing rather than only the project following it.
    assert details["source"]["previous_revision"] == before["known_revision"]
    assert details["source"]["revision"] == before["revision"]
    assert details["source"]["revision"] != details["source"]["previous_revision"]
    # The undo target: the state this import replaced.
    assert details["replaced_revision"] == stored["revision"]
    assert versions[1]["revision"] == details["replaced_revision"]
    # An ordinary editor save describes nothing, and says so as null.
    assert versions[1]["details"] is None


def test_the_replaced_version_is_what_undoing_the_import_restores(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    write_config(client, tmp_path, WITH_SECOND_SENSOR)
    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": ["entities"], "expected_revision": stored["revision"]},
    ).json()

    versions = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()["versions"]
    target = next(
        item for item in versions
        if item["revision"] == versions[0]["details"]["replaced_revision"]
    )
    restored = client.post(
        f"/api/v1/designer/projects/{NAME}/revisions/{target['id']}/restore",
        headers=ADMIN,
        json={"expected_revision": applied["revision"]},
    )
    assert restored.status_code == 200, restored.text
    project = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    assert [entity["id"] for entity in project["project"]["entities"]] == ["tank_level"]


def test_the_pre_import_version_can_be_locked_along_with_the_import(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    write_config(client, tmp_path, WITH_SECOND_SENSOR)
    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={
            "groups": ["entities"],
            "expected_revision": stored["revision"],
            "lock_previous": True,
        },
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["previous_locked"]["locked"] is True

    versions = client.get(
        f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
    ).json()["versions"]
    assert versions[0]["locked"] is False
    assert versions[1]["locked"] is True


def test_a_full_lock_quota_reports_itself_without_failing_the_import(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    # Fill the lock quota with versions that have nothing to do with imports.
    revision = stored["revision"]
    project = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    payload = project["project"]
    for index in range(PROJECT_REVISION_LOCKED_DEPTH):
        payload["widgets"][0]["properties"]["text"] = f"Stand {index}"
        saved = client.put(
            f"/api/v1/designer/projects/{NAME}",
            headers=ADMIN,
            json={"project": payload, "expected_revision": revision},
        ).json()
        revision = saved["revision"]
        newest = client.get(
            f"/api/v1/designer/projects/{NAME}/revisions", headers=ADMIN
        ).json()["versions"][0]
        client.post(
            f"/api/v1/designer/projects/{NAME}/revisions/{newest['id']}/lock",
            headers=ADMIN,
        )

    # One more unlocked save, so the version the import displaces is not one of
    # the five already pinned - re-locking those would succeed trivially.
    payload["widgets"][0]["properties"]["text"] = "Stand vor dem Import"
    revision = client.put(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        json={"project": payload, "expected_revision": revision},
    ).json()["revision"]

    write_config(client, tmp_path, WITH_SECOND_SENSOR)
    applied = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={
            "groups": ["entities"],
            "expected_revision": revision,
            "lock_previous": True,
        },
    )
    # The import is what the user asked for; the lock is a nicety on top.
    assert applied.status_code == 200, applied.text
    assert applied.json()["previous_locked"] == {
        "locked": False,
        "reason": "revision_lock_limit",
        "id": applied.json()["previous_locked"]["id"],
    }
    assert [entity["id"] for entity in applied.json()["project"]["entities"]] == [
        "pump_state",
        "tank_level",
    ]


def test_a_project_without_a_source_reports_that_instead_of_failing(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    stored = client.get(f"/api/v1/designer/projects/{NAME}", headers=ADMIN).json()
    project = stored["project"]
    project["import_source"] = {}
    client.put(
        f"/api/v1/designer/projects/{NAME}",
        headers=ADMIN,
        json={"project": project, "expected_revision": stored["revision"]},
    )
    assert source_changes(client)["reason"] == "no_source"


def test_a_deleted_source_config_reports_that_instead_of_failing(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    import_and_store(client)
    (tmp_path / "esphome" / CONFIG).unlink()
    plan = source_changes(client)
    assert plan["available"] is False
    assert plan["reason"] == "source_missing"


def test_applying_nothing_is_rejected(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    stored = import_and_store(client)
    response = client.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=ADMIN,
        json={"groups": [], "expected_revision": stored["revision"]},
    )
    assert response.status_code == 422, response.text


def test_applying_needs_write_access(tmp_path: Path) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir(exist_ok=True)
    (config_root / CONFIG).write_text(BASE_YAML, encoding="utf-8")
    admin_client = make_client(tmp_path)
    stored = import_and_store(admin_client)

    settings = Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=config_root,
        data_root=tmp_path / "data",
        default_role="viewer",
    )
    viewer = TestClient(create_app(settings, serve_frontend=False))
    headers = {"X-Remote-User-Id": "viewer-user"}
    # A viewer may look at the drift ...
    assert viewer.get(
        f"/api/v1/designer/projects/{NAME}/source", headers=headers
    ).status_code == 200
    # ... but not adopt it.
    assert viewer.post(
        f"/api/v1/designer/projects/{NAME}/source/apply",
        headers=headers,
        json={"groups": ["entities"], "expected_revision": stored["revision"]},
    ).status_code == 403
