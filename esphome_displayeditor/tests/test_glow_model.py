"""Format version 3: GlowLine strokes stored on the project.

Field names are asserted verbatim because frontend/glowline/renderer.js reads
a stroke as a plain object with these exact keys - it does not consult a
schema, so a renamed field here would silently break the browser renderer
without any Python test failing.
"""

from __future__ import annotations

from backend.designer_core.model import (
    PROJECT_FORMAT_VERSION,
    FlowParams,
    GlowParams,
    GlowStroke,
    Project,
)


def test_glow_stroke_field_names_match_the_js_renderer_contract() -> None:
    stroke = GlowStroke(id="s1", points=[[10, 20], [30, 40]])
    d = stroke.to_dict()

    assert set(d) == {
        "id", "points", "name", "color565", "width", "corner_radius",
        "mode", "closed", "glow", "flow", "parent_id", "hidden", "locked",
    }
    assert set(d["glow"]) == {"enabled", "radius", "intensity", "use_line_color", "color565"}
    assert set(d["flow"]) == {
        "enabled", "mode", "reversed", "spacing", "size", "width",
        "use_line_color", "color565", "glow_radius", "glow_intensity",
    }


def test_glow_stroke_round_trips() -> None:
    stroke = GlowStroke(
        id="line_1", points=[[0, 0], [50, 10], [100, 0]], name="Fluss",
        color565=0x07FF, width=6, corner_radius=10, mode="smooth", closed=True,
    )
    stroke.glow.enabled = True
    stroke.glow.radius = 20
    stroke.flow.enabled = True
    stroke.flow.mode = "dashes"
    stroke.flow.spacing = 30

    restored = GlowStroke.from_dict(stroke.to_dict())

    assert restored.points == [[0.0, 0.0], [50.0, 10.0], [100.0, 0.0]]
    assert restored.name == "Fluss"
    assert restored.mode == "smooth"
    assert restored.closed is True
    assert restored.glow.radius == 20
    assert restored.flow.mode == "dashes"
    assert restored.flow.spacing == 30


def test_color565_is_masked_to_16_bits() -> None:
    stroke = GlowStroke(id="s", color565=0x1FFFFF)
    assert stroke.to_dict()["color565"] == 0x1FFFFF & 0xFFFF


def test_project_carries_glow_strokes() -> None:
    project = Project()
    project.glow_strokes = [GlowStroke(id="a"), GlowStroke(id="b")]

    restored = Project.from_dict(project.to_dict())

    assert [s.id for s in restored.glow_strokes] == ["a", "b"]
    assert project.to_dict()["format_version"] == PROJECT_FORMAT_VERSION


def test_empty_project_has_no_glow_strokes() -> None:
    assert Project.from_dict({}).glow_strokes == []


def test_glow_and_flow_defaults_match_glowline_editor() -> None:
    """Pinned to the desktop app's defaults (glowline/model.py), not
    arbitrary - a drifted default would make a freshly drawn line look
    different from what glowline-editor users expect."""
    glow = GlowParams()
    flow = FlowParams()

    assert (glow.enabled, glow.radius, glow.intensity, glow.color565) == (True, 14.0, 0.85, 0x07FF)
    assert (flow.enabled, flow.mode, flow.spacing, flow.size) == (False, "arrows", 40.0, 14.0)
