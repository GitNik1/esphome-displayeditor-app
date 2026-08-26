"""Bounded structured layout previews for machine-driven clients."""

from __future__ import annotations

import hmac
from typing import Any

from ..errors import ApiError
from ..project_store import ProjectStore
from .layout_projection import LayoutProjectionService
from .limits import MCP_TREE_WIDGET_LIMIT


_LAYOUT_KEYS = (
    "type",
    "flex_flow",
    "flex_align_main",
    "flex_align_cross",
    "flex_align_track",
    "grid_rows",
    "grid_columns",
    "grid_cell_x_align",
    "grid_cell_y_align",
)


class LayoutPreviewService:
    """Project one exact revision into a compact placement-oriented view."""

    def __init__(self, projects: ProjectStore) -> None:
        self.projects = projects
        self.projection = LayoutProjectionService()

    def read(
        self,
        name: str,
        project_revision: str,
        surface: str = "root",
    ) -> dict[str, Any]:
        if not project_revision:
            raise ApiError(
                "project_revision_required",
                "An exact project revision is required for a preview.",
                422,
            )
        loaded = self.projects.read(name)
        if not hmac.compare_digest(loaded["revision"], str(project_revision)):
            raise ApiError(
                "revision_conflict",
                "The stored project changed before the preview was generated.",
                409,
                {"current_revision": loaded["revision"]},
            )
        project = loaded["project"]
        roots, surface_layout, surface_style, auto_layout = self._surface(
            project, surface
        )
        boxes = self.projection.compute(
            project,
            roots,
            surface_layout,
            surface_style,
        )
        state = {"count": 0, "truncated": False}
        widgets: list[dict[str, Any]] = []
        self._flatten(
            roots,
            widgets,
            state,
            boxes,
            parent_id="",
            depth=0,
            parent_layout=self._layout_summary(surface_layout),
        )
        canvas = project.get("canvas")
        return {
            "name": name,
            "revision": loaded["revision"],
            "format": "structured_layout_v1",
            "surface": surface,
            "canvas": canvas if isinstance(canvas, dict) else {},
            "surface_layout": self._layout_summary(surface_layout),
            "projection": "layout_js_approximation",
            "auto_layout": auto_layout,
            "widgets": widgets,
            "scanned_count": len(widgets),
            "scan_truncated": bool(state["truncated"]),
        }

    @classmethod
    def _flatten(
        cls,
        nodes: Any,
        result: list[dict[str, Any]],
        state: dict[str, Any],
        boxes: dict[int, dict[str, Any]],
        *,
        parent_id: str,
        depth: int,
        parent_layout: dict[str, Any],
    ) -> None:
        if not isinstance(nodes, list):
            return
        for index, widget in enumerate(nodes):
            if not isinstance(widget, dict):
                continue
            if state["count"] >= MCP_TREE_WIDGET_LIMIT:
                state["truncated"] = True
                return
            state["count"] += 1
            widget_id = str(widget.get("id", ""))
            layout = cls._layout_summary(widget.get("layout"))
            result.append(
                {
                    "id": widget_id,
                    "widget_type": str(widget.get("widget_type", "")),
                    "parent_id": parent_id,
                    "depth": depth,
                    "index": index,
                    "x": widget.get("x"),
                    "y": widget.get("y"),
                    "width": widget.get("width"),
                    "height": widget.get("height"),
                    "align": widget.get("align", "TOP_LEFT"),
                    "align_to": widget.get("align_to", ""),
                    "grid_cell": cls._grid_cell_summary(widget.get("grid_cell")),
                    "parent_layout_type": parent_layout.get("type", "NONE"),
                    "layout": layout,
                    "resolved": boxes.get(id(widget)),
                    "hidden": bool(widget.get("hidden", False)),
                    "locked": bool(widget.get("locked", False)),
                    "child_count": len(widget.get("children", []))
                    if isinstance(widget.get("children"), list)
                    else 0,
                }
            )
            cls._flatten(
                widget.get("children"),
                result,
                state,
                boxes,
                parent_id=widget_id,
                depth=depth + 1,
                parent_layout=layout,
            )
            if state["truncated"]:
                return

    @staticmethod
    def _layout_summary(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return {"type": "NONE"}
        result = {key: raw[key] for key in _LAYOUT_KEYS if key in raw}
        result["type"] = str(result.get("type", "NONE")).upper()
        for key in ("grid_rows", "grid_columns"):
            tracks = result.get(key)
            if isinstance(tracks, list) and len(tracks) > 32:
                result[key] = tracks[:32]
                result[f"{key}_truncated"] = True
        return result

    @staticmethod
    def _grid_cell_summary(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return {}
        return {
            key: raw[key]
            for key in (
                "row_pos",
                "column_pos",
                "row_span",
                "column_span",
                "x_align",
                "y_align",
            )
            if key in raw
        }

    @staticmethod
    def _surface(
        project: dict[str, Any], surface: str
    ) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], bool]:
        if not surface or len(surface) > 180:
            raise ApiError("surface_not_found", "The preview surface is invalid.", 404)
        if surface == "root":
            extra = project.get("extra_lvgl")
            style = extra if isinstance(extra, dict) else {}
            return project.get("widgets", []), style.get("layout", {}), style, False
        if surface.startswith("page:"):
            page_id = surface.split(":", 1)[1]
            pages = project.get("pages")
            entries = pages if isinstance(pages, list) else []
            page = next(
                (
                    item
                    for item in entries
                    if isinstance(item, dict)
                    if item.get("id") == page_id
                ),
                None,
            )
            if page is not None:
                return LayoutPreviewService._surface_payload(project, page, False)
        if surface in {"top", "bottom"}:
            layer = project.get(f"{surface}_layer")
            if isinstance(layer, dict):
                return LayoutPreviewService._surface_payload(project, layer, False)
        if surface.startswith("msgbox:"):
            parts = surface.split(":")
            if len(parts) == 3 and parts[2] in {"buttons", "header_buttons"}:
                msgboxes = project.get("msgboxes")
                entries = msgboxes if isinstance(msgboxes, list) else []
                msgbox = next(
                    (
                        item
                        for item in entries
                        if isinstance(item, dict)
                        if item.get("id") == parts[1]
                    ),
                    None,
                )
                if msgbox is not None:
                    extra = project.get("extra_lvgl")
                    style = dict(extra) if isinstance(extra, dict) else {}
                    style["layout"] = {}
                    return msgbox.get(parts[2], []), {}, style, True
        raise ApiError(
            "surface_not_found",
            f"Preview surface '{surface}' was not found.",
            404,
        )

    @staticmethod
    def _surface_payload(
        project: dict[str, Any],
        surface: dict[str, Any],
        auto_layout: bool,
    ) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], bool]:
        extra = project.get("extra_lvgl")
        style = dict(extra) if isinstance(extra, dict) else {}
        surface_style = surface.get("style_tree")
        if isinstance(surface_style, dict):
            style.update(surface_style)
        layout = surface.get("layout") if isinstance(surface.get("layout"), dict) else {}
        style["layout"] = layout
        widgets = surface.get("widgets")
        return widgets if isinstance(widgets, list) else [], layout, style, auto_layout
