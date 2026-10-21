"""Merging LVGL into a configuration whose display draws by itself.

Modelled on paper-color.yaml: an e-paper drawn by a display ``lambda:`` and
no ``lvgl:`` block at all.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.designer_core.model import Project, WidgetNode
from backend.designer_core.yamlimport import load_lvgl_yaml
from backend.display_targets import COMMENT_MARKER
from backend.lvgl_merge import DisplayTakeoverRequired, MergeError, merge_project_into_yaml
from backend.settings import Settings

LAMBDA_DISPLAY = """\
esphome:
  name: paper

display:
  - platform: epaper_spi
    id: epd
    model: Spectra-E6
    update_interval: never
    lambda: |-
      const Color c_white(255, 255, 255);
      it.fill(c_white);

      // Statusstreifen
      it.print(0, 0, id(font_status), "Akku");
    dimensions:
      width: 400
      height: 600

font:
  - file: "gfonts://Roboto"
    id: font_status
    size: 16
"""


def new_project() -> Project:
    """What a fresh Designer project looks like: the my_display placeholder."""
    project = Project()
    project.canvas_width, project.canvas_height = 400, 600
    label = WidgetNode(id="hello", widget_type="label")
    label.properties = {"text": "Hallo"}
    project.widgets.append(label)
    return project


def test_a_drawing_display_needs_confirmation() -> None:
    with pytest.raises(DisplayTakeoverRequired) as refused:
        merge_project_into_yaml(new_project(), LAMBDA_DISPLAY)

    assert refused.value.conflicts == [{"display_id": "epd", "keys": ["lambda"], "line": 9}]


def test_confirmed_takeover_comments_the_lambda_out_and_keeps_it() -> None:
    merged = merge_project_into_yaml(new_project(), LAMBDA_DISPLAY, display_takeover="comment")

    doc = load_lvgl_yaml(merged.content)
    assert "lambda" not in doc["display"][0]
    assert doc["lvgl"]["displays"] == ["epd"]
    assert f"    {COMMENT_MARKER}\n    # lambda: |-\n" in merged.content
    assert "    #   it.print(0, 0, id(font_status), \"Akku\");\n" in merged.content
    # The keys after the lambda are untouched.
    assert doc["display"][0]["dimensions"] == {"width": 400, "height": 600}
    assert merged.display_takeover == [{"display_id": "epd", "keys": ["lambda"], "line": 9}]
    assert any("commented out" in issue.message for issue in merged.issues)


def test_a_display_without_id_gets_no_displays_entry() -> None:
    content = LAMBDA_DISPLAY.replace("    id: epd\n", "").replace(
        "    lambda: |-\n      const Color c_white(255, 255, 255);\n      it.fill(c_white);\n\n"
        "      // Statusstreifen\n      it.print(0, 0, id(font_status), \"Akku\");\n", "")

    merged = merge_project_into_yaml(new_project(), content)

    assert "displays" not in load_lvgl_yaml(merged.content)["lvgl"]


def test_a_known_display_id_is_kept() -> None:
    project = new_project()
    project.display_id_placeholder = "epd"
    content = LAMBDA_DISPLAY.replace("lambda:", "# lambda:").replace("      const", "      # const")
    content = "\n".join(
        line if not line.startswith("      ") or "#" in line or "width" in line or "height" in line
        else "      # " + line.strip()
        for line in content.splitlines()) + "\n"

    merged = merge_project_into_yaml(project, content)

    assert load_lvgl_yaml(merged.content)["lvgl"]["displays"] == ["epd"]


@pytest.mark.parametrize(("snippet", "keys"), [
    ("    pages:\n      - id: p1\n        lambda: it.fill(Color(0, 0, 0));\n", ["pages"]),
    ("    auto_clear_enabled: true\n", ["auto_clear_enabled"]),
    ("    show_test_card: true\n", ["show_test_card"]),
    ("    auto_clear_enabled: false\n", []),
])
def test_every_key_esphome_refuses_next_to_lvgl_counts(snippet: str, keys: list[str]) -> None:
    content = (
        "display:\n  - platform: ili9xxx\n    id: tft\n" + snippet
        + "    dimensions: {width: 320, height: 240}\n"
    )
    if not keys:
        merge_project_into_yaml(new_project(), content)
        return
    with pytest.raises(DisplayTakeoverRequired) as refused:
        merge_project_into_yaml(new_project(), content)
    assert refused.value.conflicts[0]["keys"] == keys
    merged = merge_project_into_yaml(new_project(), content, display_takeover="comment")
    assert not set(keys) & set(load_lvgl_yaml(merged.content)["display"][0])


def _takeover(content: str) -> str:
    return merge_project_into_yaml(new_project(), content, display_takeover="comment").content


def test_a_lambda_opening_its_list_entry_keeps_the_dash() -> None:
    merged = _takeover(
        "display:\n  - lambda: |-\n      it.fill(Color(0, 0, 0));\n"
        "    platform: ili9xxx\n    id: tft\n")

    assert merged.startswith(
        f"display:\n  - {COMMENT_MARKER}\n    # lambda: |-\n    #   it.fill(Color(0, 0, 0));\n"
        "    platform: ili9xxx\n    id: tft\n")
    assert load_lvgl_yaml(merged)["display"] == [{"platform": "ili9xxx", "id": "tft"}]


def test_a_flow_display_is_rewritten_in_block_style() -> None:
    merged = _takeover(
        'display:\n  - {platform: ili9xxx, id: tft, lambda: "it.fill(Color(0, 0, 0));"}  # mine\n')

    assert merged.startswith(
        f"display:\n  - {COMMENT_MARKER}\n    # lambda: it.fill(Color(0, 0, 0));\n"
        "    platform: ili9xxx\n    id: tft  # mine\n")


def test_a_flow_mapping_under_display_is_rewritten_too() -> None:
    merged = _takeover('display: {platform: ili9xxx, id: tft, lambda: "it.fill(Color(0, 0, 0));"}\n')

    assert load_lvgl_yaml(merged)["display"] == {"platform": "ili9xxx", "id": "tft"}
    assert "  # lambda: it.fill(Color(0, 0, 0));\n" in merged


@pytest.mark.parametrize(("content", "message"), [
    ('display: [{platform: ili9xxx, id: tft, lambda: "it.fill(Color(0, 0, 0));"}]\n', "flow list"),
    ("display:\n  - lambda: it.fill(Color(0, 0, 0));\n", "nothing but lambda"),
])
def test_what_cannot_be_commented_safely_is_refused(content: str, message: str) -> None:
    with pytest.raises(MergeError, match=message):
        _takeover(content)


def test_crlf_files_keep_their_line_endings() -> None:
    merged = _takeover(
        "display:\r\n  - lambda: |-\r\n      it.fill(Color(0, 0, 0));\r\n"
        "    platform: ili9xxx\r\n    id: tft\r\n")

    assert "\r\n    # lambda: |-\r\n" in merged
    assert "\n" not in merged.replace("\r\n", "")


@pytest.mark.parametrize("content", [
    "packages:\n  hw: !include hardware.yaml\nesphome:\n  name: x\n",
    "display:\n  - !include display.yaml\n",
])
def test_a_display_outside_the_file_is_flagged_and_not_named(content: str) -> None:
    merged = merge_project_into_yaml(new_project(), content)

    assert "displays" not in load_lvgl_yaml(merged.content)["lvgl"]
    assert any("outside this file" in issue.message for issue in merged.issues)


def test_a_stated_lvgl_display_is_trusted_even_when_defined_elsewhere() -> None:
    project = new_project()
    project.display_id_placeholder = "panel"
    content = ("packages:\n  hw: !include hardware.yaml\n"
               "lvgl:\n  displays:\n    - panel\n  widgets: []\n")

    merged = merge_project_into_yaml(project, content)

    assert load_lvgl_yaml(merged.content)["lvgl"]["displays"] == ["panel"]


def test_merge_draft_asks_then_comments_out(tmp_path: Path) -> None:
    config_root = tmp_path / "esphome"
    config_root.mkdir()
    (config_root / "paper.yaml").write_text(LAMBDA_DISPLAY, encoding="utf-8", newline="")
    settings = Settings(
        access_level="write", max_file_size=1024 * 1024, protect_sensitive_paths=True,
        config_root=config_root, data_root=tmp_path / "data", default_role="administrator",
    )
    client = TestClient(create_app(settings, serve_frontend=False),
                        headers={"X-Remote-User-Id": "test-user"})
    body = {"project": new_project().to_dict(), "target": "paper.yaml"}

    refused = client.post("/api/v1/designer/projects/merge-draft", json=body)
    assert refused.status_code == 409
    assert refused.json()["error"] == "display_takeover_required"
    assert refused.json()["details"]["displays"][0]["display_id"] == "epd"

    accepted = client.post("/api/v1/designer/projects/merge-draft",
                           json={**body, "confirm_display_takeover": True})
    assert accepted.status_code == 200
    assert accepted.json()["display_takeover"][0]["keys"] == ["lambda"]
    draft = client.get("/api/v1/configurations/paper.yaml/draft").json()["content"]
    assert "# lambda: |-" in draft and "lvgl:" in draft
    # The active file is never touched by a draft.
    assert (config_root / "paper.yaml").read_text(encoding="utf-8") == LAMBDA_DISPLAY
