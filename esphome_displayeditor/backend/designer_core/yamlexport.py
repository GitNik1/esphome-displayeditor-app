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

import copy
import os
import re
import shutil
from dataclasses import dataclass, field
from typing import Any

import yaml

from .idgen import IdRegistry
from .model import STATES_KEY, FontLibraryEntry, Project, WidgetNode
from .widgetschema import LVGL_STYLE_KEYS, WIDGET_SCHEMAS

_LEGACY_STYLE_REMAP = {
    "anim_time": "anim_duration", "transform_angle": "transform_rotation",
    "transform_zoom": "transform_scale", "zoom": "scale", "angle": "rotation",
    "shadow_ofs_x": "shadow_offset_x", "shadow_ofs_y": "shadow_offset_y",
}

_BORDER_SIDE_FULL = ["TOP", "BOTTOM", "LEFT", "RIGHT"]

_STYLE_PART_KEYS = {"indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor", "list"}


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


#: Style keys ESPHome accepts as a time literal (``500ms``, ``1s``) rather
#: than a bare number of milliseconds - mirrors yamlimport.py's
#: _DURATION_KEYS minus "duration" itself, which is a widget *content*
#: property (handled in _widget_content_dict()), not a style key.
_TIME_STYLE_KEYS = {"anim_time", "anim_duration"}


def _resolve_style_value(key: str, value: Any) -> Any:
    if key == "border_side":
        return resolve_border_side(value)
    if key.endswith("_color"):
        return resolve_color(value)
    if key in _TIME_STYLE_KEYS and isinstance(value, (int, float)) and not isinstance(value, bool):
        # yamlimport.py's _normalise_duration() turns an imported "500ms"
        # into a plain int on the way in so a numeric UI control can edit
        # it; without the reverse conversion here, re-exporting it
        # unchanged writes a bare number, which ESPHome's
        # cv.positive_time_period rejects at compile time.
        return f"{value}ms"
    return value


def clean_style_dict(style_tree: dict[str, Any]) -> dict[str, Any]:
    """Remaps legacy property names and resolves colour values, recursively
    for the part-nesting style_tree can have (``{"indicator": {...}}``) and
    for per-state overrides (``{"states": {"pressed": {...}}}``).

    States are stored under a reserved key because part and state names share
    one namespace in YAML; here they are flattened back to the shape ESPHome
    expects, i.e. ``pressed:`` sitting next to ``indicator:``.
    """
    out: dict[str, Any] = {}
    for key, value in style_tree.items():
        if key == STATES_KEY and isinstance(value, dict):
            for state, sub_tree in value.items():
                sub = clean_style_dict(sub_tree) if isinstance(sub_tree, dict) else None
                if sub:
                    out[state] = sub
            continue
        if key in _STYLE_PART_KEYS and isinstance(value, dict):
            sub = clean_style_dict(value)
            if sub:
                out[key] = sub
            continue
        canonical = _LEGACY_STYLE_REMAP.get(key, key)
        # Only properties this build actually models get value resolution and
        # the legacy rename; anything else is passthrough from an import and
        # must reach the file exactly as it arrived.
        if canonical in LVGL_STYLE_KEYS or key in LVGL_STYLE_KEYS:
            resolved = _resolve_style_value(canonical, value)
        else:
            canonical, resolved = key, value
        if resolved is not None:
            out[canonical] = resolved
    return out


def _widget_content_dict(node: WidgetNode) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in node.properties.items():
        if key.endswith("_color"):
            out[key] = resolve_color(value)
        elif node.widget_type == "animimg" and key == "duration" and isinstance(value, (int, float)):
            # ESPHome's animimg `duration:` is a time period
            # (cv.positive_time_period) and rejects a bare number at compile
            # time ("Don't know what '1800' means as it has no time
            # *unit*!"). The designer's own "Dauer (ms)" field (and the
            # baked-flow-animation feature, which sets this from
            # frameCount * 300) always store it as a plain millisecond
            # count, so the unit is always "ms" here.
            out[key] = f"{value}ms"
        else:
            out[key] = value
    return out


