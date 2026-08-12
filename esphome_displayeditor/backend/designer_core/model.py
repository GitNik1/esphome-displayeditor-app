"""Data model: project, widget tree, and the style/font/image/color
libraries. Every dataclass follows the same to_dict()/from_dict() idiom
(each field read back with ``d.get(key, default)``) so the project file can
gain new optional fields later without breaking older saves - the same
forward-compatibility idiom glowline-editor uses for its own save format.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

PROJECT_FORMAT = "esphome-lvgl-designer-project"
#: Version 3 adds Project.glow_strokes - glow/flow lines drawn in the browser
#: (a port of glowline-editor's model), baked into an image sequence and an
#: animimg widget on export. Same forward-compat rationale as version 2: an
#: older build must refuse the file, not load it and silently drop the lines.
PROJECT_FORMAT_VERSION = 3

DEFAULT_W, DEFAULT_H = 480, 480

#: Style-tree keys that name a further part rather than a style property.
STYLE_PARTS = ("indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor", "list")

#: Reserved style-tree key holding per-state overrides:
#: ``style_tree["states"]["pressed"] = {...}``. In YAML a state block sits flat
#: alongside the part blocks (``pressed:`` next to ``knob:``), but part and
#: state names share one namespace there. Nesting them under a reserved key
#: keeps the model unambiguous; the exporter flattens it back out.
STATES_KEY = "states"

#: Style-tree keys moved out of ``style_tree`` into ``WidgetNode.layout`` when
#: a version 1 project is loaded. ESPHome expects a nested ``layout:`` mapping,
#: so emitting these as flat style properties never produced valid YAML.
_LAYOUT_STYLE_MIGRATION = {
    "layout_type": "type",
    "flex_flow": "flex_flow",
    "flex_align_main": "flex_align_main",
    "flex_align_cross": "flex_align_cross",
    "flex_align_track": "flex_align_track",
}


def _copy(value: Any) -> Any:
    return copy.deepcopy(value)


@dataclass
class BackgroundImage:
    """The reference image shown under the canvas as an alignment guide.

    It is never exported unless ``export_as_lvgl_image`` is set - most
    reference images are mockups/screenshots, not a real device asset.
    """

    path: str = ""
    export_as_lvgl_image: bool = False
    image_id: str = "bg_image"
    opacity_in_editor: int = 40

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "export_as_lvgl_image": self.export_as_lvgl_image,
            "image_id": self.image_id,
            "opacity_in_editor": self.opacity_in_editor,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> BackgroundImage:
        b = BackgroundImage()
        b.path = str(d.get("path", ""))
        b.export_as_lvgl_image = bool(d.get("export_as_lvgl_image", False))
        b.image_id = str(d.get("image_id", "bg_image"))
        b.opacity_in_editor = int(d.get("opacity_in_editor", 40))
        return b


@dataclass
class WidgetNode:
    """One placed LVGL widget instance.

    ``properties`` holds content properties (text, min_value, options, ...);
    ``style_tree``/``style_refs`` hold visual style properties, kept
    strictly separate because ESPHome's ``style_definitions:`` may only
    contain style properties. ``style_mode`` has exactly two persisted
    values - "inline" (style_tree applies directly) or "named" (style_refs
    points into the project's style library). "Save as new style" is a UI
    action that moves style_tree into the library and switches the mode; it
    is not a third persisted state.
    """

    id: str
    widget_type: str
    name: str = ""
    x: Any = 0
    y: Any = 0
    width: Any = 100
    height: Any = 40
    align: str = "TOP_LEFT"
    align_to: str = ""
    hidden: bool = False
    locked: bool = False
    properties: dict[str, Any] = field(default_factory=dict)
    style_mode: str = "inline"
    style_refs: list[str] = field(default_factory=list)
    style_tree: dict[str, Any] = field(default_factory=dict)
    events: dict[str, list[dict]] = field(default_factory=dict)
    children: list[WidgetNode] = field(default_factory=list)
    tab_title: str = ""
    tile_row: int = 0
    tile_col: int = 0
    tile_dir: str = "ALL"

    #: This widget's own ESPHome ``layout:`` mapping, stored verbatim
    #: (``{"type": "GRID", "grid_rows": [40, "FR(1)", "CONTENT"], ...}``).
    #: Track values stay as written - parsing them is the canvas's job, and
    #: round-tripping an unparsed scalar is always safe.
    layout: dict[str, Any] = field(default_factory=dict)
    #: Placement inside the *parent's* grid, without the ``grid_cell_`` prefix:
    #: ``{"row_pos": 0, "column_pos": 1, "row_span": 2, "x_align": "CENTER"}``.
    grid_cell: dict[str, Any] = field(default_factory=dict)
    #: Widget keys this build does not model, kept verbatim so an imported
    #: config survives a round trip instead of being silently truncated.
    extra: dict[str, Any] = field(default_factory=dict)
    #: "editor" | "imported". An unknown widget type is a fatal export error
    #: for editor-created nodes (it would be a bug), but merely a warning for
    #: imported ones - the source config was valid ESPHome to begin with.
    source: str = "editor"
    #: True when the importer invented the id because the source had none;
    #: suppresses ``id:`` on export so the round trip stays clean.
    synthetic_id: bool = False

    def walk(self):
        """Yield self and every descendant, depth-first."""
        yield self
        for c in self.children:
            yield from c.walk()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "widget_type": self.widget_type,
            "name": self.name,
            "x": self.x, "y": self.y, "width": self.width, "height": self.height,
            "align": self.align, "align_to": self.align_to,
            "hidden": self.hidden, "locked": self.locked,
            "properties": dict(self.properties),
            "style_mode": self.style_mode,
            "style_refs": list(self.style_refs),
            "style_tree": _copy(self.style_tree),
            "events": _copy(self.events),
            "children": [c.to_dict() for c in self.children],
            "tab_title": self.tab_title,
            "tile_row": self.tile_row, "tile_col": self.tile_col, "tile_dir": self.tile_dir,
            "layout": _copy(self.layout),
            "grid_cell": _copy(self.grid_cell),
            "extra": _copy(self.extra),
            "source": self.source,
            "synthetic_id": self.synthetic_id,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> WidgetNode:
        n = WidgetNode(id=str(d.get("id", "")), widget_type=str(d.get("widget_type", "obj")))
        n.name = str(d.get("name", ""))
        n.x = d.get("x", 0)
        n.y = d.get("y", 0)
        n.width = d.get("width", 100)
        n.height = d.get("height", 40)
        n.align = d.get("align", "TOP_LEFT")
        n.align_to = d.get("align_to", "")
        n.hidden = bool(d.get("hidden", False))
        n.locked = bool(d.get("locked", False))
        n.properties = dict(d.get("properties", {}))
        n.style_mode = d.get("style_mode", "inline")
        n.style_refs = list(d.get("style_refs", []))
        n.style_tree = _copy(d.get("style_tree", {}))
        n.events = _copy(d.get("events", {}))
        n.children = [WidgetNode.from_dict(c) for c in d.get("children", [])]
        n.tab_title = d.get("tab_title", "")
        n.tile_row = int(d.get("tile_row", 0))
        n.tile_col = int(d.get("tile_col", 0))
        n.tile_dir = d.get("tile_dir", "ALL")
        n.layout = _copy(d.get("layout", {}))
        n.grid_cell = _copy(d.get("grid_cell", {}))
        n.extra = _copy(d.get("extra", {}))
        n.source = d.get("source", "editor")
        n.synthetic_id = bool(d.get("synthetic_id", False))
        n._migrate_layout_style_props()
        return n

    def _migrate_layout_style_props(self) -> None:
        """Lift version 1's flat layout style properties into ``layout``.

        Only runs when ``layout`` is still empty, so a v2 project that
        deliberately carries both is left alone.
        """
        if self.layout:
            return
        moved = {}
        for style_key, layout_key in _LAYOUT_STYLE_MIGRATION.items():
            if style_key in self.style_tree:
                moved[layout_key] = self.style_tree.pop(style_key)
        # "NONE" was the default and means "no layout at all" - migrating it
        # would turn every untouched v1 widget into one carrying a layout.
        if moved.get("type", "NONE") == "NONE":
            moved.pop("type", None)
            if not moved:
                return
        self.layout = moved


@dataclass
class StyleLibraryEntry:
    id: str
    style_tree: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "style_tree": _copy(self.style_tree)}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> StyleLibraryEntry:
        return StyleLibraryEntry(id=str(d.get("id", "")),
                                 style_tree=_copy(d.get("style_tree", {})))


@dataclass
class FontLibraryEntry:
    id: str
    source_kind: str = "gfonts"  # "builtin" | "gfonts" | "file" | "web"
    builtin_name: str = ""
    gfonts_family: str = ""
    gfonts_weight: int = 400
    gfonts_italic: bool = False
    file_path: str = ""
    web_url: str = ""
    size: int = 16
    bpp: int = 4
    glyphs: list[str] = field(default_factory=list)
    glyphsets: list[str] = field(default_factory=list)
    extras: list[dict] = field(default_factory=list)
    #: See ImageLibraryEntry.external.
    external: bool = False
    #: Keys this build does not model (``refresh: never``, ...), kept verbatim.
    #: Distinct from ``extras``, which is ESPHome's own ``extras:`` list.
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "source_kind": self.source_kind,
            "builtin_name": self.builtin_name,
            "gfonts_family": self.gfonts_family, "gfonts_weight": self.gfonts_weight,
            "gfonts_italic": self.gfonts_italic,
            "file_path": self.file_path, "web_url": self.web_url,
            "size": self.size, "bpp": self.bpp,
            "glyphs": list(self.glyphs), "glyphsets": list(self.glyphsets),
            "extras": _copy(self.extras),
            "external": self.external, "extra": _copy(self.extra),
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> FontLibraryEntry:
        f = FontLibraryEntry(id=str(d.get("id", "")))
        f.source_kind = d.get("source_kind", "gfonts")
        f.builtin_name = d.get("builtin_name", "")
        f.gfonts_family = d.get("gfonts_family", "")
        f.gfonts_weight = int(d.get("gfonts_weight", 400))
        f.gfonts_italic = bool(d.get("gfonts_italic", False))
        f.file_path = d.get("file_path", "")
        f.web_url = d.get("web_url", "")
        f.size = int(d.get("size", 16))
        f.bpp = int(d.get("bpp", 4))
        f.glyphs = list(d.get("glyphs", []))
        f.glyphsets = list(d.get("glyphsets", []))
        f.extras = _copy(d.get("extras", []))
        f.external = bool(d.get("external", False))
        f.extra = _copy(d.get("extra", {}))
        return f


@dataclass
class ImageLibraryEntry:
    id: str
    file_path: str = ""
    resize: str = ""
    dither: str = ""
    transparency: str = "opaque"
    #: ESPHome's image colour format (``BINARY``, ``TRANSPARENT_BINARY``,
    #: ``GRAYSCALE``, ``RGB565``, ``RGB``, ``RGBA``). Empty = ESPHome's own
    #: default for the target's colour depth.
    img_type: str = ""
    #: The asset belongs to the ESPHome project this was imported from, not to
    #: this designer. Its path is emitted verbatim, never copied into an
    #: assets/ folder, and never opened by the add-on - which is why it is
    #: exempt from the local-file rule guarding against arbitrary host reads.
    external: bool = False
    #: Keys this build does not model, kept verbatim.
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "file_path": self.file_path, "resize": self.resize,
                "dither": self.dither, "transparency": self.transparency,
                "img_type": self.img_type,
                "external": self.external, "extra": _copy(self.extra)}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> ImageLibraryEntry:
        e = ImageLibraryEntry(id=str(d.get("id", "")))
        e.file_path = d.get("file_path", "")
        e.resize = d.get("resize", "")
        e.dither = d.get("dither", "")
        e.transparency = d.get("transparency", "opaque")
        e.img_type = d.get("img_type", "")
        e.external = bool(d.get("external", False))
        e.extra = _copy(d.get("extra", {}))
        return e


@dataclass
class ColorLibraryEntry:
    id: str
    hex: str = "FFFFFF"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "hex": self.hex}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> ColorLibraryEntry:
        return ColorLibraryEntry(id=str(d.get("id", "")), hex=d.get("hex", "FFFFFF"))


@dataclass
class GlowParams:
    """Glow parameters of a single glow line. Ported from glowline-editor's
    ``GlowParams``; field names match exactly, since ``frontend/glowline/
    renderer.js`` reads a stroke's ``glow`` as a plain object with these keys."""

    enabled: bool = True
    radius: float = 14.0
    intensity: float = 0.85
    use_line_color: bool = True
    color565: int = 0x07FF

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "radius": self.radius,
            "intensity": self.intensity, "use_line_color": self.use_line_color,
            "color565": int(self.color565) & 0xFFFF,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> GlowParams:
        g = GlowParams()
        g.enabled = bool(d.get("enabled", True))
        g.radius = float(d.get("radius", 14.0))
        g.intensity = float(d.get("intensity", 0.85))
        g.use_line_color = bool(d.get("use_line_color", True))
        g.color565 = int(d.get("color565", 0x07FF)) & 0xFFFF
        return g


@dataclass
class FlowParams:
    """Flow markers travelling along a line. Ported from glowline-editor's
    ``FlowParams``; field names match exactly for the same reason as
    ``GlowParams`` above."""

    enabled: bool = False
    mode: str = "arrows"  # "arrows" | "dashes"
    reversed: bool = False
    spacing: float = 40.0
    size: float = 14.0
    width: float = 0.0  # 0 = adopt the line width
    use_line_color: bool = False
    color565: int = 0xFFFF
    glow_radius: float = 0.0
    glow_intensity: float = 0.9
    #: Whether this line's flow can travel in either direction on the real
    #: device - baking then produces a *second* animated frame set (mirrored
    #: travel direction) alongside the normal one, and the widget "Aktionen"
    #: flow action offers switching between them from a single numeric
    #: trigger. Purely a flag at design time; it does not itself reverse
    #: anything (`reversed` above still controls the live preview's single
    #: direction) - see `bake_frame_count`/`bake_crop` below for why this
    #: lives on FlowParams rather than a one-off bake dialog.
    bidirectional: bool = False
    #: Baking (turning this line into PNG frames + an image/animimg widget
    #: pair) used to be a manual, one-off dialog with its own inputs that
    #: were lost once the dialog closed. Moving them here makes them a
    #: persistent part of the line, so baking can run automatically before
    #: every YAML export/draft-save without asking the user to re-enter
    #: them, and so a later re-export with different values re-bakes with
    #: those values instead of the ones from whenever it first happened to
    #: be baked.
    bake_frame_count: int = 6
    bake_crop: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "mode": self.mode, "reversed": self.reversed,
            "spacing": self.spacing, "size": self.size, "width": self.width,
            "use_line_color": self.use_line_color,
            "color565": int(self.color565) & 0xFFFF,
            "glow_radius": self.glow_radius, "glow_intensity": self.glow_intensity,
            "bidirectional": self.bidirectional,
            "bake_frame_count": self.bake_frame_count,
            "bake_crop": self.bake_crop,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> FlowParams:
        f = FlowParams()
        f.enabled = bool(d.get("enabled", False))
        f.mode = d.get("mode", "arrows")
        f.reversed = bool(d.get("reversed", False))
        f.spacing = float(d.get("spacing", 40.0))
        f.size = float(d.get("size", 14.0))
        f.width = float(d.get("width", 0.0))
        f.use_line_color = bool(d.get("use_line_color", False))
        f.bidirectional = bool(d.get("bidirectional", False))
        f.bake_frame_count = max(1, min(60, int(d.get("bake_frame_count", 6))))
        f.bake_crop = bool(d.get("bake_crop", True))
        f.color565 = int(d.get("color565", 0xFFFF)) & 0xFFFF
        f.glow_radius = float(d.get("glow_radius", 0.0))
        f.glow_intensity = float(d.get("glow_intensity", 0.9))
        return f


@dataclass
class GlowStroke:
    """One editable glow line (rounded polyline or spline), drawn directly on
    the canvas at the project's own coordinates - not a separate document, so
    a line can be placed relative to the widgets it animates alongside.

    Ported from glowline-editor's ``Stroke``. ``id`` is new here: the desktop
    editor selects a stroke by list position, but this UI needs a stable
    handle for the hierarchy/selection the rest of the designer already uses.
    """

    id: str
    points: list[list[float]] = field(default_factory=list)
    name: str = ""
    color565: int = 0x07FF
    width: float = 5.0
    corner_radius: float = 12.0
    mode: str = "polyline"  # "polyline" | "smooth"
    closed: bool = False
    glow: GlowParams = field(default_factory=GlowParams)
    flow: FlowParams = field(default_factory=FlowParams)
    # Empty string = not nested. A parent is cosmetic/organizational only -
    # `points` always stay in absolute canvas coordinates, so nothing about
    # rendering or hit-testing needs to know about it. It only affects: (1)
    # the hierarchy tree grouping, (2) whether the editor drags this line's
    # points along when the parent widget moves, and (3) which widget's
    # `children` a baked image/animimg widget is appended to.
    parent_id: str = ""
    # Editor-only, like WidgetNode.hidden's canvas-preview effect - a hidden
    # line is skipped when drawing the canvas (not just dimmed) but stays
    # selectable via the hierarchy tree, and still bakes normally if
    # explicitly selected and baked.
    hidden: bool = False
    # Editor-only, like WidgetNode.locked - blocks dragging the line's body or
    # its point handles (both defined below in app.js), not deletion, the
    # same asymmetry widgets already have (Delete still works on a locked
    # widget; only the drag gesture is guarded).
    locked: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "points": [[float(p[0]), float(p[1])] for p in self.points],
            "name": self.name,
            "color565": int(self.color565) & 0xFFFF,
            "width": float(self.width),
            "corner_radius": float(self.corner_radius),
            "mode": self.mode,
            "closed": bool(self.closed),
            "glow": self.glow.to_dict(),
            "flow": self.flow.to_dict(),
            "parent_id": self.parent_id,
            "hidden": self.hidden,
            "locked": self.locked,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> GlowStroke:
        s = GlowStroke(id=str(d.get("id", "")))
        s.points = [[float(p[0]), float(p[1])] for p in d.get("points", [])]
        s.name = str(d.get("name", ""))
        s.color565 = int(d.get("color565", 0x07FF)) & 0xFFFF
        s.width = float(d.get("width", 5.0))
        s.corner_radius = float(d.get("corner_radius", 12.0))
        s.mode = d.get("mode", "polyline")
        s.closed = bool(d.get("closed", False))
        s.glow = GlowParams.from_dict(d.get("glow", {}))
        s.flow = FlowParams.from_dict(d.get("flow", {}))
        s.parent_id = str(d.get("parent_id", ""))
        s.hidden = bool(d.get("hidden", False))
        s.locked = bool(d.get("locked", False))
        return s


@dataclass
class Project:
    canvas_width: int = DEFAULT_W
    canvas_height: int = DEFAULT_H
    background: BackgroundImage = field(default_factory=BackgroundImage)
    widgets: list[WidgetNode] = field(default_factory=list)
    styles: list[StyleLibraryEntry] = field(default_factory=list)
    fonts: list[FontLibraryEntry] = field(default_factory=list)
    images: list[ImageLibraryEntry] = field(default_factory=list)
    colors: list[ColorLibraryEntry] = field(default_factory=list)
    default_font: str = ""
    display_id_placeholder: str = "my_display"

    #: ESPHome's ``lvgl: theme:`` block - ``{widget_type: style_dict}``, using
    #: the same shape as ``WidgetNode.style_tree`` so parts and states nest
    #: identically and the same helpers apply.
    theme: dict[str, Any] = field(default_factory=dict)
    #: Keys inside ``lvgl:`` this build does not model (``pages``, ``top_layer``,
    #: ``msgboxes``, ``on_idle``, ...), kept verbatim.
    extra_lvgl: dict[str, Any] = field(default_factory=dict)
    #: How the canvas size was determined, so the UI can be honest about a
    #: guess: user | display_dimensions | display_model | root_grid |
    #: bounding_box | default.
    canvas_source: str = "default"
    #: Top-level blocks the exporter may emit. An imported project restricts
    #: this to ["lvgl"], so the generated file can sit next to the original
    #: config without redefining its fonts, images and colors.
    export_sections: list[str] = field(
        default_factory=lambda: ["color", "font", "image", "lvgl"])
    #: Provenance of an import - ``{"name": ..., "revision": ...}``. Recorded
    #: for display only; nothing ever writes back to the source.
    import_source: dict[str, Any] = field(default_factory=dict)
    #: Glow/flow lines drawn on the canvas (ported GlowLine editor). Rendered
    #: live for preview; "bake into image sequence" turns them into
    #: ImageLibraryEntry rows plus an image/animimg widget pair.
    glow_strokes: list[GlowStroke] = field(default_factory=list)
    #: ``id:`` values used anywhere else in an imported source config -
    #: hardware entities like ``binary_sensor:``/``button:``/``switch:`` that
    #: this designer never models or edits, but whose ids still share
    #: ESPHome's one flat id() namespace with every widget/style/font/image/
    #: color here. Without this, a new widget's auto-generated id (or a
    #: manually typed one) can silently collide with an entity the rest of
    #: the config already defined, since nothing else here ever sees it.
    reserved_ids: list[str] = field(default_factory=list)

    def all_widgets(self):
        """Yield every WidgetNode in the tree, depth-first."""
        for w in self.widgets:
            yield from w.walk()

    def find_widget(self, widget_id: str) -> WidgetNode | None:
        return next((w for w in self.all_widgets() if w.id == widget_id), None)

    def find_style(self, style_id: str) -> StyleLibraryEntry | None:
        return next((s for s in self.styles if s.id == style_id), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": PROJECT_FORMAT,
            "format_version": PROJECT_FORMAT_VERSION,
            "canvas": {"width": self.canvas_width, "height": self.canvas_height},
            "background": self.background.to_dict(),
            "display_id_placeholder": self.display_id_placeholder,
            "default_font": self.default_font,
            "widgets": [w.to_dict() for w in self.widgets],
            "styles": [s.to_dict() for s in self.styles],
            "fonts": [f.to_dict() for f in self.fonts],
            "images": [i.to_dict() for i in self.images],
            "colors": [c.to_dict() for c in self.colors],
            "theme": _copy(self.theme),
            "extra_lvgl": _copy(self.extra_lvgl),
            "canvas_source": self.canvas_source,
            "export_sections": list(self.export_sections),
            "import_source": _copy(self.import_source),
            "glow_strokes": [s.to_dict() for s in self.glow_strokes],
            "reserved_ids": list(self.reserved_ids),
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Project:
        p = Project()
        canvas = d.get("canvas", {})
        p.canvas_width = int(canvas.get("width", DEFAULT_W))
        p.canvas_height = int(canvas.get("height", DEFAULT_H))
        p.background = BackgroundImage.from_dict(d.get("background", {}))
        p.display_id_placeholder = d.get("display_id_placeholder", "my_display")
        p.default_font = d.get("default_font", "")
        p.widgets = [WidgetNode.from_dict(w) for w in d.get("widgets", [])]
        p.styles = [StyleLibraryEntry.from_dict(s) for s in d.get("styles", [])]
        p.fonts = [FontLibraryEntry.from_dict(f) for f in d.get("fonts", [])]
        p.images = [ImageLibraryEntry.from_dict(i) for i in d.get("images", [])]
        p.colors = [ColorLibraryEntry.from_dict(c) for c in d.get("colors", [])]
        p.theme = _copy(d.get("theme", {}))
        p.extra_lvgl = _copy(d.get("extra_lvgl", {}))
        p.canvas_source = d.get("canvas_source", "default")
        p.export_sections = list(
            d.get("export_sections", ["color", "font", "image", "lvgl"]))
        p.import_source = _copy(d.get("import_source", {}))
        p.glow_strokes = [GlowStroke.from_dict(s) for s in d.get("glow_strokes", [])]
        p.reserved_ids = [str(i) for i in d.get("reserved_ids", []) if str(i)]
        return p
