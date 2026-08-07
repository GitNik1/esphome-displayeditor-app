"""Registry of LVGL widget types and their editable properties.

Single source of truth for the palette, the property panel, and the YAML
generator: each entry describes one ESPHome LVGL widget type as data,
without needing a dedicated Python/Qt class per type. Currently registered:
obj, container, label, button, switch, slider, image, animimg, checkbox,
arc, bar, dropdown, roller, textarea, keyboard, tileview, tabview, led,
spinner, qrcode, spinbox - the remaining widget types (`buttonmatrix`,
`msgboxes`, `line`, `canvas`) need a fundamentally different, non-flat
editor and are deliberately left unregistered (see
LVGL-VOLLSTAENDIGKEIT-UMSETZUNGSPLAN.md). `tile` and `tab` are also
registered, but are synthetic pseudo-widgets (see their own comments
below), not real ESPHome LVGL widget types.

The LVGL v9 "chart" widget is deliberately never registered here: ESPHome
hard-disables LV_USE_CHART in its generated lv_conf.h with no override
(github.com/esphome/esphome/issues/15895), so offering it would just produce
YAML that cannot compile.
"""

from __future__ import annotations

from dataclasses import dataclass

CONTENT = "content"
STYLE = "style"
#: Backed by WidgetNode.layout - ESPHome's nested ``layout:`` mapping.
LAYOUT = "layout"
#: Backed by WidgetNode.grid_cell - the ``grid_cell_*`` keys on a grid child.
GRID_CELL = "grid_cell"

#: Palette grouping: widgets the user interacts with (tap/drag/type) vs.
#: widgets that only ever show information. Purely a UI-organisation aid for
#: the palette - has no effect on import/export/validation.
CATEGORY_INPUT = "input"
CATEGORY_DISPLAY = "display"

ALIGN_VALUES = (
    "TOP_LEFT", "TOP_MID", "TOP_RIGHT", "LEFT_MID", "CENTER", "RIGHT_MID",
    "BOTTOM_LEFT", "BOTTOM_MID", "BOTTOM_RIGHT",
    "OUT_LEFT_TOP", "OUT_TOP_LEFT", "OUT_TOP_MID", "OUT_TOP_RIGHT", "OUT_RIGHT_TOP",
    "OUT_LEFT_MID", "OUT_RIGHT_MID", "OUT_LEFT_BOTTOM", "OUT_BOTTOM_LEFT",
    "OUT_BOTTOM_MID", "OUT_BOTTOM_RIGHT", "OUT_RIGHT_BOTTOM",
)

#: DEFAULT plus the LVGL state names that can carry their own style override.
STATE_VALUES = ("checked", "pressed", "disabled", "focused", "edited", "scrolled")

#: Every style property ESPHome's LVGL component accepts, whether or not this
#: designer offers an editor for it. `properties` above is a hand-picked subset
#: for the property panel; this is the *recognition* table used when reading a
#: hand-written config back in. Without it an importer cannot tell a style key
#: from an unknown one and would dump most of a real config into passthrough.
#: Includes the legacy aliases from yamlexport._LEGACY_STYLE_REMAP, since those
#: are what an older config on disk actually contains.
LVGL_STYLE_KEYS = frozenset({
    # background
    "bg_color", "bg_opa", "bg_grad_color", "bg_grad_dir", "bg_grad_stop",
    "bg_main_stop", "bg_main_opa", "bg_grad_opa", "bg_dither_mode",
    "bg_image_src", "bg_image_opa", "bg_image_recolor", "bg_image_recolor_opa",
    "bg_image_tiled",
    # border
    "border_color", "border_opa", "border_width", "border_side", "border_post",
    # outline
    "outline_width", "outline_color", "outline_opa", "outline_pad",
    # shadow
    "shadow_width", "shadow_color", "shadow_opa", "shadow_spread",
    "shadow_offset_x", "shadow_offset_y", "shadow_ofs_x", "shadow_ofs_y",
    # text
    "text_color", "text_opa", "text_font", "text_letter_space", "text_line_space",
    "text_decor", "text_align",
    # geometry / spacing
    "radius", "clip_corner", "opa", "opa_layered", "color_filter_opa",
    "pad_all", "pad_top", "pad_bottom", "pad_left", "pad_right",
    "pad_row", "pad_column", "margin_top", "margin_bottom", "margin_left",
    "margin_right", "width", "height", "min_width", "max_width", "min_height",
    "max_height", "x", "y", "align",
    # line / arc
    "line_width", "line_dash_width", "line_dash_gap", "line_rounded",
    "line_color", "line_opa", "arc_width", "arc_rounded", "arc_color",
    "arc_opa", "arc_image_src",
    # image
    "image_recolor", "image_recolor_opa", "image_opa",
    # transform
    "transform_width", "transform_height", "translate_x", "translate_y",
    "transform_zoom", "transform_angle", "transform_scale", "transform_rotation",
    "transform_pivot_x", "transform_pivot_y", "transform_skew_x",
    # animation / misc
    "anim_time", "anim_duration", "anim_speed", "blend_mode", "layout",
    "base_dir", "recolor",
    # legacy aliases (see yamlexport._LEGACY_STYLE_REMAP)
    "zoom", "angle", "scale", "rotation",
})