def _widget_dict(node: WidgetNode, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    schema = WIDGET_SCHEMAS.get(node.widget_type)
    if schema is None:
        # An editor-created node of an unknown type is a bug and stays fatal.
        # An imported one came from a config that was valid ESPHome to begin
        # with, so refusing to write it back would be the greater harm.
        if node.source != "imported":
            issues.append(ExportIssue("A", f"Unknown widget type '{node.widget_type}'.", node.id))
            return {}
        issues.append(ExportIssue(
            "B", f"Widget type '{node.widget_type}' has no editor support; "
                 f"written back unchanged.", node.id))

    out: dict[str, Any] = {}
    if node.id and not node.synthetic_id:
        out["id"] = node.id
    if node.x not in (0, "0"):
        out["x"] = node.x
    if node.y not in (0, "0"):
        out["y"] = node.y
    # None means the source never specified a size - typically a grid or flex
    # child whose size LVGL derives. Emitting a value would silently pin it.
    if node.width is not None:
        out["width"] = node.width
    if node.height is not None:
        out["height"] = node.height
    if node.align and node.align != "TOP_LEFT":
        out["align"] = node.align
    if node.align_to:
        out["align_to"] = node.align_to
    if node.hidden:
        out["hidden"] = True

    if node.layout:
        out["layout"] = copy.deepcopy(node.layout)
    for key, value in node.grid_cell.items():
        out[f"grid_cell_{key}"] = value

    out.update(_widget_content_dict(node))

    # A widget may carry both a named style and inline overrides on top of it;
    # ESPHome applies them in that order. Treating them as mutually exclusive
    # silently dropped whichever half came second.
    if node.style_mode == "named" and node.style_refs:
        out["styles"] = node.style_refs[0] if len(node.style_refs) == 1 else list(node.style_refs)
    if node.style_tree:
        out.update(clean_style_dict(node.style_tree))

    for trigger, actions in node.events.items():
        if actions:
            out[trigger] = actions

    _merge_passthrough(out, node.extra, issues, node.id)

    if node.children:
        if node.widget_type == "tileview":
            out["tiles"] = [_tile_dict(c, registry, issues) for c in node.children]
        elif node.widget_type == "tabview":
            out["tabs"] = [_tab_dict(c, registry, issues) for c in node.children]
        else:
            out["widgets"] = [{c.widget_type: _widget_dict(c, registry, issues)} for c in node.children]

    return out


def _tab_dict(node: WidgetNode, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    """One synthetic ``tab`` child of a ``tabview``, as one entry of its
    ``tabs:`` list - see the ``tile``/``tileview`` comment in
    widgetschema.py for the same pattern applied to ``tabview``. ``name`` is
    ESPHome-required, so always emitted even when empty."""
    out: dict[str, Any] = {"name": node.tab_title}
    if node.id and not node.synthetic_id:
        out["id"] = node.id
    _merge_passthrough(out, node.extra, issues, node.id)
    if node.children:
        out["widgets"] = [{c.widget_type: _widget_dict(c, registry, issues)} for c in node.children]
    return out


def _tile_dict(node: WidgetNode, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    """One synthetic ``tile`` child of a ``tileview``, as one entry of its
    ``tiles:`` list - see the ``tile``/``tileview`` comment in
    widgetschema.py. ``row``/``column`` are ESPHome-required, so always
    emitted; ``dir`` is optional and only written when not its "ALL" default."""
    out: dict[str, Any] = {}
    if node.id and not node.synthetic_id:
        out["id"] = node.id
    out["column"] = node.tile_col
    out["row"] = node.tile_row
    if node.tile_dir and node.tile_dir != "ALL":
        out["dir"] = node.tile_dir.split(",") if "," in node.tile_dir else node.tile_dir
    _merge_passthrough(out, node.extra, issues, node.id)
    if node.children:
        out["widgets"] = [{c.widget_type: _widget_dict(c, registry, issues)} for c in node.children]
    return out


def _merge_passthrough(out: dict[str, Any], extra: dict[str, Any],
                       issues: list[ExportIssue], where: str = "") -> None:
    """Fold unmodelled keys back in without letting them clobber a value the
    editor is responsible for - if both produced the same key, the edited one
    is the newer truth."""
    for key, value in extra.items():
        if key in out:
            issues.append(ExportIssue(
                "C", f"Preserved key '{key}' also set by the editor; kept the edited value.",
                where))
            continue
        out[key] = copy.deepcopy(value)


def build_lvgl_tree(project: Project, registry: IdRegistry, issues: list[ExportIssue]) -> dict[str, Any]:
    lvgl: dict[str, Any] = {
        "displays": [project.display_id_placeholder],
        "color_depth": 16,
    }
    if project.default_font:
        lvgl["default_font"] = project.default_font
    if project.theme:
        theme_out = {
            widget_type: clean_style_dict(style_tree)
            for widget_type, style_tree in project.theme.items()
        }
        lvgl["theme"] = {k: v for k, v in theme_out.items() if v}

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

    _merge_passthrough(lvgl, project.extra_lvgl, issues, "lvgl")
    return lvgl


_MDI_WEBFONT_PATTERN = re.compile(r"materialdesignicons-webfont\.ttf(\?.*)?$", re.IGNORECASE)


def _is_mdi_webfont_url(url: str) -> bool:
    return bool(_MDI_WEBFONT_PATTERN.search(str(url or "").strip()))


def _is_mdi_font(f: FontLibraryEntry, project: Project) -> bool:
    """Whether ``f`` is the Pictogrammers MDI icon webfont - the only font
    glyph automation may touch. A pinned/managed revision's source_kind is
    "file" by the time it's exported, with the original URL only recorded in
    the project's own (designer-private) font-source metadata, not on the
    model field - both places have to be checked."""
    if f.source_kind == "web" and _is_mdi_webfont_url(f.web_url):
        return True
    font_sources = (project.import_source or {}).get("font_sources")
    meta = font_sources.get(f.id) if isinstance(font_sources, dict) else None
    return _is_mdi_webfont_url((meta or {}).get("url", ""))


def _effective_text_font(widget: WidgetNode, project: Project) -> str:
    """The font id a widget's ``text`` actually renders with, following the
    same precedence ESPHome's LVGL component applies: the widget's own style
    (inline or named) beats its type's theme default, which beats the
    project-wide default font."""
    if widget.style_mode == "named" and widget.style_refs:
        for ref in widget.style_refs:
            style = project.find_style(ref)
            font = style.style_tree.get("text_font") if style else None
            if font:
                return font
    else:
        font = widget.style_tree.get("text_font")
        if font:
            return font
    theme_style = project.theme.get(widget.widget_type)
    if isinstance(theme_style, dict) and theme_style.get("text_font"):
        return theme_style["text_font"]
    return project.default_font


def _collect_used_glyphs(project: Project) -> dict[str, set[str]]:
    """Every character actually typed into a static ``text`` property,
    grouped by the font id it renders with. The designer's model has no
    lambda/runtime text (that lives in the hand-maintained device config
    this file gets ``!include``d into), so every ``text`` value here is the
    literal, exported string - safe to scan exhaustively rather than only
    approximately."""
    used: dict[str, set[str]] = {}
    for widget in project.all_widgets():
        text = widget.properties.get("text")
        if not isinstance(text, str) or not text:
            continue
        font_id = _effective_text_font(widget, project)
        if not font_id:
            continue
        used.setdefault(font_id, set()).update(text)
    return used


def build_font_block(project: Project) -> list[dict[str, Any]] | None:
    used_glyphs = _collect_used_glyphs(project)
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
            # yamlimport stashes any other file:-level keys (refresh:, etc.)
            # in extra["file"] since they have no modeled field - merge them
            # back in here. The generic top-level extra merge below would
            # skip this entirely, since "file" is already a key of entry.
            extra_file = f.extra.get("file")
            if isinstance(extra_file, dict):
                entry["file"].update(
                    {k: v for k, v in extra_file.items() if k not in entry["file"]}
                )
        # Glyph automation is scoped to the MDI icon font only - every other
        # library font (Google Fonts, uploaded/linked TTFs, ...) is always
        # exported complete. Restricting an ordinary text font risks cutting
        # off characters some other, non-static part of the config still
        # needs; the MDI font is the one case where "only what's actually
        # used" is both safe (its glyph names/usage are fully known here) and
        # actually worth the code-size saving, given its ~7000-icon size.
        glyphs = sorted(set(f.glyphs) | used_glyphs.get(f.id, set())) if _is_mdi_font(f, project) else []
        if glyphs:
            entry["glyphs"] = glyphs
        if f.glyphsets:
            entry["glyphsets"] = f.glyphsets
        if f.extras:
            entry["extras"] = f.extras
        entry.update({k: v for k, v in f.extra.items() if k not in entry})
        entries.append(entry)
    return entries or None


def _copy_asset(src_path: str, assets_dir: str, subfolder: str,
                issues: list[ExportIssue], copied: list[str],
                external: bool = False) -> str:
    if not src_path:
        return ""
    if src_path.startswith(("http://", "https://")):
        return src_path
    if external:
        # The path belongs to the ESPHome project this was imported from and
        # is relative to *its* directory. Copying it here would both rewrite a
        # path that is already correct and require reading a host file.
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
            "file": _copy_asset(img.file_path, assets_dir, "images", issues, copied,
                                external=img.external),
        }
        if img.resize:
            entry["resize"] = img.resize
        if img.dither:
            entry["dither"] = img.dither
        if img.transparency and img.transparency != "opaque":
            entry["transparency"] = img.transparency
        if img.img_type:
            entry["type"] = img.img_type
        entry.update({k: v for k, v in img.extra.items() if k not in entry})
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
    # The reference-image background gets its own synthetic image: entry
    # further down (see the project.background.export_as_lvgl_image branch
    # below) when exported - without claiming its id here too, that entry
    # could silently collide with a real image's id and emit the same id
    # twice in the image: block, which ESPHome rejects at compile time as
    # "ID ... redefined!".
    if project.background.export_as_lvgl_image and project.background.path:
        registry.claim(project.background.image_id, "background image")
    issues.extend(ExportIssue("A", msg) for msg in registry.collisions())

    assets_dir = os.path.join(os.path.dirname(os.path.abspath(output_path)), "assets")

    # An imported project restricts this to ["lvgl"]: its fonts, images and
    # colours are already defined by the config it came from, and redefining
    # them beside it would collide on every id.
    sections = set(project.export_sections or ["color", "font", "image", "lvgl"])

    doc: dict[str, Any] = {}
    copied: list[str] = []
    if "color" in sections:
        color_block = build_color_block(project)
        if color_block:
            doc["color"] = color_block
    if "font" in sections:
        font_block = build_font_block(project)
        if font_block:
            doc["font"] = font_block
    if "image" in sections:
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
        "# physical display/touchscreen hardware.\n"
    )
    source_name = project.import_source.get("name") if project.import_source else None
    if source_name:
        header += (
            "#\n"
            f"# Imported from {source_name}, which was NOT modified.\n"
            "# Remove that file's own `lvgl:` block before including this one -\n"
            "# ESPHome would otherwise see the widget ids defined twice.\n"
        )
    header += "\n"
    body = yaml.dump(doc, Dumper=ESPHomeDumper, sort_keys=False,
                     default_flow_style=False, allow_unicode=True, width=100)

    return ExportResult(yaml_text=header + body, issues=issues, assets_copied=copied)
