from __future__ import annotations

from backend.api.viewer_projection import (
    project_widget_types,
    viewer_entity,
    viewer_entity_id,
    viewer_state,
)


def test_viewer_entity_id_requires_type_and_key() -> None:
    assert viewer_entity_id({"type": "sensor", "key": 42}) == "sensor:42"
    assert viewer_entity_id({"type": "switch", "object_id": "pump"}) == "switch:pump"
    assert viewer_entity_id({"key": 42}) is None
    assert viewer_entity_id({"type": "sensor"}) is None


def test_viewer_entity_removes_runtime_and_secret_fields() -> None:
    projected = viewer_entity(
        {
            "type": "sensor",
            "key": 7,
            "name": "Temperature",
            "unit_of_measurement": "°C",
            "internal_token": "must-not-leak",
        }
    )

    assert projected == {
        "entity_id": "sensor:7",
        "type": "sensor",
        "key": 7,
        "name": "Temperature",
        "unit_of_measurement": "°C",
    }


def test_viewer_state_keeps_only_viewer_state_fields() -> None:
    assert viewer_state(
        {
            "type": "binary_sensor",
            "object_id": "door",
            "state": True,
            "available": True,
            "raw_payload": "must-not-leak",
        }
    ) == {
        "entity_id": "binary_sensor:door",
        "type": "binary_sensor",
        "object_id": "door",
        "state": True,
        "available": True,
    }


def test_project_widget_types_visits_every_supported_surface() -> None:
    project = {
        "widgets": [
            {
                "id": "root",
                "widget_type": "obj",
                "children": [{"id": "nested", "widget_type": "label"}],
            }
        ],
        "pages": [{"widgets": [{"id": "page", "widget_type": "button"}]}],
        "top_layer": {"widgets": [{"id": "top", "widget_type": "image"}]},
        "bottom_layer": {
            "widgets": [{"id": "bottom", "widget_type": "slider"}]
        },
        "msgboxes": [
            {
                "buttons": [{"id": "dialog", "widget_type": "button"}],
                "header_buttons": [
                    {"id": "dialog_close", "widget_type": "button"}
                ],
            }
        ],
    }

    assert project_widget_types(project) == {
        "root": "obj",
        "nested": "label",
        "page": "button",
        "top": "image",
        "bottom": "slider",
        "dialog": "button",
        "dialog_close": "button",
    }


def test_project_widget_types_ignores_malformed_collections() -> None:
    assert project_widget_types(
        {"widgets": "invalid", "pages": {}, "msgboxes": [None, "invalid"]}
    ) == {}

