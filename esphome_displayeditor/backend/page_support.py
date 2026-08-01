"""Add-on-only materialisation of ESPHome LVGL pages for the browser Viewer.

The designer core is intentionally byte-identical to the read-only desktop
application. It therefore continues to preserve pages/layers in
``Project.extra_lvgl``. This adapter turns that preserved YAML shape into the
normalised widget dictionaries consumed by the add-on frontend, without
changing the shared core or the saved/exported source representation.
"""

from __future__ import annotations

import copy
from typing import Any

from .designer_core.idgen import IdRegistry
from .designer_core.model import STYLE_PARTS, Project, WidgetNode
from .designer_core.widgetschema import LVGL_STYLE_KEYS, STATE_VALUES
from .designer_core.yamlexport import ExportIssue, _merge_passthrough, _widget_dict, clean_style_dict
from .designer_core.yamlimport import ImportIssue, _classify_style_dict, _import_widget

_SURFACE_STRUCTURAL_KEYS = {"id", "widgets", "layout", "skip"}


def _registry_for(project: Project) -> IdRegistry:
    registry = IdRegistry()
    for widget in project.all_widgets():
        registry.claim(widget.id, f"root widget '{widget.id}'")
    for kind, entries in (
        ("style", project.styles),
        ("font", project.fonts),
        ("image", project.images),
        ("color", project.colors),
    ):
        for entry in entries:
            registry.claim(entry.id, f"{kind} '{entry.id}'")
    return registry