#: Every LVGL widget type ESPHome knows. Used to tell "a real widget this
#: designer has no schema for yet" (import it, preserve it verbatim) from
#: "not a widget at all" (a typo, or a key we misread as a widget).
LVGL_WIDGET_TYPES = frozenset({
    "obj", "label", "button", "buttonmatrix", "switch", "slider", "image",
    "animimg", "arc", "bar", "canvas", "checkbox", "dropdown", "keyboard",
    "led", "line", "meter", "msgbox", "qrcode", "roller", "spinbox", "spinner",
    "tabview", "textarea", "tileview", "page", "container",
})


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
    #: Optional sub-grouping within a (category, part) property list - lets
    #: the frontend fold rarely-tweaked clusters (spacing/border/shadow) into
    #: a collapsible section instead of listing every property flat. Empty
    #: string means "not grouped", rendered inline as before.
    group: str = ""

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
    category: str = CATEGORY_DISPLAY

    def label(self, lang: str) -> str:
        return self.label_de if lang == "de" else self.label_en

    def content_properties(self) -> tuple[PropertyDef, ...]:
        return tuple(p for p in self.properties if p.category == CONTENT)

    def style_properties(self, part: str = "main") -> tuple[PropertyDef, ...]:
        return tuple(p for p in self.properties if p.category == STYLE and p.part == part)

    def layout_properties(self) -> tuple[PropertyDef, ...]:
        return tuple(p for p in self.properties if p.category == LAYOUT)


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
        PropertyDef("border_width", "int", STYLE, default=0, group="border",
                    label_de="Rahmenbreite", label_en="Border width"),
        PropertyDef("border_color", "color", STYLE, group="border",
                    label_de="Rahmenfarbe", label_en="Border colour"),
        PropertyDef("border_opa", "percent_or_enum", STYLE, default="COVER",
                    enum_values=("TRANSP", "COVER"), group="border",
                    label_de="Rahmen-Deckkraft", label_en="Border opacity"),
        # Reuses the "text_list" (comma-separated) editor already built for
        # dropdown/roller options - ESPHome accepts border_side as a list of
        # NONE|TOP|BOTTOM|LEFT|RIGHT|INTERNAL|FULL tokens, the export side
        # already has resolve_border_side() to expand "FULL". No dedicated
        # multi-select UI for now (see LVGL-VOLLSTAENDIGKEIT-UMSETZUNGSPLAN.md).
        PropertyDef("border_side", "text_list", STYLE, group="border",
                    label_de="Rahmenkanten (TOP,BOTTOM,LEFT,RIGHT,FULL)",
                    label_en="Border sides (TOP,BOTTOM,LEFT,RIGHT,FULL)"),
        PropertyDef("radius", "int", STYLE, default=0, group="border",
                    label_de="Eckenradius", label_en="Corner radius"),
        PropertyDef("pad_all", "int", STYLE, default=0, group="spacing",
                    label_de="Innenabstand", label_en="Padding"),
        PropertyDef("pad_top", "int", STYLE, default=0, group="spacing",
                    label_de="Innenabstand oben", label_en="Padding top"),
        PropertyDef("pad_bottom", "int", STYLE, default=0, group="spacing",
                    label_de="Innenabstand unten", label_en="Padding bottom"),
        PropertyDef("pad_left", "int", STYLE, default=0, group="spacing",
                    label_de="Innenabstand links", label_en="Padding left"),
        PropertyDef("pad_right", "int", STYLE, default=0, group="spacing",
                    label_de="Innenabstand rechts", label_en="Padding right"),
        PropertyDef("margin_top", "int", STYLE, default=0, group="spacing",
                    label_de="Außenabstand oben", label_en="Margin top"),
        PropertyDef("margin_bottom", "int", STYLE, default=0, group="spacing",
                    label_de="Außenabstand unten", label_en="Margin bottom"),
        PropertyDef("margin_left", "int", STYLE, default=0, group="spacing",
                    label_de="Außenabstand links", label_en="Margin left"),
        PropertyDef("margin_right", "int", STYLE, default=0, group="spacing",
                    label_de="Außenabstand rechts", label_en="Margin right"),
        PropertyDef("shadow_width", "int", STYLE, default=0, group="shadow",
                    label_de="Schattenbreite", label_en="Shadow width"),
        PropertyDef("shadow_color", "color", STYLE, group="shadow",
                    label_de="Schattenfarbe", label_en="Shadow colour"),
        PropertyDef("shadow_opa", "percent_or_enum", STYLE, default="COVER",
                    enum_values=("TRANSP", "COVER"), group="shadow",
                    label_de="Schatten-Deckkraft", label_en="Shadow opacity"),
        PropertyDef("shadow_offset_x", "int", STYLE, default=0, group="shadow",
                    label_de="Schatten X", label_en="Shadow X"),
        PropertyDef("shadow_offset_y", "int", STYLE, default=0, group="shadow",
                    label_de="Schatten Y", label_en="Shadow Y"),
        PropertyDef("shadow_spread", "int", STYLE, default=0, group="shadow",
                    label_de="Schatten-Ausbreitung", label_en="Shadow spread"),
        PropertyDef("bg_image_src", "image_ref", STYLE,
                    label_de="Hintergrundbild", label_en="Background image"),
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
        PropertyDef("text_opa", "percent_or_enum", STYLE, part=part, default="COVER",
                    enum_values=("TRANSP", "COVER"),
                    label_de="Text-Deckkraft", label_en="Text opacity"),
    )


