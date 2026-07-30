"""Validation and export facade around the desktop designer's core model."""

from __future__ import annotations

import re
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .designer_core.idgen import IdRegistry
from .designer_core.model import PROJECT_FORMAT, PROJECT_FORMAT_VERSION, Project
from .designer_core.widgetschema import WIDGET_SCHEMAS
from .designer_core.yamlexport import ExportError, export_project
from .errors import ApiError

_ID_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


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
            project = Project.from_dict(payload)
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

        # Local resource import is deliberately disabled until uploads can be
        # confined to a dedicated asset store. This prevents arbitrary file reads.
        local_resources = [image.file_path for image in project.images if image.file_path]
        local_resources.extend(
            font.file_path for font in project.fonts if font.source_kind == "file" and font.file_path
        )
        if project.background.export_as_lvgl_image and project.background.path:
            local_resources.append(project.background.path)
        if local_resources:
            issues.append(
                {
                    "severity": "error",
                    "message": "Local image and font assets are not enabled in this milestone.",
                }
            )
        return project, issues

    def export_yaml(self, payload: dict[str, Any]) -> dict:
        project, issues = self.validate(payload)
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError("invalid_project", "Project validation failed.", 422, {"issues": issues})
        try:
            with tempfile.TemporaryDirectory(dir=self.export_root) as directory:
                result = export_project(project, str(Path(directory) / "ui.yaml"))
        except ExportError as exc:
            raise ApiError("export_failed", str(exc), 422) from exc
        return {
            "yaml": result.yaml_text,
            "issues": [asdict(issue) for issue in result.issues],
        }