def _surface(raw: Any, path: str, registry: IdRegistry,
             issues: list[ImportIssue]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    layout = raw.get("layout") if isinstance(raw.get("layout"), dict) else {}
    style_source = {
        key: value
        for key, value in raw.items()
        if key not in _SURFACE_STRUCTURAL_KEYS
        and (key in LVGL_STYLE_KEYS or key in STATE_VALUES or key in STYLE_PARTS)
    }
    style_tree = _classify_style_dict(style_source, issues, path) if style_source else {}
    extra = {
        key: value for key, value in raw.items()
        if key not in _SURFACE_STRUCTURAL_KEYS and key not in style_source
    }
    widgets = []
    for index, entry in enumerate(raw.get("widgets") or []):
        widget = _import_widget(entry, registry, issues, f"{path}.widgets[{index}]")
        if widget is not None:
            widgets.append(widget.to_dict())
    return {
        "widgets": widgets,
        "layout": dict(layout),
        "style_tree": style_tree,
        "extra": extra,
    }


def materialize_surfaces(project: Project,
                         issues: list[ImportIssue] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a frontend payload plus page/layer statistics.

    The raw keys remain in ``extra_lvgl`` so saving the project through the
    unchanged desktop-compatible core preserves the original YAML verbatim.
    """
    collected = issues if issues is not None else []
    registry = _registry_for(project)
    raw = project.extra_lvgl
    pages = []
    for index, page_raw in enumerate(raw.get("pages") or []):
        if not isinstance(page_raw, dict):
            continue
        page_id = str(page_raw.get("id") or registry.unique_id("page"))
        registry.claim(page_id, f"page at lvgl.pages[{index}]")
        surface = _surface(page_raw, f"lvgl.pages[{index}]", registry, collected)
        if surface is not None:
            pages.append({
                "id": page_id,
                "synthetic_id": not bool(page_raw.get("id")),
                "skip": bool(page_raw.get("skip", False)),
                **surface,
            })

    top_layer = _surface(raw.get("top_layer"), "lvgl.top_layer", registry, collected)
    bottom_layer = _surface(raw.get("bottom_layer"), "lvgl.bottom_layer", registry, collected)
    for message in registry.collisions():
        collected.append(ImportIssue("A", message))

    payload = project.to_dict()
    payload.update({
        "pages": pages,
        "page_wrap": bool(raw.get("page_wrap", True)),
        "top_layer": top_layer,
        "bottom_layer": bottom_layer,
    })
    surface_widgets = [
        widget
        for surface in [*pages, top_layer, bottom_layer]
        if surface
        for widget in _walk_widget_dicts(surface.get("widgets", []))
    ]
    types: dict[str, int] = {}
    for widget in surface_widgets:
        widget_type = str(widget.get("widget_type", ""))
        types[widget_type] = types.get(widget_type, 0) + 1
    return payload, {
        "page_count": len(pages),
        "surface_widget_count": len(surface_widgets),
        "surface_widget_types": types,
        "has_top_layer": top_layer is not None,
        "has_bottom_layer": bottom_layer is not None,
    }


def apply_surface_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Fold editable add-on surfaces back into the core passthrough shape.

    ``Project`` deliberately stays byte-compatible with the desktop project
    and therefore does not own pages/layers.  The browser sends normalized
    surfaces alongside the core payload; before ``Project.from_dict`` this
    adapter serializes their widgets and styles back into ``extra_lvgl``.
    Stored projects and exported YAML consequently contain the edited source
    of truth instead of a browser-only sidecar.
    """
    if not any(key in payload for key in ("pages", "top_layer", "bottom_layer", "page_wrap")):
        return payload

    normalized = copy.deepcopy(payload)
    extra_lvgl = dict(normalized.get("extra_lvgl") or {})
    registry = IdRegistry()
    export_issues: list[ExportIssue] = []

    def widget_entries(nodes: Any) -> list[dict[str, Any]]:
        result = []
        for raw in nodes if isinstance(nodes, list) else []:
            if not isinstance(raw, dict):
                continue
            node = WidgetNode.from_dict(raw)
            result.append({node.widget_type: _widget_dict(node, registry, export_issues)})
        return result

    def surface_dict(surface: Any, *, page: bool = False) -> dict[str, Any] | None:
        if not isinstance(surface, dict):
            return None
        result: dict[str, Any] = {}
        if page and not surface.get("synthetic_id"):
            result["id"] = str(surface.get("id", ""))
        if page and surface.get("skip"):
            result["skip"] = True
        layout = surface.get("layout")
        if isinstance(layout, dict) and layout:
            result["layout"] = copy.deepcopy(layout)
        style_tree = surface.get("style_tree")
        if isinstance(style_tree, dict) and style_tree:
            result.update(clean_style_dict(style_tree))
        preserved = surface.get("extra")
        if isinstance(preserved, dict):
            _merge_passthrough(result, preserved, export_issues, str(surface.get("id", "surface")))
        widgets = widget_entries(surface.get("widgets"))
        if widgets:
            result["widgets"] = widgets
        else:
            result["widgets"] = []
        return result

    raw_pages = normalized.get("pages")
    pages = []
    for entry in raw_pages if isinstance(raw_pages, list) else []:
        converted = surface_dict(entry, page=True)
        if converted is not None:
            pages.append(converted)
    if pages:
        extra_lvgl["pages"] = pages
        extra_lvgl["page_wrap"] = bool(normalized.get("page_wrap", True))
    else:
        extra_lvgl.pop("pages", None)
        extra_lvgl.pop("page_wrap", None)

    for payload_key, lvgl_key in (("bottom_layer", "bottom_layer"), ("top_layer", "top_layer")):
        converted = surface_dict(normalized.get(payload_key))
        if converted is None:
            extra_lvgl.pop(lvgl_key, None)
        else:
            extra_lvgl[lvgl_key] = converted

    normalized["extra_lvgl"] = extra_lvgl
    return normalized


def _walk_widget_dicts(widgets: list[dict[str, Any]]):
    for widget in widgets:
        yield widget
        yield from _walk_widget_dicts(widget.get("children", []))


def strip_empty_root_widgets(yaml_text: str, project: Project) -> str:
    """Remove the core's synthetic empty root list when raw pages are present."""
    if not project.extra_lvgl.get("pages") or project.widgets:
        return yaml_text
    lines = yaml_text.splitlines(keepends=True)
    inside_lvgl = False
    result = []
    removed = False
    for line in lines:
        if line == "lvgl:\n" or line == "lvgl:\r\n":
            inside_lvgl = True
        elif inside_lvgl and line and not line.startswith((" ", "\t", "\r", "\n")):
            inside_lvgl = False
        if inside_lvgl and not removed and line.strip() == "widgets: []":
            removed = True
            continue
        result.append(line)
    return "".join(result)
