"""Registry of LVGL widget types and their editable properties.

Single source of truth for the palette, the property panel, and the YAML
generator: each entry describes one ESPHome LVGL widget type as data,
without needing a dedicated Python/Qt class per type. M1 registers 7 widget
types (obj, container, label, button, switch, slider, image); the remaining
~19 are added the same way in a later milestone.

The LVGL v9 "chart" widget is deliberately never registered here: ESPHome
hard-disables LV_USE_CHART in its generated lv_conf.h with no override
(github.com/esphome/esphome/issues/15895), so offering it would just produce
YAML that cannot compile.
"""

from __future__ import annotations

from dataclasses import dataclass

CONTENT = "content"
STYLE = "style"

ALIGN_VALUES = (
    "TOP_LEFT", "TOP_MID", "TOP_RIGHT", "LEFT_MID", "CENTER", "RIGHT_MID",
    "BOTTOM_LEFT", "BOTTOM_MID", "BOTTOM_RIGHT",
    "OUT_LEFT_TOP", "OUT_TOP_LEFT", "OUT_TOP_MID", "OUT_TOP_RIGHT", "OUT_RIGHT_TOP",
    "OUT_LEFT_MID", "OUT_RIGHT_MID", "OUT_LEFT_BOTTOM", "OUT_BOTTOM_LEFT",
    "OUT_BOTTOM_MID", "OUT_BOTTOM_RIGHT", "OUT_RIGHT_BOTTOM",
)

#: DEFAULT plus the LVGL state names that can carry their own style override.
STATE_VALUES = ("checked", "pressed", "disabled", "focused", "edited", "scrolled")


@dataclass(frozen=True)
class PropertyDef:
    key: str
    kind: str
    category: str = CONTENT
    default: object = None
    enum_values: tuple[str, ...] = ()
    part: str = "main"
    label_de: str = ""
    label_en: str = ""

    def label(self, lang: str) -> str:
        text = self.label_de if lang == "de" else self.label_en
        return text or self.key


@dataclass(frozen=True)
class WidgetSchema:
    type_key: str
    label_de: str
    label_en: str
    default_size: tuple[int, int] = (100, 40)
    properties: tuple[PropertyDef, ...] = ()
    parts: tuple[str, ...] = ("main",)
    allows_children: bool = False
    child_role: str = "generic"   # generic | tab | tile
    is_top_level_only: bool = False
    is_stub: bool = False

    def label(self, lang: str) -> str:
        return self.label_de if lang == "de" else self.label_en

    def content_properties(self) -> tuple[PropertyDef, ...]:
        return tuple(p for p in self.properties if p.category == CONTENT)

    def style_properties(self, part: str = "main") -> tuple[PropertyDef, ...]:
        return tuple(p for p in self.properties if p.category == STYLE and p.part == part)


# --- shared style property building blocks ----------------------------------

def _paint_style_props() -> tuple[PropertyDef, ...]:
    """Style properties offered on (almost) every widget - a hand-picked
    subset of ESPHome's BASE_PROPS covering everyday layout work, not the
    full ~90-property list."""
    return (
        PropertyDef("bg_color", "color", STYLE,
                    label_de="Hintergrundfarbe", label_en="Background colour"),
        PropertyDef("bg_opa", "percent_or_enum", STYLE, default="COVER",
                    enum_values=("TRANSP", "COVER"),
                    label_de="Hintergrund-Deckkraft", label_en="Background opacity"),
        PropertyDef("bg_grad_color", "color", STYLE,
                    label_de="Verlaufsfarbe", label_en="Gradient colour"),
        PropertyDef("bg_grad_dir", "enum", STYLE, default="NONE",
                    enum_values=("NONE", "VER", "HOR"),
                    label_de="Verlaufsrichtung", label_en="Gradient direction"),
        PropertyDef("border_width", "int", STYLE, default=0,
                    label_de="Rahmenbreite", label_en="Border width"),
        PropertyDef("border_color", "color", STYLE,
                    label_de="Rahmenfarbe", label_en="Border colour"),
        PropertyDef("radius", "int", STYLE, default=0,
                    label_de="Eckenradius", label_en="Corner radius"),
        PropertyDef("pad_all", "int", STYLE, default=0,
                    label_de="Innenabstand", label_en="Padding"),
        PropertyDef("shadow_width", "int", STYLE, default=0,
                    label_de="Schattenbreite", label_en="Shadow width"),
        PropertyDef("shadow_color", "color", STYLE,
                    label_de="Schattenfarbe", label_en="Shadow colour"),
        PropertyDef("shadow_opa", "percent_or_enum", STYLE, default="COVER",
                    enum_values=("TRANSP", "COVER"),
                    label_de="Schatten-Deckkraft", label_en="Shadow opacity"),
        PropertyDef("shadow_offset_x", "int", STYLE, default=0,
                    label_de="Schatten X", label_en="Shadow X"),
        PropertyDef("shadow_offset_y", "int", STYLE, default=0,
                    label_de="Schatten Y", label_en="Shadow Y"),
        PropertyDef("opa", "percent_or_enum", STYLE, default="COVER",
                    enum_values=("TRANSP", "COVER"),
                    label_de="Deckkraft", label_en="Opacity"),
    )


def _text_style_props(part: str = "main") -> tuple[PropertyDef, ...]:
    return (
        PropertyDef("text_color", "color", STYLE, part=part,
                    label_de="Textfarbe", label_en="Text colour"),
        PropertyDef("text_font", "font_ref", STYLE, part=part,
                    label_de="Schrift", label_en="Font"),
        PropertyDef("text_align", "enum", STYLE, part=part, default="LEFT",
                    enum_values=("LEFT", "CENTER", "RIGHT", "AUTO"),
                    label_de="Textausrichtung", label_en="Text align"),
    )


