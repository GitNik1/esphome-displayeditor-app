from __future__ import annotations

import yaml

from backend.designer import DesignerService
from backend.designer_core.model import Project
from backend.designer_core.yamlimport import import_esphome_yaml
from backend.page_support import materialize_surfaces


PAGES_YAML = """
display:
  - platform: test
    id: screen
    dimensions:
      width: 320
      height: 240
lvgl:
  displays: [screen]
  page_wrap: false
  pages:
    - id: main_page
      bg_color: 0x101820
      layout:
        type: FLEX
        flex_flow: COLUMN
      widgets:
        - button:
            id: next_button
            text: Next
            on_click:
              - lvgl.page.next: {}
    - id: hidden_page
      skip: true
      widgets:
        - label:
            id: hidden_label
            text: Hidden
    - id: settings_page
      custom_page_option: preserved
      widgets:
        - label:
            id: settings_label
            text: Settings
  bottom_layer:
    bg_color: 0x000011
    widgets:
      - label:
          id: background_label
          text: Background
  top_layer:
    layout:
      type: FLEX
    widgets:
      - label:
          id: header_label
          text: Header
"""


def test_adapter_materializes_pages_without_changing_shared_core() -> None:
    project = import_esphome_yaml(PAGES_YAML).project

    payload, stats = materialize_surfaces(project)

    assert project.widgets == []
    assert list(project.all_widgets()) == []
    assert set(project.extra_lvgl) == {
        "page_wrap", "pages", "bottom_layer", "top_layer",
    }
    assert [page["id"] for page in payload["pages"]] == [
        "main_page", "hidden_page", "settings_page",
    ]
    assert payload["pages"][0]["layout"] == {"type": "FLEX", "flex_flow": "COLUMN"}
    assert payload["pages"][0]["style_tree"]["bg_color"] == "101820"
    assert payload["pages"][1]["skip"] is True
    assert payload["pages"][2]["extra"] == {"custom_page_option": "preserved"}
    assert payload["page_wrap"] is False
    assert payload["bottom_layer"]["style_tree"]["bg_color"] == "000011"
    assert payload["top_layer"]["layout"] == {"type": "FLEX"}
    assert stats == {
        "page_count": 3,
        "surface_widget_count": 5,
        "surface_widget_types": {"button": 1, "label": 4},
        "has_top_layer": True,
        "has_bottom_layer": True,
    }


def test_service_import_reports_surface_widgets(tmp_path) -> None:
    result = DesignerService(tmp_path).import_yaml(PAGES_YAML)

    assert result["valid"] is True
    assert result["stats"]["page_count"] == 3
    assert result["stats"]["widget_count"] == 5
    assert result["stats"]["widget_types"] == {"button": 1, "label": 4}
    assert result["stats"]["has_top_layer"] is True
    assert result["project"]["pages"][0]["widgets"][0]["id"] == "next_button"


def test_page_yaml_round_trip_preserves_structure(tmp_path) -> None:
    service = DesignerService(tmp_path)
    imported = service.import_yaml(PAGES_YAML)
    exported = service.export_yaml(imported["project"])
    lvgl = yaml.safe_load(exported["yaml"])["lvgl"]

    assert "widgets" not in lvgl
    assert lvgl["page_wrap"] is False
    assert [page["id"] for page in lvgl["pages"]] == [
        "main_page", "hidden_page", "settings_page",
    ]
    assert lvgl["pages"][0]["bg_color"] == 0x101820
    assert lvgl["pages"][0]["layout"]["flex_flow"] == "COLUMN"
    assert lvgl["pages"][0]["widgets"][0]["button"]["on_click"] == [
        {"lvgl.page.next": {}}
    ]
    assert lvgl["pages"][1]["skip"] is True
    assert lvgl["pages"][2]["custom_page_option"] == "preserved"
    assert lvgl["bottom_layer"]["widgets"][0]["label"]["id"] == "background_label"
    assert lvgl["top_layer"]["widgets"][0]["label"]["id"] == "header_label"


def test_stored_core_payload_can_be_materialized_again(tmp_path) -> None:
    service = DesignerService(tmp_path)
    imported = service.import_yaml(PAGES_YAML)["project"]
    restored_core = Project.from_dict(imported)

    restored = service.project_payload(restored_core)

    assert restored["format_version"] == 3
    assert restored["pages"][2]["widgets"][0]["id"] == "settings_label"
    assert restored["top_layer"]["widgets"][0]["id"] == "header_label"


def test_edited_surface_payload_is_persisted_and_exported(tmp_path) -> None:
    service = DesignerService(tmp_path)
    payload = service.import_yaml(PAGES_YAML)["project"]
    page = payload["pages"][0]
    page["id"] = "dashboard_page"
    page["synthetic_id"] = False
    page["skip"] = True
    page["layout"] = {"type": "GRID", "grid_rows": [40, "FR(1)"]}
    page["style_tree"]["bg_color"] = "203040"
    page["widgets"].append({
        "id": "added_label",
        "widget_type": "label",
        "properties": {"text": "Neu"},
        "children": [],
    })
    payload["page_wrap"] = True
    payload["top_layer"] = None

    project, issues = service.validate(payload)
    assert not [issue for issue in issues if issue["severity"] == "error"]
    restored = service.project_payload(project)
    assert restored["pages"][0]["id"] == "dashboard_page"
    assert restored["pages"][0]["skip"] is True
    assert restored["pages"][0]["layout"] == {
        "type": "GRID", "grid_rows": [40, "FR(1)"]}
    assert restored["pages"][0]["style_tree"]["bg_color"] == "203040"
    assert restored["pages"][0]["widgets"][-1]["properties"]["text"] == "Neu"
    assert restored["page_wrap"] is True
    assert restored["top_layer"] is None

    lvgl = yaml.safe_load(service.export_yaml(payload)["yaml"])["lvgl"]
    assert lvgl["pages"][0]["id"] == "dashboard_page"
    assert lvgl["pages"][0]["skip"] is True
    assert lvgl["pages"][0]["layout"]["type"] == "GRID"
    assert lvgl["pages"][0]["bg_color"] == 0x203040
    assert lvgl["pages"][0]["widgets"][-1]["label"]["text"] == "Neu"
    assert lvgl["page_wrap"] is True
    assert "top_layer" not in lvgl


def test_version_three_root_widget_project_remains_unchanged() -> None:
    old = {
        "format": "esphome-lvgl-designer-project",
        "format_version": 3,
        "canvas": {"width": 320, "height": 240},
        "widgets": [{"id": "old_label", "widget_type": "label"}],
    }

    project = Project.from_dict(old)
    payload, stats = materialize_surfaces(project)

    assert project.find_widget("old_label") is not None
    assert payload["pages"] == []
    assert payload["top_layer"] is None
    assert payload["page_wrap"] is True
    assert stats["surface_widget_count"] == 0


def test_designer_validation_includes_materialized_pages_and_layers(tmp_path) -> None:
    service = DesignerService(tmp_path)
    payload = service.import_yaml(PAGES_YAML)["project"]

    _validated, issues = service.validate(payload)
    assert not [issue for issue in issues if issue["severity"] == "error"]

    payload["pages"][0]["id"] = "header_label"
    payload["pages"][0]["synthetic_id"] = False
    _validated, issues = service.validate(payload)
    assert any("Duplicate id" in issue["message"] for issue in issues)
