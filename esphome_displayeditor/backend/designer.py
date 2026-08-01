"""Validation and export facade around the desktop designer's core model."""

from __future__ import annotations

import copy
import re
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .addon_widgets import register_addon_widgets
from .designer_core.idgen import IdRegistry
from .designer_core.model import PROJECT_FORMAT, PROJECT_FORMAT_VERSION, Project
from .designer_core.widgetschema import GRID_CELL_PROPS, STATE_VALUES, WIDGET_SCHEMAS
from .designer_core.yamlexport import ExportError, export_project
from .designer_core.yamlimport import (
    LvglImportError,
    import_esphome_yaml,
)
from .errors import ApiError
from .page_support import apply_surface_payload, materialize_surfaces, strip_empty_root_widgets

_ID_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

register_addon_widgets()


def _normalise_button_child_text(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Move legacy button ``text`` into a child label before export.

    ESPHome's LVGL button is a container.  Once it owns child widgets (for
    example the image and label of an image button), its caption must also be
    represented by a child ``label`` rather than by ``button.text``.  The
    browser migrates projects as soon as such a child is added; this export
    guard keeps older saved projects valid as well.  It is add-on-only so the
    shared, read-only desktop designer core stays byte-identical.
    """
    normalized = copy.deepcopy(payload)
    used_ids: set[str] = set()

    def surface_widget_lists() -> list[list[dict[str, Any]]]:
        lists: list[list[dict[str, Any]]] = []
        root = normalized.get("widgets")
        if isinstance(root, list):
            lists.append(root)
        pages = normalized.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if isinstance(page, dict) and isinstance(page.get("widgets"), list):
                    lists.append(page["widgets"])
        for layer_name in ("bottom_layer", "top_layer"):
            layer = normalized.get(layer_name)
            if isinstance(layer, dict) and isinstance(layer.get("widgets"), list):
                lists.append(layer["widgets"])
        return lists

    def collect_widget_ids(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if not isinstance(node, dict):
                continue
            widget_id = str(node.get("id", ""))
            if widget_id:
                used_ids.add(widget_id)
            children = node.get("children")
            if isinstance(children, list):
                collect_widget_ids(children)

    widget_lists = surface_widget_lists()
    for widgets in widget_lists:
        collect_widget_ids(widgets)
    for key in ("styles", "fonts", "images", "colors", "pages"):
        entries = normalized.get(key)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and entry.get("id"):
                    used_ids.add(str(entry["id"]))

    def unique_id(base: str) -> str:
        candidate = re.sub(r"[^A-Za-z0-9_]", "_", base).strip("_") or "button_label"
        if not re.match(r"^[A-Za-z_]", candidate):
            candidate = f"button_{candidate}"
        root = candidate
        suffix = 2
        while candidate in used_ids:
            candidate = f"{root}_{suffix}"
            suffix += 1
        used_ids.add(candidate)
        return candidate

    repaired: list[str] = []

    def visit(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if not isinstance(node, dict):
                continue
            children = node.get("children")
            if not isinstance(children, list):
                children = []
                node["children"] = children
            properties = node.get("properties")
            if (
                node.get("widget_type") == "button"
                and children
                and isinstance(properties, dict)
                and "text" in properties
            ):
                properties = dict(properties)
                text = properties.pop("text")
                node["properties"] = properties
                if text not in (None, ""):
                    button_id = str(node.get("id") or "button")
                    children.append({
                        "id": unique_id(f"{button_id}_label"),
                        "widget_type": "label",
                        "width": None,
                        "height": None,
                        "align": "CENTER",
                        "properties": {"text": text},
                        "children": [],
                        "synthetic_id": True,
                    })
                repaired.append(str(node.get("id") or "button"))
            visit(children)

    for widgets in widget_lists:
        visit(widgets)
    return normalized, repaired


def _is_remote_asset(path: str) -> bool:
    """Whether an asset source is fetched by ESPHome at compile time rather
    than read off this host. Mirrors the exporter's own URL handling."""
    return path.startswith(("http://", "https://"))


