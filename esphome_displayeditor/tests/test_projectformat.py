from __future__ import annotations

import json

import pytest

from backend.designer_core.model import PROJECT_FORMAT_VERSION, Project, WidgetNode
from backend.designer_core.projectformat import (
    ProjectFormatError,
    load_project,
    save_project,
)


def test_project_file_round_trip(tmp_path) -> None:
    path = tmp_path / "display.lvgldesign"
    project = Project(canvas_width=480, canvas_height=320)

    save_project(str(path), project)

    assert load_project(str(path)).to_dict() == project.to_dict()


def test_project_file_is_human_readable_utf8_json(tmp_path) -> None:
    path = tmp_path / "display.lvgldesign"
    project = Project(
        widgets=[WidgetNode(id="room", widget_type="label", name="Küche")]
    )
    save_project(str(path), project)

    text = path.read_text(encoding="utf-8")
    assert "Küche" in text
    assert json.loads(text)["format_version"] == PROJECT_FORMAT_VERSION


def test_project_file_rejects_an_unknown_format(tmp_path) -> None:
    path = tmp_path / "display.lvgldesign"
    path.write_text('{"format": "other"}', encoding="utf-8")

    with pytest.raises(ProjectFormatError, match="Not an ESPHome"):
        load_project(str(path))


def test_project_file_rejects_a_newer_version(tmp_path) -> None:
    path = tmp_path / "display.lvgldesign"
    payload = Project().to_dict()
    payload["format_version"] = PROJECT_FORMAT_VERSION + 1
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ProjectFormatError, match="newer version"):
        load_project(str(path))
