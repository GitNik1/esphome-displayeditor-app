"""Generate a ready-to-include ESPHome YAML file (font:/image:/color:/lvgl:)
from a Project.

Two hard-won ESPHome/LVGL9 quirks are baked in here rather than discovered
again, both found in squareline-to-esphome/converter/styles.py through real
``esphome config`` runs against actual output:

* ``border_side: FULL`` does not exist in ESPHome (that is a SquareLine/LVGL
  bitmask value) - it must be expanded to the four individual sides.
* Legacy LVGL8 style property names (``zoom``, ``angle``, ...) still work as
  aliases but a generator should always emit the current LVGL9 names.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Any

import yaml

from .idgen import IdRegistry
from .model import Project, WidgetNode
from .widgetschema import WIDGET_SCHEMAS

_LEGACY_STYLE_REMAP = {
    "anim_time": "anim_duration", "transform_angle": "transform_rotation",
    "transform_zoom": "transform_scale", "zoom": "scale", "angle": "rotation",
    "shadow_ofs_x": "shadow_offset_x", "shadow_ofs_y": "shadow_offset_y",
}

_BORDER_SIDE_FULL = ["TOP", "BOTTOM", "LEFT", "RIGHT"]

_STYLE_PART_KEYS = {"indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor"}


class ExportError(Exception):
    """Raised for an issue severe enough to block the export outright."""


@dataclass
class ExportIssue:
    severity: str  # "A" blocks export, "B"/"C" are reported but non-fatal
    message: str
    widget_id: str = ""


@dataclass
class ExportResult:
    yaml_text: str
    issues: list[ExportIssue] = field(default_factory=list)
    assets_copied: list[str] = field(default_factory=list)

    def report(self) -> str:
        if not self.issues:
            return "No issues."
        return "\n".join(
            f"[{i.severity}] {i.message}" + (f" ({i.widget_id})" if i.widget_id else "")
            for i in self.issues
        )


class HexColor(int):
    """Marks an int that must be dumped as an unquoted 0xRRGGBB literal."""


class ESPHomeDumper(yaml.SafeDumper):
    """Reproduces ESPHome's hand-written YAML conventions.

    PyYAML's default int representer prints ``0x0E1116`` as the decimal
    925978; wrapping it in ``str`` instead gets it quoted (``'0x0E1116'``),
    because the YAML 1.1 resolver would otherwise read a bare ``0x...``
    scalar back as an int - PyYAML quotes it defensively. Tagging it
    explicitly as an int scalar (see the representer below) keeps it both
    unquoted *and* correctly round-tripping.
    """


def _represent_hexcolor(dumper: yaml.Dumper, value: HexColor):
    return dumper.represent_scalar("tag:yaml.org,2002:int", f"0x{int(value):06X}")


ESPHomeDumper.add_representer(HexColor, _represent_hexcolor)


def _is_hex_color(text: str) -> bool:
    v = text[2:] if text.lower().startswith("0x") else text
    return len(v) == 6 and all(c in "0123456789abcdefABCDEF" for c in v)


def resolve_color(value: Any):
    """A colour field accepts a hex string ('2DD4BF' / '0x2DD4BF'), a CSS
    colour name ('red'), or the bare id of a project colour-library entry -
    ESPHome's lv_color validator accepts exactly the same three forms."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if _is_hex_color(text):
        hexpart = text[2:] if text.lower().startswith("0x") else text
        return HexColor(int(hexpart, 16))
    return text  # CSS name or a color: library id


def resolve_border_side(raw) -> list[str]:
    tokens = raw.split("|") if isinstance(raw, str) else list(raw or [])
    expanded: list[str] = []
    for token in tokens:
        expanded.extend(_BORDER_SIDE_FULL if token == "FULL" else [token])
    seen: list[str] = []
    for p in expanded:
        if p not in seen:
            seen.append(p)
    return seen or ["NONE"]


def _resolve_style_value(key: str, value: Any) -> Any:
    if key == "border_side":
        return resolve_border_side(value)
    if key.endswith("_color"):
        return resolve_color(value)
    return value