def _layout_props() -> tuple[PropertyDef, ...]:
    """Properties of the widget's own ``layout:`` mapping.

    These are LAYOUT, not STYLE: ESPHome nests them under ``layout:`` on the
    widget, so emitting them as flat style keys - which is what this designer
    did until format version 2 - never produced valid ESPHome YAML. The keys
    are the names ESPHome uses *inside* that mapping, and they are backed by
    ``WidgetNode.layout``.
    """
    return (
        PropertyDef("type", "enum", LAYOUT, default="NONE",
                    enum_values=("NONE", "FLEX", "GRID"),
                    label_de="Layout", label_en="Layout"),
        PropertyDef("flex_flow", "enum", LAYOUT, default="ROW",
                    enum_values=("ROW", "COLUMN", "ROW_WRAP", "COLUMN_WRAP",
                                 "ROW_REVERSE", "COLUMN_REVERSE"),
                    label_de="Flex-Richtung", label_en="Flex flow"),
        PropertyDef("flex_align_main", "enum", LAYOUT, default="START",
                    enum_values=("START", "END", "CENTER", "SPACE_EVENLY",
                                 "SPACE_AROUND", "SPACE_BETWEEN"),
                    label_de="Flex Hauptachse", label_en="Flex main axis"),
        PropertyDef("flex_align_cross", "enum", LAYOUT, default="START",
                    enum_values=("START", "END", "CENTER", "STRETCH"),
                    label_de="Flex Querachse", label_en="Flex cross axis"),
        PropertyDef("flex_align_track", "enum", LAYOUT, default="START",
                    enum_values=("START", "END", "CENTER", "SPACE_EVENLY",
                                 "SPACE_AROUND", "SPACE_BETWEEN"),
                    label_de="Flex Spurverteilung", label_en="Flex track align"),
        PropertyDef("grid_rows", "grid_track_list", LAYOUT,
                    label_de="Grid-Zeilen", label_en="Grid rows"),
        PropertyDef("grid_columns", "grid_track_list", LAYOUT,
                    label_de="Grid-Spalten", label_en="Grid columns"),
    )


