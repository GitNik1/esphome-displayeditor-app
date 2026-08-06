from __future__ import annotations

import yaml

from backend.designer import DesignerService
from backend.designer_core.model import Project
from backend.designer_core.yamlimport import import_esphome_yaml
from backend.msgbox_support import materialize_msgboxes


MSGBOXES_YAML = """
display:
  - platform: test
    id: screen
    dimensions:
      width: 320
      height: 240
lvgl:
  displays: [screen]
  widgets:
    - button:
        id: open_button
        text: Open
        on_click:
          - lvgl.widget.show: message_box
  msgboxes:
    - id: message_box
      close_button: true
      title: Message box
      body:
        text: "This is a sample message box."
        bg_color: 0x808080
      buttons:
        - id: msgbox_apply
          text: "Apply"
        - id: msgbox_close
          text: "Close"
          on_click:
            - lvgl.widget.hide: message_box
      header_buttons:
        - id: msgbox_help
          src: help_icon
    - title: Confirm
      close_button: false
      custom_msgbox_option: preserved
      buttons:
        - id: confirm_yes
          text: "Yes"
"""


def test_adapter_materializes_msgboxes_without_changing_shared_core() -> None:
    project = import_esphome_yaml(MSGBOXES_YAML).project

    payload, stats = materialize_msgboxes(project)

    assert [w.id for w in project.all_widgets()] == ["open_button"]
    assert "msgboxes" in project.extra_lvgl

    assert [msgbox["id"] for msgbox in payload] == ["message_box", payload[1]["id"]]
    first, second = payload
    assert first["synthetic_id"] is False
    assert first["title"] == "Message box"
    assert first["close_button"] is True
    assert first["body"]["text"] == "This is a sample message box."
    assert first["body"]["style_tree"]["bg_color"] == "808080"
    assert [b["id"] for b in first["buttons"]] == ["msgbox_apply", "msgbox_close"]
    assert first["buttons"][1]["events"]["on_click"] == [{"lvgl.widget.hide": "message_box"}]
    assert [b["id"] for b in first["header_buttons"]] == ["msgbox_help"]

    assert second["synthetic_id"] is True
    assert second["title"] == "Confirm"
    assert second["close_button"] is False
    assert second["extra"] == {"custom_msgbox_option": "preserved"}
    assert [b["id"] for b in second["buttons"]] == ["confirm_yes"]

    assert stats == {"msgbox_count": 2, "msgbox_widget_count": 4}


def test_service_import_reports_msgbox_widgets(tmp_path) -> None:
    result = DesignerService(tmp_path).import_yaml(MSGBOXES_YAML)

    assert result["valid"] is True
    assert result["stats"]["msgbox_count"] == 2
    assert result["project"]["msgboxes"][0]["buttons"][0]["id"] == "msgbox_apply"


def test_msgbox_yaml_round_trip_preserves_structure(tmp_path) -> None:
    service = DesignerService(tmp_path)
    imported = service.import_yaml(MSGBOXES_YAML)
    exported = service.export_yaml(imported["project"])
    lvgl = yaml.safe_load(exported["yaml"])["lvgl"]

    assert [msgbox.get("id") for msgbox in lvgl["msgboxes"]] == ["message_box", None]
    assert lvgl["msgboxes"][0]["title"] == "Message box"
    assert lvgl["msgboxes"][0]["body"]["text"] == "This is a sample message box."
    assert lvgl["msgboxes"][0]["body"]["bg_color"] == 0x808080
    assert lvgl["msgboxes"][0]["buttons"][0]["id"] == "msgbox_apply"
    assert lvgl["msgboxes"][0]["buttons"][0]["text"] == "Apply"
    assert lvgl["msgboxes"][0]["buttons"][1]["on_click"] == [
        {"lvgl.widget.hide": "message_box"}
    ]
    assert lvgl["msgboxes"][0]["header_buttons"][0]["src"] == "help_icon"
    assert lvgl["msgboxes"][1]["title"] == "Confirm"
    assert lvgl["msgboxes"][1]["close_button"] is False
    assert lvgl["msgboxes"][1]["custom_msgbox_option"] == "preserved"
    assert "id" not in lvgl["msgboxes"][1]

    # The root widget list and the on_click reference to the msgbox id must
    # survive the round trip untouched too.
    assert lvgl["widgets"][0]["button"]["on_click"] == [
        {"lvgl.widget.show": "message_box"}
    ]


