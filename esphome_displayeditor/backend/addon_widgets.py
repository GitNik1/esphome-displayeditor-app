"""Add-on-only widget schemas that do not modify the shared desktop core.

The desktop application's core remains byte-identical and read-only.  These
schemas extend its in-memory registry only while the Home Assistant add-on is
running, so imported projects still use the existing generic project model.
"""

from __future__ import annotations

from .designer_core.widgetschema import (
    CONTENT,
    STYLE,
    PropertyDef,
    WIDGET_SCHEMAS,
    WidgetSchema,
    _paint_style_props,
    _text_style_props,
)


def _arc_style_props(part: str) -> tuple[PropertyDef, ...]:
    return (
        PropertyDef(
            "arc_color", "color", STYLE, part=part,
            label_de="Bogenfarbe", label_en="Arc colour",
        ),
        PropertyDef(
            "arc_width", "int", STYLE, part=part,
            label_de="Bogenbreite", label_en="Arc width",
        ),
        PropertyDef(
            "arc_rounded", "bool", STYLE, part=part, default=True,
            label_de="Abgerundete Enden", label_en="Rounded ends",
        ),
        PropertyDef(
            "arc_opa", "percent_or_enum", STYLE, part=part, default="COVER",
            enum_values=("TRANSP", "COVER"),
            label_de="Bogen-Deckkraft", label_en="Arc opacity",
        ),
    )


def register_addon_widgets() -> None:
    """Register idempotently so tests and app factories may import repeatedly."""
    if "bar" not in WIDGET_SCHEMAS:
        WIDGET_SCHEMAS["bar"] = WidgetSchema(
            type_key="bar",
            label_de="Balken (Bar)",
            label_en="Bar",
            default_size=(160, 24),
            parts=("main", "indicator"),
            properties=(
                PropertyDef("value", "int", CONTENT, default=0, label_de="Wert", label_en="Value"),
                PropertyDef("start_value", "int", CONTENT, default=0,
                            label_de="Startwert (Range)", label_en="Start value (range)"),
                PropertyDef("min_value", "int", CONTENT, default=0, label_de="Min", label_en="Min"),
                PropertyDef("max_value", "int", CONTENT, default=100, label_de="Max", label_en="Max"),
                PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                            enum_values=("NORMAL", "RANGE", "SYMMETRICAL"),
                            label_de="Modus", label_en="Mode"),
                PropertyDef("animated", "bool", CONTENT, default=True,
                            label_de="Animiert", label_en="Animated"),
                *_paint_style_props(),
                PropertyDef("bg_color", "color", STYLE, part="indicator",
                            label_de="Füllfarbe", label_en="Indicator colour"),
                PropertyDef("bg_opa", "percent_or_enum", STYLE, part="indicator", default="COVER",
                            enum_values=("TRANSP", "COVER"),
                            label_de="Füll-Deckkraft", label_en="Indicator opacity"),
            ),
        )

    if "arc" not in WIDGET_SCHEMAS:
        WIDGET_SCHEMAS["arc"] = WidgetSchema(
            type_key="arc",
            label_de="Bogen (Arc)",
            label_en="Arc",
            default_size=(120, 120),
            parts=("main", "indicator", "knob"),
            properties=(
                PropertyDef("value", "int", CONTENT, default=0, label_de="Wert", label_en="Value"),
                PropertyDef("min_value", "int", CONTENT, default=0, label_de="Min", label_en="Min"),
                PropertyDef("max_value", "int", CONTENT, default=100, label_de="Max", label_en="Max"),
                PropertyDef("mode", "enum", CONTENT, default="NORMAL",
                            enum_values=("NORMAL", "REVERSE", "SYMMETRICAL"),
                            label_de="Modus", label_en="Mode"),
                PropertyDef("start_angle", "int", CONTENT, default=135,
                            label_de="Startwinkel", label_en="Start angle"),
                PropertyDef("end_angle", "int", CONTENT, default=45,
                            label_de="Endwinkel", label_en="End angle"),
                PropertyDef("rotation", "int", CONTENT, default=0,
                            label_de="Drehung", label_en="Rotation"),
                PropertyDef("adjustable", "bool", CONTENT, default=False,
                            label_de="Verstellbar", label_en="Adjustable"),
                PropertyDef("change_rate", "int", CONTENT, default=720,
                            label_de="Änderungsrate (°/s)", label_en="Change rate (°/s)"),
                *_paint_style_props(),
                *_arc_style_props("main"),
                *_arc_style_props("indicator"),
                PropertyDef("bg_color", "color", STYLE, part="knob",
                            label_de="Knopf-Farbe", label_en="Knob colour"),
            ),
        )

    if "meter" not in WIDGET_SCHEMAS:
        WIDGET_SCHEMAS["meter"] = WidgetSchema(
            type_key="meter",
            label_de="Messinstrument (Meter)",
            label_en="Meter",
            default_size=(180, 180),
            parts=("main", "ticks", "indicator", "items"),
            properties=(
                PropertyDef(
                    "scales", "json", CONTENT, default=[],
                    label_de="Skalen (JSON)", label_en="Scales (JSON)",
                ),
                *_paint_style_props(),
                *_text_style_props("ticks"),
            ),
        )