def _flex_child_style_props() -> tuple[PropertyDef, ...]:
    """Spacing and flex growth stay flat style keys on the widget - unlike the
    layout mapping above, that is where ESPHome expects them."""
    return (
        PropertyDef("flex_grow", "int", STYLE, default=0,
                    label_de="Flex-Wachstum", label_en="Flex grow"),
        PropertyDef("pad_row", "int", STYLE, default=0, group="spacing",
                    label_de="Zeilenabstand", label_en="Row gap"),
        PropertyDef("pad_column", "int", STYLE, default=0, group="spacing",
                    label_de="Spaltenabstand", label_en="Column gap"),
    )


#: Placement of a widget inside its parent's grid. Backed by
#: ``WidgetNode.grid_cell``; the keys carry a ``grid_cell_`` prefix in YAML.
GRID_CELL_PROPS: tuple[PropertyDef, ...] = (
    PropertyDef("row_pos", "int", GRID_CELL, default=0,
                label_de="Zeile", label_en="Row"),
    PropertyDef("column_pos", "int", GRID_CELL, default=0,
                label_de="Spalte", label_en="Column"),
    PropertyDef("row_span", "int", GRID_CELL, default=1,
                label_de="Zeilen-Spanne", label_en="Row span"),
    PropertyDef("column_span", "int", GRID_CELL, default=1,
                label_de="Spalten-Spanne", label_en="Column span"),
    PropertyDef("x_align", "enum", GRID_CELL, default="START",
                enum_values=("START", "CENTER", "END", "STRETCH"),
                label_de="Ausrichtung X", label_en="X align"),
    PropertyDef("y_align", "enum", GRID_CELL, default="START",
                enum_values=("START", "CENTER", "END", "STRETCH"),
                label_de="Ausrichtung Y", label_en="Y align"),
)


WIDGET_SCHEMAS: dict[str, WidgetSchema] = {}


def _register(schema: WidgetSchema) -> None:
    WIDGET_SCHEMAS[schema.type_key] = schema


_register(WidgetSchema(
    type_key="obj", label_de="Container (obj)", label_en="Container (obj)",
    default_size=(200, 100),
    properties=(*_paint_style_props(), *_flex_child_style_props(), *_layout_props()),
    allows_children=True,
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="container", label_de="Flex-Container", label_en="Flex container",
    default_size=(300, 100),
    properties=(*_paint_style_props(), *_flex_child_style_props(), *_layout_props()),
    allows_children=True,
    category=CATEGORY_DISPLAY,
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
    category=CATEGORY_DISPLAY,
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
    category=CATEGORY_INPUT,
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
    category=CATEGORY_INPUT,
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
    category=CATEGORY_INPUT,
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
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="animimg", label_de="Animiertes Bild", label_en="Animated image",
    default_size=(64, 64),
    properties=(
        # Unlike `image`, src is a *list* of image ids played in sequence.
        PropertyDef("src", "image_ref_list", CONTENT,
                    label_de="Einzelbilder", label_en="Frames"),
        PropertyDef("duration", "int", CONTENT, default=1000,
                    label_de="Dauer (ms)", label_en="Duration (ms)"),
        # ESPHome accepts either an integer or the literal word "forever" -
        # a bare text field lets the user write either, and content
        # properties pass through to YAML unvalidated either way.
        PropertyDef("repeat_count", "text", CONTENT,
                    label_de="Wiederholungen (Zahl oder \"forever\")",
                    label_en="Repeat count (number or \"forever\")"),
        PropertyDef("auto_start", "bool", CONTENT, default=False,
                    label_de="Autostart", label_en="Auto start"),
        *_paint_style_props(),
    ),
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="checkbox", label_de="Checkbox", label_en="Checkbox",
    default_size=(150, 24),
    parts=("main", "indicator"),
    properties=(
        PropertyDef("text", "text", CONTENT, default="Checkbox",
                    label_de="Text", label_en="Text"),
        PropertyDef("state_checked", "bool", CONTENT, default=False,
                    label_de="Anfangszustand: aktiviert", label_en="Initial state: checked"),
        *_text_style_props(),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="indicator",
                    label_de="Kästchenfarbe (aktiviert)", label_en="Tickbox colour (checked)"),
    ),
    category=CATEGORY_INPUT,
))

