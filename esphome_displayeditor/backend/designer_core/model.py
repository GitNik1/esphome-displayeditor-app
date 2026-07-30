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
PROJECT_FORMAT_VERSION = 1

DEFAULT_W, DEFAULT_H = 480, 480

#: Style-tree keys that name a further part rather than a style property.
STYLE_PARTS = ("indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor")


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
        return n


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
        return f


@dataclass
class ImageLibraryEntry:
    id: str
    file_path: str = ""
    resize: str = ""
    dither: str = ""
    transparency: str = "opaque"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "file_path": self.file_path, "resize": self.resize,
                "dither": self.dither, "transparency": self.transparency}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> ImageLibraryEntry:
        e = ImageLibraryEntry(id=str(d.get("id", "")))
        e.file_path = d.get("file_path", "")
        e.resize = d.get("resize", "")
        e.dither = d.get("dither", "")
        e.transparency = d.get("transparency", "opaque")
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
        return p
