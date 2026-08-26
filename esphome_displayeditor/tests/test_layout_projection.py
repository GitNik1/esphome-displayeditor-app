from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from backend.assistant_tools.layout_projection import LayoutProjectionService


FIXTURES = json.loads(
    (Path(__file__).parent / "data" / "layout_parity.json").read_text(
        encoding="utf-8"
    )
)


def _widgets(nodes: list[dict[str, Any]]):
    for widget in nodes:
        yield widget
        children = widget.get("children")
        if isinstance(children, list):
            yield from _widgets(children)


def _surface(fixture: dict[str, Any]):
    project = fixture["project"]
    key = fixture.get("surface", "root")
    extra = project.get("extra_lvgl", {})
    if key == "root":
        return project["widgets"], extra.get("layout", {}), extra
    if key.startswith("page:"):
        surface = next(item for item in project["pages"] if item["id"] == key[5:])
    else:
        surface = project[f"{key}_layer"]
    style = {**extra, **surface.get("style_tree", {})}
    style["layout"] = surface.get("layout", {})
    return surface["widgets"], style["layout"], style


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda item: item["name"])
def test_backend_layout_projection_matches_shared_browser_fixtures(
    fixture: dict[str, Any],
) -> None:
    project = fixture["project"]
    roots, layout, style = _surface(fixture)
    boxes = LayoutProjectionService().compute(
        project,
        roots,
        layout,
        style,
    )
    widgets = {item["id"]: item for item in _widgets(roots)}

    assert set(widgets) == set(fixture["expected"])
    for widget_id, expected in fixture["expected"].items():
        actual = boxes[id(widgets[widget_id])]
        assert actual["managed"] is expected["managed"]
        for key in (
            "left",
            "top",
            "width",
            "height",
            "origin_x",
            "origin_y",
        ):
            assert actual[key] == pytest.approx(expected[key]), (widget_id, key)