_register(WidgetSchema(
    type_key="arc", label_de="Bogen (Arc)", label_en="Arc",
    default_size=(120, 120),
    parts=("main", "indicator", "knob"),
    properties=(
        PropertyDef("value", "int", CONTENT, default=0, label_de="Wert", label_en="Value"),
        PropertyDef("min_value", "int", CONTENT, default=0, label_de="Min", label_en="Min"),
        PropertyDef("max_value", "int", CONTENT, default=100, label_de="Max", label_en="Max"),
        PropertyDef("start_angle", "int", CONTENT, default=135,
                    label_de="Startwinkel", label_en="Start angle"),
        PropertyDef("end_angle", "int", CONTENT, default=45,
                    label_de="Endwinkel", label_en="End angle"),
        PropertyDef("rotation", "int", CONTENT, default=0,
                    label_de="Rotation", label_en="Rotation"),
        PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                    enum_values=("NORMAL", "REVERSE", "SYMMETRICAL"),
                    label_de="Modus", label_en="Mode"),
        PropertyDef("adjustable", "bool", CONTENT, default=False,
                    label_de="Bedienbar (adjustable)", label_en="Adjustable"),
        PropertyDef("change_rate", "int", CONTENT, default=720,
                    label_de="Änderungsrate", label_en="Change rate"),
        *_paint_style_props(),
        PropertyDef("arc_color", "color", STYLE, part="indicator",
                    label_de="Bogenfarbe", label_en="Arc colour"),
        PropertyDef("arc_width", "int", STYLE, default=0, part="indicator",
                    label_de="Bogenbreite", label_en="Arc width"),
        PropertyDef("bg_color", "color", STYLE, part="knob",
                    label_de="Knopf-Farbe", label_en="Knob colour"),
    ),
    category=CATEGORY_INPUT,
))

_register(WidgetSchema(
    type_key="bar", label_de="Balken (Bar)", label_en="Bar",
    default_size=(150, 20),
    parts=("main", "indicator"),
    properties=(
        PropertyDef("value", "int", CONTENT, default=0, label_de="Wert", label_en="Value"),
        PropertyDef("min_value", "int", CONTENT, default=0, label_de="Min", label_en="Min"),
        PropertyDef("max_value", "int", CONTENT, default=100, label_de="Max", label_en="Max"),
        PropertyDef("start_value", "int", CONTENT, default=0,
                    label_de="Startwert", label_en="Start value"),
        PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                    enum_values=("NORMAL", "SYMMETRICAL", "RANGE"),
                    label_de="Modus", label_en="Mode"),
        PropertyDef("animated", "bool", CONTENT, default=True,
                    label_de="Animiert", label_en="Animated"),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="indicator",
                    label_de="Füllfarbe", label_en="Indicator colour"),
    ),
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="dropdown", label_de="Dropdown", label_en="Dropdown",
    default_size=(150, 40),
    parts=("main", "selected", "list", "scrollbar"),
    properties=(
        PropertyDef("options", "text_list", CONTENT,
                    label_de="Optionen", label_en="Options"),
        PropertyDef("selected_index", "int", CONTENT, default=0,
                    label_de="Ausgewählter Index", label_en="Selected index"),
        PropertyDef("symbol", "text", CONTENT,
                    label_de="Symbol", label_en="Symbol"),
        PropertyDef("dir", "enum", CONTENT, default="DOWN",
                    enum_values=("UP", "DOWN", "LEFT", "RIGHT"),
                    label_de="Öffnungsrichtung", label_en="Open direction"),
        PropertyDef("max_height", "int", CONTENT,
                    label_de="Maximale Höhe", label_en="Max height"),
        *_text_style_props(),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="selected",
                    label_de="Farbe (ausgewählt)", label_en="Colour (selected)"),
    ),
    category=CATEGORY_INPUT,
))

_register(WidgetSchema(
    type_key="roller", label_de="Roller", label_en="Roller",
    default_size=(150, 80),
    parts=("main", "selected", "items"),
    properties=(
        PropertyDef("options", "text_list", CONTENT,
                    label_de="Optionen", label_en="Options"),
        PropertyDef("selected_index", "int", CONTENT, default=0,
                    label_de="Ausgewählter Index", label_en="Selected index"),
        PropertyDef("visible_row_count", "int", CONTENT, default=3,
                    label_de="Sichtbare Zeilen", label_en="Visible rows"),
        PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                    enum_values=("NORMAL", "INFINITE"),
                    label_de="Modus", label_en="Mode"),
        *_text_style_props(),
        *_paint_style_props(),
        PropertyDef("bg_color", "color", STYLE, part="selected",
                    label_de="Farbe (ausgewählt)", label_en="Colour (selected)"),
    ),
    category=CATEGORY_INPUT,
))

