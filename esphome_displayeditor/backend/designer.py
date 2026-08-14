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
from .designer_core.yamlexport import ESPHomeDumper, ExportError, HexColor, export_project
from .designer_core.yamlimport import (
    LvglImportError,
    import_esphome_yaml,
)
from .errors import ApiError
from .msgbox_support import apply_msgbox_payload, materialize_msgboxes
from .page_support import apply_surface_payload, materialize_surfaces, strip_empty_root_widgets

_ID_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_HEX_COLOR_PATTERN = re.compile(r"^(?:0x|#)?([0-9A-Fa-f]{6})$")

register_addon_widgets()


class _ActionLambda(str):
    pass


def _represent_action_lambda(dumper, value):
    return dumper.represent_scalar("!lambda", str(value))


ESPHomeDumper.add_representer(_ActionLambda, _represent_action_lambda)


def _materialize_action_lambdas(payload: dict[str, Any]) -> None:
    def visit(value: Any) -> Any:
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, dict):
            if set(value) == {"__esphome_lambda__"}:
                return _ActionLambda(str(value["__esphome_lambda__"]))
            return {key: visit(item) for key, item in value.items()}
        return value

    converted = visit(payload)
    payload.clear()
    payload.update(converted)


def _normalise_meter_payload(payload: dict[str, Any], *, for_export: bool) -> None:
    """Normalise nested meter scales without changing the shared core."""
    def meter_value(value: Any, key: str = "") -> Any:
        if isinstance(value, list):
            return [meter_value(item) for item in value]
        if isinstance(value, dict):
            return {name: meter_value(item, name) for name, item in value.items()}
        if key == "color" or key.endswith("_color"):
            if for_export and isinstance(value, str):
                match = _HEX_COLOR_PATTERN.fullmatch(value.strip())
                return HexColor(int(match.group(1), 16)) if match else value
            if not for_export and isinstance(value, int) and not isinstance(value, bool):
                return f"{value & 0xFFFFFF:06X}"
            if not for_export and isinstance(value, str):
                match = _HEX_COLOR_PATTERN.fullmatch(value.strip())
                return match.group(1).upper() if match else value
        return value

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        if value.get("widget_type") == "meter" and isinstance(value.get("properties"), dict):
            scales = value["properties"].get("scales")
            if scales is not None:
                value["properties"]["scales"] = meter_value(
                    scales if isinstance(scales, list) else [scales]
                )
        for item in value.values():
            visit(item)

    visit(payload)