def test_msgbox_buttons_never_export_editor_canvas_position(tmp_path) -> None:
    """A msgbox's buttons/header_buttons are auto-laid-out by LVGL in a row,
    not placed at an absolute canvas position - the x/y the designer's own
    canvas assigns a newly-placed button must never leak into the exported
    YAML there, or it would (at best) be meaningless noise and (at worst)
    break the real auto-layout. width/height are legitimate and must be
    kept - a real msgbox button can have an explicit size."""
    service = DesignerService(tmp_path)
    project = {
        "format": "esphome-lvgl-designer-project",
        "format_version": 3,
        "canvas": {"width": 480, "height": 320},
        "display_id_placeholder": "my_display",
        "widgets": [],
    }
    project["msgboxes"] = [
        {
            "id": "main_msgbox", "synthetic_id": False, "title": "Confirm",
            "close_button": True, "body": {"text": "", "style_tree": {}, "extra": {}},
            "buttons": [
                {
                    "id": "apply_button", "widget_type": "button",
                    "x": 20, "y": 20, "width": 120, "height": 50,
                    "properties": {"text": "Apply"}, "style_tree": {}, "children": [],
                },
            ],
            "header_buttons": [], "extra": {},
        },
    ]

    exported = service.export_yaml(project)["yaml"]
    lvgl = yaml.safe_load(exported)["lvgl"]
    button = lvgl["msgboxes"][0]["buttons"][0]
    assert "x" not in button
    assert "y" not in button
    assert button["width"] == 120
    assert button["height"] == 50


def test_stored_core_payload_can_be_materialized_again(tmp_path) -> None:
    service = DesignerService(tmp_path)
    imported = service.import_yaml(MSGBOXES_YAML)["project"]
    restored_core = Project.from_dict(imported)

    restored = service.project_payload(restored_core)

    assert restored["msgboxes"][0]["title"] == "Message box"
    assert restored["msgboxes"][0]["buttons"][0]["id"] == "msgbox_apply"


def test_edited_msgbox_payload_is_persisted_and_exported(tmp_path) -> None:
    service = DesignerService(tmp_path)
    payload = service.import_yaml(MSGBOXES_YAML)["project"]
    msgbox = payload["msgboxes"][0]
    msgbox["title"] = "Renamed box"
    msgbox["close_button"] = False
    msgbox["body"]["text"] = "Updated body"
    msgbox["buttons"].append({
        "id": "msgbox_cancel",
        "widget_type": "button",
        "properties": {"text": "Cancel"},
        "children": [],
    })

    project, issues = service.validate(payload)
    assert not [issue for issue in issues if issue["severity"] == "error"]
    restored = service.project_payload(project)
    assert restored["msgboxes"][0]["title"] == "Renamed box"
    assert restored["msgboxes"][0]["close_button"] is False
    assert restored["msgboxes"][0]["body"]["text"] == "Updated body"
    assert restored["msgboxes"][0]["buttons"][-1]["id"] == "msgbox_cancel"

    lvgl = yaml.safe_load(service.export_yaml(payload)["yaml"])["lvgl"]
    assert lvgl["msgboxes"][0]["title"] == "Renamed box"
    assert lvgl["msgboxes"][0]["close_button"] is False
    assert lvgl["msgboxes"][0]["body"]["text"] == "Updated body"
    assert lvgl["msgboxes"][0]["buttons"][-1]["text"] == "Cancel"


def test_designer_validation_catches_duplicate_msgbox_button_ids(tmp_path) -> None:
    service = DesignerService(tmp_path)
    payload = service.import_yaml(MSGBOXES_YAML)["project"]

    _validated, issues = service.validate(payload)
    assert not [issue for issue in issues if issue["severity"] == "error"]

    payload["msgboxes"][0]["buttons"][1]["id"] = "msgbox_apply"
    _validated, issues = service.validate(payload)
    assert any("Duplicate id" in issue["message"] for issue in issues)