_CONFINED_ASSET_SUBDIRS = ("images", "fonts")


def _is_confined_asset_path(path: str) -> bool:
    """Whether a local path lives inside one of the add-on's own dedicated
    asset folders (``images/``, ``fonts/``) rather than being an arbitrary
    host path a user typed by hand. Those folders are exactly what
    ``write_image_asset``/``write_font_asset`` (manual TTF/OTF upload, the
    MDI webfont quick-add) confine themselves to, and reads through them are
    already containment-checked by ``FilesystemBackend._resolve`` - the
    export step itself never opens the file, only writes this string into
    the YAML, so blocking it here would just defeat those two features."""
    parts = Path(path).parts
    return (
        bool(parts) and parts[0] in _CONFINED_ASSET_SUBDIRS
        and ".." not in parts and not Path(path).is_absolute()
    )


class DesignerService:
    def __init__(self, data_root: Path) -> None:
        self.export_root = data_root / "exports"
        self.export_root.mkdir(parents=True, exist_ok=True)

    def schemas(self, language: str = "de") -> dict:
        lang = "en" if language == "en" else "de"
        widgets = []
        for schema in WIDGET_SCHEMAS.values():
            entry = asdict(schema)
            entry["label"] = schema.label(lang)
            entry["properties"] = [
                {**asdict(prop), "label": prop.label(lang)} for prop in schema.properties
            ]
            widgets.append(entry)
        return {
            "project_format": PROJECT_FORMAT,
            "project_format_version": PROJECT_FORMAT_VERSION,
            "widgets": widgets,
            # Grid placement is not a per-type property: any widget can be a
            # grid child, so it is described once instead of on every schema.
            "grid_cell_properties": [
                {**asdict(prop), "label": prop.label(lang)} for prop in GRID_CELL_PROPS
            ],
            "states": list(STATE_VALUES),
        }

    def validate(self, payload: dict[str, Any]) -> tuple[Project, list[dict]]:
        if payload.get("format") != PROJECT_FORMAT:
            raise ApiError("invalid_project", "Unknown or missing designer project format.")
        try:
            version = int(payload.get("format_version", 1))
        except (TypeError, ValueError) as exc:
            raise ApiError("invalid_project", "Project format version is invalid.") from exc
        if version > PROJECT_FORMAT_VERSION:
            raise ApiError(
                "unsupported_project_version",
                "The project was created by a newer designer version.",
                409,
                {"project_version": version, "supported_version": PROJECT_FORMAT_VERSION},
            )
        try:
            project = Project.from_dict(apply_surface_payload(payload))
        except (TypeError, ValueError, KeyError) as exc:
            raise ApiError("invalid_project", "Project data is malformed.") from exc
        if not (1 <= project.canvas_width <= 4096 and 1 <= project.canvas_height <= 4096):
            raise ApiError("invalid_project", "Canvas dimensions must be between 1 and 4096.")

        issues: list[dict] = []
        registry = IdRegistry()
        count = 0

        def visit(nodes, depth: int = 0, parent_path: str = "widgets") -> None:
            nonlocal count
            if depth > 32:
                raise ApiError("invalid_project", "Widget nesting exceeds 32 levels.")
            for index, node in enumerate(nodes):
                count += 1
                node_path = f"{parent_path}[{index}]"
                if count > 1000:
                    raise ApiError("invalid_project", "A project may contain at most 1000 widgets.")
                if node.widget_type not in WIDGET_SCHEMAS:
                    issues.append({"severity": "error", "widget": node.id, "message": "Unknown widget type."})
                if not _ID_PATTERN.fullmatch(node.id):
                    issues.append({"severity": "error", "widget": node.id, "message": "Invalid ESPHome id."})
                registry.claim(node.id, f"widget at {node_path}")
                visit(node.children, depth + 1, f"{node_path}.children")

        visit(project.widgets)
        surface_payload, _surface_stats = materialize_surfaces(project)

        def visit_surface_widgets(nodes, depth: int = 0, parent_path: str = "pages") -> None:
            nonlocal count
            if depth > 32:
                raise ApiError("invalid_project", "Widget nesting exceeds 32 levels.")
            for index, node in enumerate(nodes or []):
                count += 1
                node_path = f"{parent_path}[{index}]"
                if count > 1000:
                    raise ApiError("invalid_project", "A project may contain at most 1000 widgets.")
                widget_id = str(node.get("id", ""))
                widget_type = str(node.get("widget_type", ""))
                if widget_type not in WIDGET_SCHEMAS:
                    issues.append({
                        "severity": "error", "widget": widget_id,
                        "message": "Unknown widget type.",
                    })
                if not _ID_PATTERN.fullmatch(widget_id):
                    issues.append({
                        "severity": "error", "widget": widget_id,
                        "message": "Invalid ESPHome id.",
                    })
                registry.claim(widget_id, f"widget at {node_path}")
                visit_surface_widgets(
                    node.get("children", []), depth + 1, f"{node_path}.children")

        for page_index, page in enumerate(surface_payload.get("pages", [])):
            page_id = str(page.get("id", ""))
            if not _ID_PATTERN.fullmatch(page_id):
                issues.append({
                    "severity": "error", "page": page_id,
                    "message": "Invalid ESPHome page id.",
                })
            registry.claim(page_id, f"pages[{page_index}]")
            visit_surface_widgets(
                page.get("widgets", []), parent_path=f"pages[{page_index}].widgets")
        for layer_name in ("bottom_layer", "top_layer"):
            layer = surface_payload.get(layer_name)
            if layer:
                visit_surface_widgets(
                    layer.get("widgets", []), parent_path=f"{layer_name}.widgets")
        if project.widgets and surface_payload.get("pages"):
            issues.append({
                "severity": "error",
                "message": "ESPHome does not allow root widgets and pages together.",
            })
        for kind, entries in (
            ("style", project.styles),
            ("font", project.fonts),
            ("image", project.images),
            ("color", project.colors),
        ):
            for index, entry in enumerate(entries):
                if not _ID_PATTERN.fullmatch(entry.id):
                    issues.append({"severity": "error", "resource": entry.id, "message": f"Invalid {kind} id."})
                registry.claim(entry.id, f"{kind}[{index}]")
        issues.extend({"severity": "error", "message": message} for message in registry.collisions())

        # Importing assets from the local filesystem stays disabled until
        # uploads can be confined to a dedicated asset store - it would let a
        # project read arbitrary files off the host. Remote URLs carry no such
        # risk: this add-on never fetches them, it only writes them into the
        # exported YAML, and ESPHome resolves them at compile time. The
        # exporter already passes URLs through verbatim (see _copy_asset).
        # `external` assets belong to the ESPHome config a project was imported
        # from. Their paths are relative to *that* file and are only ever copied
        # into the exported YAML as text - the add-on never opens them - so they
        # carry none of the risk this rule exists to prevent. Paths inside the
        # add-on's own images/fonts asset folders are the dedicated store this
        # comment refers to (see _is_confined_asset_path) - the TTF/OTF upload
        # and the MDI webfont quick-add both write there.
        local_resources = [
            image.file_path
            for image in project.images
            if image.file_path
            and not image.external
            and not _is_remote_asset(image.file_path)
            and not _is_confined_asset_path(image.file_path)
        ]
        local_resources.extend(
            font.file_path
            for font in project.fonts
            if font.source_kind == "file"
            and font.file_path
            and not font.external
            and not _is_remote_asset(font.file_path)
            and not _is_confined_asset_path(font.file_path)
        )
        if (
            project.background.export_as_lvgl_image
            and project.background.path
            and not _is_remote_asset(project.background.path)
        ):
            local_resources.append(project.background.path)
        if local_resources:
            issues.append(
                {
                    "severity": "error",
                    "message": (
                        "Local image and font files cannot be imported yet - "
                        "use an http(s) URL as the asset source."
                    ),
                }
            )
        return project, issues

    def import_yaml(
        self,
        text: str,
        *,
        canvas: tuple[int, int] | None = None,
        source_name: str = "",
    ) -> dict:
        """Turn an existing ESPHome config into a project payload.

        Read-only in both directions: the source text is parsed, never written
        back, and the result is returned rather than saved - the caller decides
        whether to keep it, using the ordinary project-save endpoint.
        """
        try:
            result = import_esphome_yaml(text, source_name=source_name, canvas_size=canvas)
        except LvglImportError as exc:
            raise ApiError("import_failed", str(exc), 422) from exc

        payload, surface_stats = materialize_surfaces(result.project, result.issues)
        # Run the normal validation too, so the caller gets one issue list and
        # the same failure modes as any other project.
        _project, validation_issues = self.validate(payload)
        issues = [issue.to_dict() for issue in result.issues]
        issues.extend(
            {"severity": i["severity"], "message": i["message"],
             "path": "", "widget_id": i.get("widget") or i.get("resource", "")}
            for i in validation_issues
        )
        blocking = [i for i in issues if i["severity"] in ("A", "error")]
        stats = dict(result.stats)
        stats["widget_count"] = stats.get("widget_count", 0) + surface_stats["surface_widget_count"]
        merged_types = dict(stats.get("widget_types", {}))
        for widget_type, count in surface_stats["surface_widget_types"].items():
            merged_types[widget_type] = merged_types.get(widget_type, 0) + count
        stats["widget_types"] = dict(sorted(merged_types.items()))
        stats.update({
            key: value for key, value in surface_stats.items()
            if key != "surface_widget_types"
        })
        return {
            "project": payload,
            "issues": issues,
            "stats": stats,
            "valid": not blocking,
        }

    def probe_yaml(self, text: str) -> dict:
        try:
            result = import_esphome_yaml(text)
        except LvglImportError as exc:
            raise ApiError("import_failed", str(exc), 422) from exc
        _payload, surface_stats = materialize_surfaces(result.project, result.issues)
        stats = dict(result.stats)
        stats["widget_count"] = stats.get("widget_count", 0) + surface_stats["surface_widget_count"]
        merged_types = dict(stats.get("widget_types", {}))
        for widget_type, count in surface_stats["surface_widget_types"].items():
            merged_types[widget_type] = merged_types.get(widget_type, 0) + count
        stats["widget_types"] = dict(sorted(merged_types.items()))
        stats.update({
            key: value for key, value in surface_stats.items()
            if key not in {"surface_widget_count", "surface_widget_types"}
        })
        return stats

    def export_yaml(self, payload: dict[str, Any]) -> dict:
        normalized_payload, repaired_buttons = _normalise_button_child_text(payload)
        project, issues = self.validate(normalized_payload)
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError("invalid_project", "Project validation failed.", 422, {"issues": issues})
        try:
            with tempfile.TemporaryDirectory(dir=self.export_root) as directory:
                result = export_project(project, str(Path(directory) / "ui.yaml"))
        except ExportError as exc:
            raise ApiError("export_failed", str(exc), 422) from exc
        export_issues = [asdict(issue) for issue in result.issues]
        export_issues.extend({
            "severity": "C",
            "message": (
                "Legacy button text was exported as a child label because "
                "the button contains child widgets."
            ),
            "widget_id": button_id,
        } for button_id in repaired_buttons)
        return {
            "yaml": strip_empty_root_widgets(result.yaml_text, project),
            "issues": export_issues,
        }

    def project_payload(self, project: Project) -> dict[str, Any]:
        """Decorate a stored core project with read-only Viewer surfaces."""
        return materialize_surfaces(project)[0]