def _layout_props() -> tuple[PropertyDef, ...]:
    return (
        PropertyDef("layout_type", "enum", STYLE, default="NONE",
                    enum_values=("NONE", "FLEX", "GRID"),
                    label_de="Layout", label_en="Layout"),
        PropertyDef("flex_flow", "enum", STYLE, default="ROW",
                    enum_values=("ROW", "COLUMN", "ROW_WRAP", "COLUMN_WRAP",
                                 "ROW_REVERSE", "COLUMN_REVERSE"),
                    label_de="Flex-Richtung", label_en="Flex flow"),
        PropertyDef("flex_align_main", "enum", STYLE, default="START",
                    enum_values=("START", "END", "CENTER", "SPACE_EVENLY",
                                 "SPACE_AROUND", "SPACE_BETWEEN"),
                    label_de="Flex Hauptachse", label_en="Flex main axis"),
        PropertyDef("flex_align_cross", "enum", STYLE, default="START",
                    enum_values=("START", "END", "CENTER", "STRETCH"),
                    label_de="Flex Querachse", label_en="Flex cross axis"),
        PropertyDef("flex_grow", "int", STYLE, default=0,
                    label_de="Flex-Wachstum", label_en="Flex grow"),
        PropertyDef("pad_row", "int", STYLE, default=0,
                    label_de="Zeilenabstand", label_en="Row gap"),
        PropertyDef("pad_column", "int", STYLE, default=0,
                    label_de="Spaltenabstand", label_en="Column gap"),
    )


WIDGET_SCHEMAS: dict[str, WidgetSchema] = {}


def _register(schema: WidgetSchema) -> None:
    WIDGET_SCHEMAS[schema.type_key] = schema


_register(WidgetSchema(
    type_key="obj", label_de="Container (obj)", label_en="Container (obj)",
    default_size=(200, 100),
    properties=(*_paint_style_props(), *_layout_props()),
    allows_children=True,
))

_register(WidgetSchema(
    type_key="container", label_de="Flex-Container", label_en="Flex container",
    default_size=(300, 100),
    properties=(*_paint_style_props(), *_layout_props()),
    allows_children=True,
))

_register(WidgetSchema(
    type_key="label", label_de="Label", label_en="Label",
    default_size=(120, 24),
    properties=(
        PropertyDef("text", "text", CONTENT, default="Label",
                    label_de="Text", label_en="Text"),
        PropertyDef("long_mode", "enum", CONTENT, default="WRAP",
                    enum_values=("WRAP", "DOT", "SCROLL", "SCROLL_CIRCULAR", "CLIP"),
                    label_de="Textüberlauf", label_en="Long text mode"),
        PropertyDef("recolor", "bool", CONTENT, default=False,
                    label_de="Inline-Farbcodes erlauben", label_en="Allow inline recolor"),
        *_text_style_props(),
        *_paint_style_props(),
    ),
))

_register(WidgetSchema(
    type_key="button", label_de="Button", label_en="Button",
    default_size=(120, 50),
    properties=(
        PropertyDef("text", "text", CONTENT, default="Button",
                    label_de="Text (optional)", label_en="Text (optional)"),
        PropertyDef("checkable", "bool", CONTENT, default=False,
                    label_de="Umschaltbar (checkable)", label_en="Checkable"),
        *_text_style_props(),
        *_paint_style_props(),
    ),
    allows_children=True,
))

_register(WidgetSchema(
    type_key="switch", label_de="Switch", label_en="Switch",
    default_size=(50, 25),
    parts=("main", "indicator", "knob"),
    properties=(
        PropertyDef("state_checked", "bool", CONTENT, default=False,
                    label_de="Anfangszustand: an", label_en="Initial state: on"),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="indicator",
                    label_de="Farbe (an)", label_en="Colour (on)"),
        PropertyDef("bg_color", "color", STYLE, part="knob",
                    label_de="Knopf-Farbe", label_en="Knob colour"),
    ),
))

_register(WidgetSchema(
    type_key="slider", label_de="Slider", label_en="Slider",
    default_size=(150, 20),
    parts=("main", "indicator", "knob"),
    properties=(
        PropertyDef("value", "int", CONTENT, default=0, label_de="Wert", label_en="Value"),
        PropertyDef("min_value", "int", CONTENT, default=0, label_de="Min", label_en="Min"),
        PropertyDef("max_value", "int", CONTENT, default=100, label_de="Max", label_en="Max"),
        PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                    enum_values=("NORMAL", "SYMMETRICAL", "RANGE"),
                    label_de="Modus", label_en="Mode"),
        PropertyDef("animated", "bool", CONTENT, default=True,
                    label_de="Animiert", label_en="Animated"),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="indicator",
                    label_de="Füllfarbe", label_en="Indicator colour"),
        PropertyDef("bg_color", "color", STYLE, part="knob",
                    label_de="Knopf-Farbe", label_en="Knob colour"),
    ),
))

_register(WidgetSchema(
    type_key="image", label_de="Bild", label_en="Image",
    default_size=(64, 64),
    properties=(
        PropertyDef("src", "image_ref", CONTENT,
                    label_de="Bildquelle", label_en="Image source"),
        PropertyDef("angle", "int", CONTENT, default=0,
                    label_de="Rotation (0.1°)", label_en="Rotation (0.1°)"),
        PropertyDef("zoom", "float", CONTENT, default=1.0,
                    label_de="Zoom", label_en="Zoom"),
        *_paint_style_props(),
    ),
))
