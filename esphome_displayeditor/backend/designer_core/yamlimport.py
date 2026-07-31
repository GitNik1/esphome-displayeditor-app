"""Read an existing ESPHome config back into a Project.

The inverse of yamlexport, but with a harder job: that module only has to
reproduce its own output, whereas this one has to make sense of YAML a human
wrote. Two consequences shape the whole design.

**Everything unmodelled is preserved verbatim.** ESPHome's LVGL component has
roughly ninety style properties and two dozen widget types; this designer
models a fraction of them. Anything not recognised is kept in ``extra`` and
written back untouched on export, so importing and re-exporting a config never
silently deletes the parts the editor does not understand.

**Classification is the core problem.** In the YAML a widget is one flat
mapping in which geometry, content properties, style properties, grid
placement, event handlers and nested part/state blocks all sit side by side.
``_classify_widget_body`` is the cascade that sorts them apart; the ordering of
its rules is load-bearing and commented where it matters.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import yaml

from .idgen import IdRegistry, slugify
from .model import (
    DEFAULT_H,
    DEFAULT_W,
    STATES_KEY,
    STYLE_PARTS,
    ColorLibraryEntry,
    FontLibraryEntry,
    ImageLibraryEntry,
    Project,
    StyleLibraryEntry,
    WidgetNode,
)
from .widgetschema import LVGL_STYLE_KEYS, STATE_VALUES, WIDGET_SCHEMAS

#: Widget keys that map onto a WidgetNode field rather than a property dict.
_GEOMETRY_KEYS = {"x", "y", "width", "height", "align", "align_to", "hidden"}

#: Keys handled structurally, never classified.
_STRUCTURAL_KEYS = {"id", "widgets"}

_GRID_CELL_PREFIX = "grid_cell_"

#: Display models whose pixel size is not stated anywhere in the config.
#: ESPHome knows them from its own board definitions, which we cannot read.
DISPLAY_MODEL_SIZES = {
    "WAVESHARE-P4-86-PANEL": (720, 720),
}


class LvglImportError(Exception):
    """The document cannot be turned into a project at all."""


@dataclass
class ImportIssue:
    severity: str  # "A" blocks, "B" warns, "C" is informational
    message: str
    path: str = ""
    widget_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"severity": self.severity, "message": self.message,
                "path": self.path, "widget_id": self.widget_id}


@dataclass
class ImportResult:
    project: Project
    issues: list[ImportIssue] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)


# --- tolerant loading -------------------------------------------------------

class TaggedScalar(str):
    """A scalar carrying an ESPHome tag (``!secret wifi_password``).

    Subclasses str so every consumer can treat it as text, while the tag
    survives for the exporter to write back.
    """

    tag: str = ""

    def __new__(cls, value: str, tag: str = ""):
        obj = super().__new__(cls, value)
        obj.tag = tag
        return obj


class _ImportLoader(yaml.SafeLoader):
    """SafeLoader that tolerates ESPHome's custom tags.

    filesystem._EspHomeLoader does the same for the syntax check, but collapses
    a tagged scalar to bare text; here the tag has to survive the round trip.
    """


def _construct_tagged(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        return TaggedScalar(loader.construct_scalar(node), f"!{tag_suffix}")
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_ImportLoader.add_multi_constructor("!", _construct_tagged)


def load_lvgl_yaml(text: str) -> dict[str, Any]:
    try:
        doc = yaml.load(text, Loader=_ImportLoader)
    except yaml.YAMLError as exc:
        raise LvglImportError(f"The file is not valid YAML: {exc}") from exc
    if not isinstance(doc, dict):
        raise LvglImportError("The file does not contain a YAML mapping.")
    return doc


# --- value normalisation ----------------------------------------------------

def _normalise_color(value: Any) -> Any:
    """``bg_color: 0x2DD4BF`` is a plain int to any YAML parser, so a colour
    read back from a file arrives as 2999743. The model stores colours as hex
    text (it also accepts CSS names and colour-library ids), so ints have to be
    converted back or every imported colour is wrong."""
    if isinstance(value, bool) or not isinstance(value, int):
        return value
    if 0 <= value <= 0xFFFFFF:
        return f"{value:06X}"
    return value


def _normalise_style_values(tree: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in tree.items():
        if isinstance(value, dict):
            out[key] = _normalise_style_values(value)
        elif key.endswith("_color"):
            out[key] = _normalise_color(value)
        else:
            out[key] = value
    return out


# --- style dictionaries -----------------------------------------------------

def _classify_style_dict(body: dict[str, Any], issues: list[ImportIssue],
                         path: str) -> dict[str, Any]:
    """Sort a style mapping into properties, part blocks and state blocks.

    Used for ``style_definitions:`` entries, ``theme:`` entries and the nested
    part/state blocks inside a widget, so nesting behaves identically wherever
    a style dictionary appears.
    """
    out: dict[str, Any] = {}
    states: dict[str, Any] = {}
    for key, value in body.items():
        sub_path = f"{path}.{key}"
        if key in STATE_VALUES and isinstance(value, dict):
            states[key] = _classify_style_dict(value, issues, sub_path)
        elif key in STYLE_PARTS and isinstance(value, dict):
            out[key] = _classify_style_dict(value, issues, sub_path)
        elif key.endswith("_color"):
            out[key] = _normalise_color(value)
        else:
            if key not in LVGL_STYLE_KEYS:
                issues.append(ImportIssue(
                    "C", f"Style key '{key}' is preserved but not editable.", sub_path))
            out[key] = value
    if states:
        out[STATES_KEY] = states
    return out


# --- widgets ----------------------------------------------------------------

def _classify_widget_body(node: WidgetNode, body: dict[str, Any],
                          issues: list[ImportIssue], path: str) -> None:
    """Sort one widget's flat YAML mapping onto the model.

    First matching rule wins. Two orderings carry weight:

    * geometry before style - ``hidden``, ``width`` and ``align`` are node
      fields even though ESPHome also accepts them as style properties;
    * content before style - on an ``image`` widget ``angle``/``zoom`` are
      content properties and must stay under those names. As style keys the
      exporter would rename them to ``rotation``/``scale``, which is a one-way
      mapping and would quietly change what the widget does.
    """
    schema = WIDGET_SCHEMAS.get(node.widget_type)
    content_keys = {p.key for p in schema.content_properties()} if schema else set()
    states: dict[str, Any] = {}

    for key, value in body.items():
        sub_path = f"{path}.{key}"

        if key in _STRUCTURAL_KEYS:
            continue

        if key in _GEOMETRY_KEYS:
            if key == "hidden":
                node.hidden = bool(value)
            else:
                setattr(node, key, value)
            continue

        if key == "layout" and isinstance(value, dict):
            node.layout = dict(value)
            continue

        if key.startswith(_GRID_CELL_PREFIX):
            node.grid_cell[key[len(_GRID_CELL_PREFIX):]] = value
            continue

        if key in STATE_VALUES and isinstance(value, dict):
            states[key] = _classify_style_dict(value, issues, sub_path)
            continue

        if key in STYLE_PARTS and isinstance(value, dict):
            node.style_tree[key] = _classify_style_dict(value, issues, sub_path)
            continue

        if key == "styles":
            node.style_refs = [value] if isinstance(value, str) else list(value or [])
            node.style_mode = "named"
            continue

        # ESPHome's automation triggers are all on_*; their action lists have
        # no schema, so they are kept exactly as written.
        if key.startswith("on_"):
            node.events[key] = value
            continue

        if key in content_keys:
            node.properties[key] = _normalise_color(value) if key.endswith("_color") else value
            continue

        if key in LVGL_STYLE_KEYS:
            node.style_tree[key] = _normalise_color(value) if key.endswith("_color") else value
            continue

        issues.append(ImportIssue(
            "C", f"Key '{key}' is preserved but not editable.", sub_path, node.id))
        node.extra[key] = value

    if states:
        node.style_tree[STATES_KEY] = states


def _import_widget(entry: Any, registry: IdRegistry, issues: list[ImportIssue],
                   path: str) -> WidgetNode | None:
    if not isinstance(entry, dict) or len(entry) != 1:
        issues.append(ImportIssue(
            "B", "Skipped a widget entry that is not a single-key mapping.", path))
        return None

    widget_type, body = next(iter(entry.items()))
    if body is None:
        body = {}
    if not isinstance(body, dict):
        issues.append(ImportIssue(
            "B", f"Skipped '{widget_type}': its body is not a mapping.", path))
        return None

    schema = WIDGET_SCHEMAS.get(widget_type)
    widget_id = str(body.get("id") or "")
    synthetic = not widget_id
    if synthetic:
        # unique_id only *finds* a free id - it has to be claimed too, or the
        # next anonymous widget of the same type is handed the same one.
        widget_id = registry.unique_id(slugify(widget_type) or "widget")
    registry.claim(widget_id, f"widget at {path}")

    node = WidgetNode(id=widget_id, widget_type=widget_type)
    node.source = "imported"
    node.synthetic_id = synthetic
    if schema is None:
        issues.append(ImportIssue(
            "B", f"Widget type '{widget_type}' has no editor support; "
                 f"it is preserved and written back unchanged.", path, widget_id))

    # A grid- or flex-managed widget usually states no size at all and lets
    # LVGL derive it. Substituting the schema default here would look harmless
    # but the exporter writes width/height unconditionally, so it would inject
    # a fixed size into every such widget and break the layout on write-back.
    # None means "the source did not say"; the canvas falls back to a default,
    # the exporter stays silent.
    node.width = None
    node.height = None

    _classify_widget_body(node, body, issues, path)

    children = body.get("widgets") or []
    for index, child in enumerate(children):
        child_node = _import_widget(child, registry, issues, f"{path}.widgets[{index}]")
        if child_node is not None:
            node.children.append(child_node)
    return node


# --- libraries --------------------------------------------------------------

def _import_images(doc: dict[str, Any], issues: list[ImportIssue]) -> list[ImageLibraryEntry]:
    entries = []
    for index, raw in enumerate(doc.get("image") or []):
        if not isinstance(raw, dict):
            continue
        entry = ImageLibraryEntry(id=str(raw.get("id", "")))
        entry.file_path = str(raw.get("file", ""))
        entry.resize = str(raw.get("resize", ""))
        entry.dither = str(raw.get("dither", ""))
        entry.transparency = str(raw.get("transparency", "opaque"))
        entry.external = True
        entry.extra = {k: v for k, v in raw.items()
                       if k not in {"id", "file", "resize", "dither", "transparency",
                                    "platform"}}
        if entry.extra:
            issues.append(ImportIssue(
                "C", f"Image '{entry.id}': keys {sorted(entry.extra)} preserved verbatim.",
                f"image[{index}]"))
        entries.append(entry)
    return entries


def _import_fonts(doc: dict[str, Any], issues: list[ImportIssue]) -> list[FontLibraryEntry]:
    entries = []
    for index, raw in enumerate(doc.get("font") or []):
        if not isinstance(raw, dict):
            continue
        entry = FontLibraryEntry(id=str(raw.get("id", "")))
        entry.size = int(raw.get("size", 16) or 16)
        entry.bpp = int(raw.get("bpp", 4) or 4)
        entry.glyphs = list(raw.get("glyphs", []) or [])
        entry.glyphsets = list(raw.get("glyphsets", []) or [])
        entry.external = True

        source = raw.get("file")
        known = {"id", "size", "bpp", "glyphs", "glyphsets", "file", "extras"}
        if isinstance(source, dict) and source.get("type") == "web":
            entry.source_kind = "web"
            entry.web_url = str(source.get("url", ""))
            # `refresh:` and friends live inside the file mapping.
            rest = {k: v for k, v in source.items() if k not in {"type", "url"}}
            if rest:
                entry.extra["file"] = {"type": "web", "url": entry.web_url, **rest}
        elif isinstance(source, str) and source.startswith("gfonts://"):
            entry.source_kind = "gfonts"
            entry.gfonts_family = source[len("gfonts://"):]
        elif source is not None:
            entry.source_kind = "file"
            entry.file_path = str(source)

        entry.extra.update({k: v for k, v in raw.items() if k not in known})
        entries.append(entry)
    return entries


def _import_colors(doc: dict[str, Any]) -> list[ColorLibraryEntry]:
    entries = []
    for raw in doc.get("color") or []:
        if not isinstance(raw, dict):
            continue
        value = raw.get("hex", "FFFFFF")
        # An unquoted six-digit hex reads back as an int, exactly like a colour.
        if isinstance(value, int):
            value = f"{value:06X}"
        entries.append(ColorLibraryEntry(id=str(raw.get("id", "")), hex=str(value).upper()))
    return entries


def _import_styles(lvgl: dict[str, Any], issues: list[ImportIssue]) -> list[StyleLibraryEntry]:
    entries = []
    for index, raw in enumerate(lvgl.get("style_definitions") or []):
        if not isinstance(raw, dict):
            continue
        body = {k: v for k, v in raw.items() if k != "id"}
        entries.append(StyleLibraryEntry(
            id=str(raw.get("id", "")),
            style_tree=_classify_style_dict(body, issues, f"style_definitions[{index}]"),
        ))
    return entries


# --- canvas size ------------------------------------------------------------

_DIMENSION_RE = re.compile(r"^\s*(\d+)\s*[xX*]\s*(\d+)\s*$")


def _detect_canvas_size(doc: dict[str, Any], widgets: list[WidgetNode],
                        issues: list[ImportIssue]) -> tuple[int, int, str]:
    """A device config rarely states its pixel size: ``display:`` usually names
    a board model and ESPHome resolves the geometry from its own definitions.
    Each strategy is tried in turn and the winner is recorded, so the UI can
    show the user how the number was arrived at instead of pretending to know.
    """
    displays = doc.get("display") or []
    for entry in displays:
        if not isinstance(entry, dict):
            continue
        dimensions = entry.get("dimensions")
        if isinstance(dimensions, dict) and "width" in dimensions:
            return int(dimensions["width"]), int(dimensions["height"]), "display_dimensions"
        if isinstance(dimensions, str):
            match = _DIMENSION_RE.match(dimensions)
            if match:
                return int(match.group(1)), int(match.group(2)), "display_dimensions"
        model = str(entry.get("model", "")).upper()
        if model in DISPLAY_MODEL_SIZES:
            return (*DISPLAY_MODEL_SIZES[model], "display_model")

    # A single root container laying out a fixed grid describes the panel it
    # was drawn for; summing the tracks recovers the size the author had in
    # mind. Only valid when every track is a plain pixel count.
    if len(widgets) == 1 and widgets[0].layout.get("type") == "GRID":
        rows = widgets[0].layout.get("grid_rows") or []
        columns = widgets[0].layout.get("grid_columns") or []
        if rows and columns and all(isinstance(v, int) for v in [*rows, *columns]):
            return sum(columns), sum(rows), "root_grid"

    extent_x = [int(w.x) + int(w.width) for w in _walk(widgets)
                if isinstance(w.x, int) and isinstance(w.width, int)]
    extent_y = [int(w.y) + int(w.height) for w in _walk(widgets)
                if isinstance(w.y, int) and isinstance(w.height, int)]
    if extent_x and extent_y and max(extent_x) > 0 and max(extent_y) > 0:
        return max(extent_x), max(extent_y), "bounding_box"

    issues.append(ImportIssue(
        "B", f"Could not determine the display size; assuming {DEFAULT_W}x{DEFAULT_H}."))
    return DEFAULT_W, DEFAULT_H, "default"


def _walk(nodes: list[WidgetNode]):
    for node in nodes:
        yield from node.walk()


# --- entry points -----------------------------------------------------------

#: lvgl: keys this build understands. Everything else is preserved verbatim.
_KNOWN_LVGL_KEYS = {
    "widgets", "style_definitions", "theme", "displays", "default_font", "color_depth",
}


def import_esphome_yaml(text: str, *, source_name: str = "",
                        canvas_size: tuple[int, int] | None = None) -> ImportResult:
    """Turn an ESPHome config into a Project.

    Reads the ``lvgl:`` block plus the asset blocks it references. Everything
    else in the device config (``esphome:``, ``wifi:``, ``switch:``, ...) is
    ignored and never stored: the export target is a standalone LVGL file, and
    the source config is never written back to.
    """
    doc = load_lvgl_yaml(text)

    lvgl = doc.get("lvgl")
    if isinstance(lvgl, list):
        lvgl = lvgl[0] if lvgl else None
    if not isinstance(lvgl, dict):
        raise LvglImportError("The file has no 'lvgl:' block to import.")

    issues: list[ImportIssue] = []
    project = Project()
    registry = IdRegistry()

    project.images = _import_images(doc, issues)
    project.fonts = _import_fonts(doc, issues)
    project.colors = _import_colors(doc)
    project.styles = _import_styles(lvgl, issues)
    for entry in [*project.styles, *project.fonts, *project.images, *project.colors]:
        if entry.id:
            registry.claim(entry.id, f"resource '{entry.id}'")

    displays = lvgl.get("displays") or []
    if displays:
        project.display_id_placeholder = str(displays[0])
    project.default_font = str(lvgl.get("default_font", "") or "")

    theme = lvgl.get("theme")
    if isinstance(theme, dict):
        project.theme = {
            widget_type: _classify_style_dict(style, issues, f"lvgl.theme.{widget_type}")
            for widget_type, style in theme.items()
            if isinstance(style, dict)
        }

    for index, entry in enumerate(lvgl.get("widgets") or []):
        node = _import_widget(entry, registry, issues, f"lvgl.widgets[{index}]")
        if node is not None:
            project.widgets.append(node)

    for key, value in lvgl.items():
        if key not in _KNOWN_LVGL_KEYS:
            project.extra_lvgl[key] = value
            issues.append(ImportIssue(
                "C", f"lvgl key '{key}' is preserved but not editable.", f"lvgl.{key}"))

    if canvas_size:
        project.canvas_width, project.canvas_height = canvas_size
        project.canvas_source = "user"
    else:
        width, height, how = _detect_canvas_size(doc, project.widgets, issues)
        project.canvas_width, project.canvas_height, project.canvas_source = width, height, how

    # The assets belong to the config we read; redefining them beside it would
    # collide on every id, so the export is restricted to the lvgl block.
    project.export_sections = ["lvgl"]
    if source_name:
        project.import_source = {"name": source_name}

    for message in registry.collisions():
        issues.append(ImportIssue("A", message))

    return ImportResult(project=project, issues=issues,
                        stats=_build_stats(project, issues))


def _build_stats(project: Project, issues: list[ImportIssue]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    unsupported: set[str] = set()
    preserved: set[str] = set()
    for node in project.all_widgets():
        counts[node.widget_type] = counts.get(node.widget_type, 0) + 1
        if node.widget_type not in WIDGET_SCHEMAS:
            unsupported.add(node.widget_type)
        preserved.update(node.extra)
    return {
        "widget_count": sum(counts.values()),
        "widget_types": dict(sorted(counts.items())),
        "unsupported_types": sorted(unsupported),
        "preserved_keys": sorted(preserved),
        "canvas": {"width": project.canvas_width, "height": project.canvas_height,
                   "source": project.canvas_source},
        "styles": len(project.styles),
        "images": len(project.images),
        "fonts": len(project.fonts),
        "issues": {severity: sum(1 for i in issues if i.severity == severity)
                   for severity in ("A", "B", "C")},
    }


def probe_esphome_yaml(text: str) -> dict[str, Any]:
    """Cheap pre-flight for the import dialog: what would happen, without
    committing to replacing whatever the user currently has open."""
    return import_esphome_yaml(text).stats
