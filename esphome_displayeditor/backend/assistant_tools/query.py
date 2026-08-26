"""Compact, paginated read-only projections used by AssistantToolService.

Split out of service.py to keep that facade under the project's backend
module line limit; every method here is read-only and side-effect-free. The
heavier projections (binding discovery, YAML transforms/completions, project
tree/summary) are further split into sibling modules for the same reason -
this class stays the single entry point client code calls into.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..designer import DesignerService
from ..errors import ApiError
from ..filesystem import FilesystemBackend
from ..project_store import ProjectStore
from ..runtime.registry import DeviceRegistry
from ..viewer_bindings import ViewerBindingStore
from . import query_bindings, query_project_tree, query_yaml
from .device_discovery import DeviceDiscoveryService
from .limits import (
    MCP_CONFIGURATION_CHUNK_CHARACTERS,
    MCP_DEVICE_SCAN_LIMIT,
    MCP_PAGE_SIZE_LIMIT,
)
from .pagination import CursorCodec, cursor_fingerprint
from .preview import LayoutPreviewService
from .secrets_guard import assert_not_secrets_file


class QueryService:
    """Bounded, cursor-paginated read projections over the domain services."""

    def __init__(
        self,
        *,
        designer: DesignerService,
        projects: ProjectStore,
        filesystem: FilesystemBackend,
        viewer_bindings: ViewerBindingStore,
        device_registry: DeviceRegistry,
        device_discovery: DeviceDiscoveryService,
        layout_previews: LayoutPreviewService,
        cursors: CursorCodec,
    ) -> None:
        self.designer = designer
        self.projects = projects
        self.filesystem = filesystem
        self.viewer_bindings = viewer_bindings
        self.device_registry = device_registry
        self.device_discovery = device_discovery
        self.layout_previews = layout_previews
        self.cursors = cursors

    def list_projects(self, limit: int = 50, cursor: str = "") -> dict[str, Any]:
        projects = self.projects.list()
        fingerprint = cursor_fingerprint(
            [(item["name"], item["revision"]) for item in projects]
        )
        page, next_cursor = self._page(
            projects,
            limit,
            cursor,
            scope="projects",
            fingerprint=fingerprint,
        )
        return {
            "projects": page,
            "count": len(projects),
            "returned": len(page),
            "truncated": next_cursor is not None,
            "next_cursor": next_cursor,
        }

    def preview_project(
        self,
        name: str,
        project_revision: str,
        surface: str = "root",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        preview = self.layout_previews.read(name, project_revision, surface)
        widgets = preview.pop("widgets")
        fingerprint = cursor_fingerprint(
            {
                "revision": preview["revision"],
                "surface": surface,
                "widgets": [item["id"] for item in widgets],
                "scan_truncated": preview["scan_truncated"],
            }
        )
        page, next_cursor = self._page(
            widgets,
            limit,
            cursor,
            scope=f"preview:{name}:{surface}",
            fingerprint=fingerprint,
        )
        return {
            **preview,
            "widgets": page,
            "returned": len(page),
            "truncated": preview["scan_truncated"] or next_cursor is not None,
            "next_cursor": next_cursor,
        }

    def list_devices(self, limit: int = 50, cursor: str = "") -> dict[str, Any]:
        devices = self.device_discovery.list()
        matching_count = len(devices)
        scan_truncated = matching_count > MCP_DEVICE_SCAN_LIMIT
        devices = devices[:MCP_DEVICE_SCAN_LIMIT]
        fingerprint = cursor_fingerprint(
            {
                "matching_count": matching_count,
                "devices": [
                    (item["id"], item["name"], item["host"], item["port"])
                    for item in devices
                ],
            }
        )
        page, next_cursor = self._page(
            devices,
            limit,
            cursor,
            scope="devices",
            fingerprint=fingerprint,
        )
        return {
            "devices": page,
            "count": matching_count,
            "scanned_count": len(devices),
            "returned": len(page),
            "truncated": scan_truncated or next_cursor is not None,
            "scan_truncated": scan_truncated,
            "next_cursor": next_cursor,
            "live_data_available": False,
        }

    def read_device(self, device_id: str) -> dict[str, Any]:
        return {
            "device": self.device_discovery.read(device_id),
            "live_data_available": False,
        }

    def list_configurations(
        self, limit: int = 50, cursor: str = ""
    ) -> dict[str, Any]:
        configurations = self.filesystem.list_configs()
        fingerprint = cursor_fingerprint(
            [(item.get("name"), item.get("revision")) for item in configurations]
        )
        page, next_cursor = self._page(
            configurations,
            limit,
            cursor,
            scope="configurations",
            fingerprint=fingerprint,
        )
        return {
            "configurations": page,
            "count": len(configurations),
            "returned": len(page),
            "truncated": next_cursor is not None,
            "next_cursor": next_cursor,
        }

    def read_configuration(
        self,
        name: str,
        offset: int = 0,
        max_characters: int = MCP_CONFIGURATION_CHUNK_CHARACTERS,
        source: str = "active",
    ) -> dict[str, Any]:
        assert_not_secrets_file(name)
        if source == "active":
            loaded = self.filesystem.read_config(name)
        elif source == "draft":
            loaded = self.filesystem.read_draft(name)
        else:
            raise ApiError(
                "invalid_configuration_source",
                "Configuration source must be active or draft.",
                422,
            )
        safe_offset = max(int(offset), 0)
        safe_limit = min(
            max(int(max_characters), 1), MCP_CONFIGURATION_CHUNK_CHARACTERS
        )
        content = loaded.pop("content")
        if safe_offset > len(content):
            raise ApiError(
                "invalid_configuration_offset",
                "The requested offset exceeds the configuration length.",
                422,
                {"total_characters": len(content)},
            )
        return {
            **loaded,
            "source": source,
            **self._text_segment(content, safe_offset, safe_limit),
        }

    def binding_targets(
        self,
        name: str,
        target: str = "widgets",
        direction: str = "entity_to_widget",
        entity_domain: str = "",
        entity_id: str = "",
        widget_id: str = "",
        query: str = "",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        return query_bindings.binding_targets(
            self,
            name,
            target,
            direction,
            entity_domain,
            entity_id,
            widget_id,
            query,
            limit,
            cursor,
        )

    def transform_yaml(
        self,
        name: str,
        project_revision: str,
        mode: str = "export",
        configuration_name: str = "",
        configuration_revision: str = "",
        offset: int = 0,
        max_characters: int = MCP_CONFIGURATION_CHUNK_CHARACTERS,
    ) -> dict[str, Any]:
        return query_yaml.transform_yaml(
            self,
            name,
            project_revision,
            mode,
            configuration_name,
            configuration_revision,
            offset,
            max_characters,
        )

    def complete_argument(
        self,
        argument_name: str,
        partial: str = "",
        context: dict[str, str] | None = None,
        *,
        resource_reference: str = "",
    ) -> dict[str, Any]:
        return query_yaml.complete_argument(
            self,
            argument_name,
            partial,
            context,
            resource_reference=resource_reference,
        )

    def catalog(
        self,
        kind: str = "widgets",
        language: str = "de",
        widget_type: str = "",
    ) -> dict[str, Any]:
        schemas = self.designer.schemas(language)
        if kind == "bindings":
            return {
                "kind": "bindings",
                "project_format": schemas["project_format"],
                "bindings": schemas["bindings"],
            }
        if kind != "widgets":
            raise ApiError(
                "invalid_catalog_kind",
                "Catalog kind must be 'widgets' or 'bindings'.",
            )

        widgets = schemas["widgets"]
        if widget_type:
            match = next(
                (entry for entry in widgets if entry["type_key"] == widget_type),
                None,
            )
            if match is None:
                raise ApiError(
                    "unknown_widget_type",
                    f"Widget type '{widget_type}' is not supported.",
                    404,
                )
            return {
                "kind": "widget",
                "project_format": schemas["project_format"],
                "project_format_version": schemas["project_format_version"],
                "widget": match,
                "grid_cell_properties": schemas["grid_cell_properties"],
                "states": schemas["states"],
            }

        return {
            "kind": "widgets",
            "project_format": schemas["project_format"],
            "project_format_version": schemas["project_format_version"],
            "widgets": [self._widget_schema_summary(entry) for entry in widgets],
        }

    def read_project(
        self,
        name: str,
        view: str = "summary",
        widget_id: str = "",
    ) -> dict[str, Any]:
        loaded = self.projects.read(name)
        project = loaded["project"]
        common = {
            "name": name,
            "revision": loaded["revision"],
            "issues": loaded["issues"],
        }
        if view == "summary":
            return {
                **common,
                "summary": query_project_tree.project_summary(project, loaded["issues"]),
            }
        if view == "tree":
            tree, truncated = query_project_tree.project_tree(project)
            return {**common, "tree": tree, "truncated": truncated}
        if view == "bindings":
            return {
                **common,
                "entities": project.get("entities", []),
                "bindings": project.get("bindings", []),
            }
        if view == "viewer_bindings":
            viewer = self.viewer_bindings.read(name)
            return {
                **common,
                "viewer_binding_revision": viewer["revision"],
                "viewer_bindings": viewer["bindings"],
            }
        if view == "widget":
            if not widget_id:
                raise ApiError(
                    "widget_id_required",
                    "widget_id is required when view is 'widget'.",
                )
            widget = query_project_tree.find_widget(project, widget_id)
            if widget is None:
                raise ApiError(
                    "widget_not_found",
                    f"Widget '{widget_id}' was not found in project '{name}'.",
                    404,
                )
            return {**common, "widget": widget}
        raise ApiError(
            "invalid_project_view",
            "Project view must be summary, tree, bindings, viewer_bindings or widget.",
        )

    def validate_project(self, name: str) -> dict[str, Any]:
        loaded = self.projects.read(name)
        issues = loaded["issues"]
        counts = Counter(str(issue.get("severity", "unknown")) for issue in issues)
        return {
            "name": name,
            "revision": loaded["revision"],
            "valid": counts.get("error", 0) == 0,
            "issue_counts": dict(counts),
            "issues": issues,
        }

    def _page(
        self,
        items: list[dict[str, Any]],
        limit: int,
        cursor: str,
        *,
        scope: str,
        fingerprint: str,
    ) -> tuple[list[dict[str, Any]], str | None]:
        safe_limit = min(max(int(limit), 1), MCP_PAGE_SIZE_LIMIT)
        offset = self.cursors.decode(
            cursor,
            scope=scope,
            fingerprint=fingerprint,
        )
        if offset > len(items):
            raise ApiError("invalid_cursor", "The pagination cursor is invalid.", 422)
        end = min(offset + safe_limit, len(items))
        next_cursor = (
            self.cursors.encode(
                scope=scope,
                offset=end,
                fingerprint=fingerprint,
            )
            if end < len(items)
            else None
        )
        return items[offset:end], next_cursor

    @staticmethod
    def _text_segment(
        content: str,
        offset: int,
        max_characters: int,
    ) -> dict[str, Any]:
        safe_offset = max(int(offset), 0)
        safe_limit = min(
            max(int(max_characters), 1), MCP_CONFIGURATION_CHUNK_CHARACTERS
        )
        if safe_offset > len(content):
            raise ApiError(
                "invalid_content_offset",
                "The requested offset exceeds the content length.",
                422,
                {"total_characters": len(content)},
            )
        end = min(safe_offset + safe_limit, len(content))
        return {
            "content": content[safe_offset:end],
            "offset": safe_offset,
            "next_offset": end if end < len(content) else None,
            "total_characters": len(content),
            "truncated": end < len(content),
        }

    @staticmethod
    def _widget_schema_summary(entry: dict[str, Any]) -> dict[str, Any]:
        return {
            key: entry.get(key)
            for key in (
                "type_key",
                "label",
                "category",
                "default_size",
                "is_stub",
                "child_role",
            )
            if key in entry
        } | {"property_count": len(entry.get("properties", []))}