def clean_style_dict(style_tree: dict[str, Any]) -> dict[str, Any]:
    """Remaps legacy property names and resolves colour values, recursively
    for the one level of part-nesting style_tree can have
    (``{"indicator": {"bg_color": ...}}``)."""
    out: dict[str, Any] = {}
    for key, value in style_tree.items():
        if key in _STYLE_PART_KEYS and isinstance(value, dict):
            sub = clean_style_dict(value)
            if sub:
                out[key] = sub
            continue
        canonical = _LEGACY_STYLE_REMAP.get(key, key)
        resolved = _resolve_style_value(canonical, value)
        if resolved is not None:
            out[canonical] = resolved
    return out


def _widget_content_dict(node: WidgetNode) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in node.properties.items():
        out[key] = resolve_color(value) if key.endswith("_color") else value
    return out


def _widget_dict(node: WidgetNode, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    schema = WIDGET_SCHEMAS.get(node.widget_type)
    if schema is None:
        issues.append(ExportIssue("A", f"Unknown widget type '{node.widget_type}'.", node.id))
        return {}

    out: dict[str, Any] = {}
    if node.id:
        out["id"] = node.id
    if node.x not in (0, "0"):
        out["x"] = node.x
    if node.y not in (0, "0"):
        out["y"] = node.y
    out["width"] = node.width
    out["height"] = node.height
    if node.align and node.align != "TOP_LEFT":
        out["align"] = node.align
    if node.align_to:
        out["align_to"] = node.align_to
    if node.hidden:
        out["hidden"] = True

    out.update(_widget_content_dict(node))

    if node.style_mode == "named" and node.style_refs:
        out["styles"] = node.style_refs[0] if len(node.style_refs) == 1 else list(node.style_refs)
    elif node.style_tree:
        out.update(clean_style_dict(node.style_tree))

    for trigger, actions in node.events.items():
        if actions:
            out[trigger] = actions

    if node.children:
        out["widgets"] = [{c.widget_type: _widget_dict(c, registry, issues)} for c in node.children]

    return out


def build_lvgl_tree(project: Project, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    lvgl: dict[str, Any] = {
        "displays": [project.display_id_placeholder],
        "color_depth": 16,
    }
    if project.default_font:
        lvgl["default_font"] = project.default_font

    widgets_out = [{c.widget_type: _widget_dict(c, registry, issues)} for c in project.widgets]
    if project.background.export_as_lvgl_image and project.background.path:
        widgets_out = [{
            "image": {
                "id": project.background.image_id,
                "src": project.background.image_id,
                "x": 0, "y": 0,
                "width": project.canvas_width, "height": project.canvas_height,
            }
        }] + widgets_out
    lvgl["widgets"] = widgets_out

    if project.styles:
        lvgl["style_definitions"] = [
            {"id": s.id, **clean_style_dict(s.style_tree)} for s in project.styles
        ]

    return lvgl


def build_font_block(project: Project) -> list[dict[str, Any]] | None:
    entries = []
    for f in project.fonts:
        if f.source_kind == "builtin":
            continue  # referenced by its LVGL builtin name only, no font: entry
        entry: dict[str, Any] = {"id": f.id, "size": f.size, "bpp": f.bpp}
        if f.source_kind == "gfonts":
            weight = f"@{f.gfonts_weight}" if f.gfonts_weight != 400 else ""
            italic = "italic" if f.gfonts_italic else ""
            entry["file"] = f"gfonts://{f.gfonts_family}{weight}{italic}"
        elif f.source_kind == "file":
            entry["file"] = f.file_path
        elif f.source_kind == "web":
            entry["file"] = {"type": "web", "url": f.web_url}
        if f.glyphs:
            entry["glyphs"] = f.glyphs
        if f.glyphsets:
            entry["glyphsets"] = f.glyphsets
        if f.extras:
            entry["extras"] = f.extras
        entries.append(entry)
    return entries or None


def _copy_asset(src_path: str, assets_dir: str, subfolder: str,
                issues: list[ExportIssue], copied: list[str]) -> str:
    if not src_path:
        return ""
    if src_path.startswith(("http://", "https://")):
        return src_path
    if not os.path.isfile(src_path):
        issues.append(ExportIssue("A", f"Asset file not found: {src_path}"))
        return os.path.basename(src_path)
    dest_dir = os.path.join(assets_dir, subfolder)
    os.makedirs(dest_dir, exist_ok=True)
    dest_name = os.path.basename(src_path)
    dest_path = os.path.join(dest_dir, dest_name)
    shutil.copyfile(src_path, dest_path)
    copied.append(dest_path)
    return f"assets/{subfolder}/{dest_name}"


def build_image_block(project: Project, assets_dir: str,
                      issues: list[ExportIssue]) -> tuple[list[dict[str, Any]] | None, list[str]]:
    entries = []
    copied: list[str] = []
    for img in project.images:
        entry: dict[str, Any] = {
            "platform": "file", "id": img.id,
            "file": _copy_asset(img.file_path, assets_dir, "images", issues, copied),
        }
        if img.resize:
            entry["resize"] = img.resize
        if img.dither:
            entry["dither"] = img.dither
        if img.transparency and img.transparency != "opaque":
            entry["transparency"] = img.transparency
        entries.append(entry)

    if project.background.export_as_lvgl_image and project.background.path:
        entries.append({
            "platform": "file", "id": project.background.image_id,
            "file": _copy_asset(project.background.path, assets_dir, "images", issues, copied),
            "resize": f"{project.canvas_width}x{project.canvas_height}",
        })

    return (entries or None), copied


def build_color_block(project: Project) -> list[dict[str, Any]] | None:
    if not project.colors:
        return None
    return [{"id": c.id, "hex": c.hex.lstrip("#").upper()} for c in project.colors]


def export_project(project: Project, output_path: str) -> ExportResult:
    """Write ``output_path`` (one combined YAML file: font:/image:/color:/
    lvgl: as sibling top-level keys) plus an ``assets/`` folder next to it
    for any locally-sourced images/fonts."""
    issues: list[ExportIssue] = []
    registry = IdRegistry()
    for w in project.all_widgets():
        registry.claim(w.id, f"widget '{w.id}'")
    for s in project.styles:
        registry.claim(s.id, f"style '{s.id}'")
    for f in project.fonts:
        registry.claim(f.id, f"font '{f.id}'")
    for i in project.images:
        registry.claim(i.id, f"image '{i.id}'")
    for c in project.colors:
        registry.claim(c.id, f"color '{c.id}'")
    issues.extend(ExportIssue("A", msg) for msg in registry.collisions())

    assets_dir = os.path.join(os.path.dirname(os.path.abspath(output_path)), "assets")

    doc: dict[str, Any] = {}
    color_block = build_color_block(project)
    if color_block:
        doc["color"] = color_block
    font_block = build_font_block(project)
    if font_block:
        doc["font"] = font_block
    image_block, copied = build_image_block(project, assets_dir, issues)
    if image_block:
        doc["image"] = image_block
    doc["lvgl"] = build_lvgl_tree(project, registry, issues)

    blocking = [i for i in issues if i.severity == "A"]
    if blocking:
        raise ExportError("\n".join(i.message for i in blocking))

    header = (
        "# Generated by ESPHome LVGL Designer - include with:\n"
        "#   packages:\n"
        f"#     ui: !include {os.path.basename(output_path)}\n"
        "#\n"
        f"# Requires a `display:` component with id: {project.display_id_placeholder}\n"
        "# in the target project - this file only defines the LVGL UI, not the\n"
        "# physical display/touchscreen hardware.\n\n"
    )
    body = yaml.dump(doc, Dumper=ESPHomeDumper, sort_keys=False,
                     default_flow_style=False, allow_unicode=True, width=100)

    return ExportResult(yaml_text=header + body, issues=issues, assets_copied=copied)