def _claim_meter_indicator_ids(
    properties: dict[str, Any], registry: IdRegistry, issues: list[dict], owner: str,
) -> None:
    scales = properties.get("scales")
    if not isinstance(scales, list):
        scales = [scales] if isinstance(scales, dict) else []
    for scale_index, scale in enumerate(scales):
        if not isinstance(scale, dict):
            continue
        for indicator_index, entry in enumerate(scale.get("indicators") or []):
            if not isinstance(entry, dict) or len(entry) != 1:
                continue
            kind, config = next(iter(entry.items()))
            if not isinstance(config, dict) or not config.get("id"):
                continue
            indicator_id = str(config["id"])
            if not _ID_PATTERN.fullmatch(indicator_id):
                issues.append({
                    "severity": "error", "widget": indicator_id,
                    "message": "Invalid ESPHome indicator id.",
                })
            registry.claim(
                indicator_id,
                f"meter indicator at {owner}.scales[{scale_index}].indicators[{indicator_index}].{kind}",
            )


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
        msgboxes = normalized.get("msgboxes")
        if isinstance(msgboxes, list):
            for msgbox in msgboxes:
                if not isinstance(msgbox, dict):
                    continue
                for key in ("buttons", "header_buttons"):
                    if isinstance(msgbox.get(key), list):
                        lists.append(msgbox[key])
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
            project = Project.from_dict(apply_msgbox_payload(apply_surface_payload(payload)))
        except (TypeError, ValueError, KeyError) as exc:
            raise ApiError("invalid_project", "Project data is malformed.") from exc
        if not (1 <= project.canvas_width <= 4096 and 1 <= project.canvas_height <= 4096):
            raise ApiError("invalid_project", "Canvas dimensions must be between 1 and 4096.")

        issues: list[dict] = []
        registry = IdRegistry()
        # Ids used by hardware entities elsewhere in an imported source config
        # (binary_sensor:, button:, switch:, ...) - not modeled here, but they
        # share ESPHome's one flat id() namespace with every widget/style/
        # font/image/color below, so a widget accidentally reusing one must
        # be caught the same way as any other duplicate id.
        for reserved_id in project.reserved_ids:
            registry.claim(reserved_id, "a non-LVGL entity in the source config")
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
                if node.widget_type == "meter":
                    _claim_meter_indicator_ids(node.properties, registry, issues, node_path)
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
                if widget_type == "meter":
                    _claim_meter_indicator_ids(
                        node.get("properties", {}), registry, issues, node_path,
                    )
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

        msgbox_payload, _msgbox_stats = materialize_msgboxes(project)
        for msgbox_index, msgbox in enumerate(msgbox_payload):
            msgbox_id = str(msgbox.get("id", ""))
            if not _ID_PATTERN.fullmatch(msgbox_id):
                issues.append({
                    "severity": "error", "msgbox": msgbox_id,
                    "message": "Invalid ESPHome msgbox id.",
                })
            registry.claim(msgbox_id, f"msgboxes[{msgbox_index}]")
            for key in ("buttons", "header_buttons"):
                visit_surface_widgets(
                    msgbox.get(key, []), parent_path=f"msgboxes[{msgbox_index}].{key}")
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
        # The reference-image background gets its own synthetic image: entry
        # when exported (see build_image_block() in yamlexport.py) - if its
        # id happens to collide with a real image (or anything else), that
        # was never caught here before, so export could silently emit the
        # same id twice: once from project.images, once from this synthetic
        # entry. ESPHome then rejects the whole config with "ID ... redefined!".
        if project.background.export_as_lvgl_image and project.background.path:
            if not _ID_PATTERN.fullmatch(project.background.image_id):
                issues.append({
                    "severity": "error", "resource": project.background.image_id,
                    "message": "Invalid background image id.",
                })
            registry.claim(project.background.image_id, "background image")
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
        payload["msgboxes"], msgbox_stats = materialize_msgboxes(result.project, result.issues)
        _normalise_meter_payload(payload, for_export=False)
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
        stats["widget_count"] = (
            stats.get("widget_count", 0)
            + surface_stats["surface_widget_count"]
            + msgbox_stats["msgbox_widget_count"]
        )
        merged_types = dict(stats.get("widget_types", {}))
        for widget_type, count in surface_stats["surface_widget_types"].items():
            merged_types[widget_type] = merged_types.get(widget_type, 0) + count
        stats["widget_types"] = dict(sorted(merged_types.items()))
        stats.update({
            key: value for key, value in surface_stats.items()
            if key != "surface_widget_types"
        })
        stats.update(msgbox_stats)
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
        _msgboxes, msgbox_stats = materialize_msgboxes(result.project, result.issues)
        stats = dict(result.stats)
        stats["widget_count"] = (
            stats.get("widget_count", 0)
            + surface_stats["surface_widget_count"]
            + msgbox_stats["msgbox_widget_count"]
        )
        merged_types = dict(stats.get("widget_types", {}))
        for widget_type, count in surface_stats["surface_widget_types"].items():
            merged_types[widget_type] = merged_types.get(widget_type, 0) + count
        stats["widget_types"] = dict(sorted(merged_types.items()))
        stats.update({
            key: value for key, value in surface_stats.items()
            if key not in {"surface_widget_count", "surface_widget_types"}
        })
        stats.update(msgbox_stats)
        return stats

    def export_yaml(self, payload: dict[str, Any]) -> dict:
        normalized_payload, repaired_buttons = _normalise_button_child_text(payload)
        _normalise_meter_payload(normalized_payload, for_export=True)
        _materialize_action_lambdas(normalized_payload)
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
        payload = materialize_surfaces(project)[0]
        payload["msgboxes"] = materialize_msgboxes(project)[0]
        return payload
