from __future__ import annotations

import pytest

from backend.designer_core.model import ImageLibraryEntry, Project, WidgetNode
from backend.lvgl_merge import MergeError, merge_project_into_yaml


def project_with_button() -> Project:
    project = Project()
    project.display_id_placeholder = "my_display"
    button = WidgetNode(id="button_1", widget_type="button")
    button.properties = {"text": "New Button"}
    project.widgets.append(button)
    return project


def test_merge_replaces_only_the_existing_lvgl_block() -> None:
    existing = (
        "esphome:\n"
        "  name: test-device\n"
        "\n"
        "wifi:\n"
        "  ssid: !secret wifi_ssid\n"
        "\n"
        "lvgl:\n"
        "  displays:\n"
        "  - my_display\n"
        "  widgets:\n"
        "  - label:\n"
        "      id: old_label\n"
        "      text: Old\n"
        "\n"
        "api:\n"
        "  encryption:\n"
        "    key: !secret api_key\n"
    )

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == ["lvgl"]
    assert result.appended_keys == []
    assert "esphome:\n  name: test-device" in result.content
    assert "wifi:\n  ssid: !secret wifi_ssid" in result.content
    assert "api:\n  encryption:\n    key: !secret api_key" in result.content
    assert "old_label" not in result.content
    assert "button_1" in result.content
    assert "New Button" in result.content


def test_merge_appends_a_missing_top_level_key_without_copying_the_file() -> None:
    existing = (
        "esphome:\n"
        "  name: test-device\n"
        "\n"
        "lvgl:\n"
        "  widgets:\n"
        "  - label:\n"
        "      id: old_label\n"
        "      text: Old\n"
    )
    project = Project()
    project.display_id_placeholder = "my_display"
    image = ImageLibraryEntry(id="my_icon")
    image.file_path = "images/my_icon.png"
    image.external = False
    project.images.append(image)
    widget = WidgetNode(id="icon_widget", widget_type="image")
    widget.properties = {"src": "my_icon"}
    project.widgets.append(widget)

    result = merge_project_into_yaml(project, existing)

    assert result.replaced_keys == ["lvgl"]
    assert result.appended_keys == ["image"]
    assert "image:\n- platform: file\n  id: my_icon\n  file: images/my_icon.png" in result.content
    assert "esphome:\n  name: test-device" in result.content


def test_merge_leaves_a_key_the_project_has_nothing_for_untouched() -> None:
    existing = (
        "color:\n"
        "- id: existing_color\n"
        "  hex: FF0000\n"
        "\n"
        "lvgl:\n"
        "  widgets: []\n"
    )

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == ["lvgl"]
    assert "existing_color" in result.content
    assert "color:" in result.content


def test_merge_appends_lvgl_when_the_target_has_none_yet() -> None:
    existing = "esphome:\n  name: test-device\n"

    result = merge_project_into_yaml(project_with_button(), existing)

    assert result.replaced_keys == []
    assert result.appended_keys == ["lvgl"]
    assert "esphome:\n  name: test-device" in result.content
    assert "button_1" in result.content


def test_merge_flags_a_background_image_id_colliding_with_a_real_image() -> None:
    """The bug this regresses: the reference-image background exports its
    own synthetic image: entry using project.background.image_id - unless
    that id is checked against the project's real images too, it can
    silently collide and the merged image: block ends up defining the same
    id twice, which ESPHome rejects at compile time with "ID ... redefined!"."""
    existing = "esphome:\n  name: test-device\n"
    project = project_with_button()
    image = ImageLibraryEntry(id="img_flow_00")
    image.file_path = "images/flow_00.png"
    project.images.append(image)
    project.background.path = "https://example.invalid/mockup.png"
    project.background.export_as_lvgl_image = True
    project.background.image_id = "img_flow_00"

    result = merge_project_into_yaml(project, existing)

    assert any("img_flow_00" in issue.message for issue in result.issues)


def test_merge_rejects_a_duplicate_top_level_key() -> None:
    existing = "lvgl:\n  widgets: []\nlvgl:\n  widgets: []\n"

    with pytest.raises(MergeError):
        merge_project_into_yaml(project_with_button(), existing)