_register(WidgetSchema(
    type_key="textarea", label_de="Textfeld (Textarea)", label_en="Textarea",
    default_size=(200, 60),
    parts=("main", "selected", "scrollbar", "cursor"),
    properties=(
        PropertyDef("text", "text", CONTENT,
                    label_de="Text", label_en="Text"),
        PropertyDef("placeholder_text", "text", CONTENT,
                    label_de="Platzhaltertext", label_en="Placeholder text"),
        PropertyDef("one_line", "bool", CONTENT, default=False,
                    label_de="Einzeilig", label_en="Single line"),
        PropertyDef("password_mode", "bool", CONTENT, default=False,
                    label_de="Passwort-Modus", label_en="Password mode"),
        PropertyDef("max_length", "int", CONTENT,
                    label_de="Maximale Länge", label_en="Max length"),
        PropertyDef("accepted_chars", "text", CONTENT,
                    label_de="Erlaubte Zeichen", label_en="Accepted characters"),
        *_text_style_props(),
        *_paint_style_props(),
    ),
    category=CATEGORY_INPUT,
))

_register(WidgetSchema(
    type_key="keyboard", label_de="Tastatur", label_en="Keyboard",
    default_size=(320, 160),
    properties=(
        # A plain widget-id reference, not a style/content literal - the
        # frontend renders this as a picker over the project's textarea
        # widgets rather than a free-text field (widgetschema.py has no
        # notion of "the id of another widget", so this is recognised by
        # the frontend purely from the `widget_ref` kind + `textarea` key).
        PropertyDef("textarea", "widget_ref", CONTENT,
                    label_de="Verknüpftes Textfeld", label_en="Linked textarea"),
        PropertyDef("mode", "enum", CONTENT, default="TEXT_LOWER",
                    enum_values=("TEXT_LOWER", "TEXT_UPPER", "TEXT_SPECIAL", "NUMBER"),
                    label_de="Modus", label_en="Mode"),
        *_paint_style_props(),
    ),
    category=CATEGORY_INPUT,
))

# `tile` is a synthetic pseudo-widget, not a real ESPHome LVGL widget type:
# it exists only to hold one entry of a `tileview`'s `tiles:` list (its
# `WidgetNode.tile_row`/`tile_col`/`tile_dir` fields, not any PropertyDef -
# a tile has no styling of its own in real ESPHome YAML) plus that entry's
# own nested `widgets:` as this node's children. `is_stub` keeps it out of
# the palette; yamlimport.py/yamlexport.py translate `tiles:` <-> children
# of a `tileview` node specifically.
_register(WidgetSchema(
    type_key="tile", label_de="Kachel", label_en="Tile",
    default_size=(200, 200),
    allows_children=True,
    is_stub=True,
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="tileview", label_de="Kachelansicht (Tileview)", label_en="Tileview",
    default_size=(300, 300),
    parts=("main", "scrollbar"),
    properties=(*_paint_style_props(),),
    allows_children=True,
    child_role="tile",
    category=CATEGORY_DISPLAY,
))

# `tab` is a synthetic pseudo-widget, not a real ESPHome LVGL widget type -
# the same pattern as `tile` above, but for a `tabview`'s `tabs:` list entry.
# Its only per-entry metadata is `name:`, held on `WidgetNode.tab_title`
# rather than a PropertyDef, since a tab has no styling of its own (that
# lives on `tabview.tab_style`/`content_style`, not modelled here yet).
_register(WidgetSchema(
    type_key="tab", label_de="Tab", label_en="Tab",
    default_size=(300, 260),
    allows_children=True,
    is_stub=True,
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="tabview", label_de="Tabs (Tabview)", label_en="Tabview",
    default_size=(300, 300),
    parts=("main", "scrollbar"),
    properties=(
        PropertyDef("position", "enum", CONTENT, default="TOP",
                    enum_values=("TOP", "BOTTOM", "LEFT", "RIGHT"),
                    label_de="Tableisten-Position", label_en="Tab bar position"),
        PropertyDef("size", "text", CONTENT, default="10%",
                    label_de="Tableisten-Größe", label_en="Tab bar size"),
        *_paint_style_props(),
    ),
    allows_children=True,
    child_role="tab",
    category=CATEGORY_DISPLAY,
))

# --- Phase 3 - specialised/rarer widgets -------------------------------------
# Only the widget types whose ESPHome config is a plain flat-property shape
# (see LVGL-VOLLSTAENDIGKEIT-UMSETZUNGSPLAN.md, Phase 3): `buttonmatrix`
# (per-button matrix editor), `msgboxes` (a top-level list, like `pages`, not
# a widget-tree entry), `line` (a points list, often lambda-driven) and
# `canvas` (pure draw-action API, nothing to visually edit) all need a
# fundamentally different editor and stay unregistered for now.

_register(WidgetSchema(
    type_key="led", label_de="LED", label_en="LED",
    default_size=(40, 40),
    properties=(
        PropertyDef("brightness", "text", CONTENT, default="100%",
                    label_de="Helligkeit", label_en="Brightness"),
        PropertyDef("color", "color", CONTENT,
                    label_de="Farbe", label_en="Colour"),
        *_paint_style_props(),
    ),
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="spinner", label_de="Spinner", label_en="Spinner",
    default_size=(60, 60),
    parts=("main", "indicator"),
    properties=(
        # These read like style keys but are the spinner's own flat
        # "Configuration variables" for its main-part spinning arc, not
        # STYLE properties nested under style_tree - ESPHome writes them
        # directly on the widget (see the docs example: `arc_color:` sits
        # next to `spin_time:`, not inside a `main:`/style block).
        PropertyDef("arc_color", "color", CONTENT,
                    label_de="Bogenfarbe", label_en="Arc colour"),
        PropertyDef("arc_width", "int", CONTENT, default=0,
                    label_de="Bogenbreite", label_en="Arc width"),
        PropertyDef("arc_length", "int", CONTENT, default=200,
                    label_de="Bogenlänge (Grad)", label_en="Arc length (degrees)"),
        PropertyDef("arc_rounded", "bool", CONTENT, default=False,
                    label_de="Bogenenden gerundet", label_en="Rounded arc ends"),
        PropertyDef("spin_time", "text", CONTENT, default="2s",
                    label_de="Umlaufzeit", label_en="Spin time"),
        PropertyDef("arc_color", "color", STYLE, part="indicator",
                    label_de="Indikator-Bogenfarbe", label_en="Indicator arc colour"),
        PropertyDef("arc_width", "int", STYLE, default=0, part="indicator",
                    label_de="Indikator-Bogenbreite", label_en="Indicator arc width"),
    ),
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="qrcode", label_de="QR-Code", label_en="QR code",
    default_size=(100, 100),
    properties=(
        PropertyDef("text", "text", CONTENT,
                    label_de="Text", label_en="Text"),
        PropertyDef("size", "int", CONTENT, default=100,
                    label_de="Größe", label_en="Size"),
        PropertyDef("dark_color", "color", CONTENT,
                    label_de="Dunkle Farbe", label_en="Dark colour"),
        PropertyDef("light_color", "color", CONTENT,
                    label_de="Helle Farbe", label_en="Light colour"),
        *_paint_style_props(),
    ),
    category=CATEGORY_DISPLAY,
))

_register(WidgetSchema(
    type_key="spinbox", label_de="Spinbox", label_en="Spinbox",
    default_size=(120, 40),
    properties=(
        PropertyDef("value", "float", CONTENT, default=0,
                    label_de="Wert", label_en="Value"),
        PropertyDef("range_from", "float", CONTENT, default=0,
                    label_de="Minimum", label_en="Minimum"),
        PropertyDef("range_to", "float", CONTENT, default=100,
                    label_de="Maximum", label_en="Maximum"),
        PropertyDef("digits", "int", CONTENT, default=4,
                    label_de="Ziffern", label_en="Digits"),
        PropertyDef("decimal_places", "int", CONTENT, default=0,
                    label_de="Nachkommastellen", label_en="Decimal places"),
        PropertyDef("selected_digit", "int", CONTENT, default=0,
                    label_de="Fokussierte Ziffer", label_en="Selected digit"),
        PropertyDef("rollover", "bool", CONTENT, default=False,
                    label_de="Überlauf", label_en="Rollover"),
        *_text_style_props(),
        *_paint_style_props(),
    ),
    category=CATEGORY_INPUT,
))
