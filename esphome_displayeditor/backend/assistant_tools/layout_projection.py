"""Python counterpart of the browser's deterministic layout approximation."""

from __future__ import annotations

import re
from typing import Any

from .layout_projection_values import LayoutProjectionValuesMixin


_ALIGN_ANCHORS = {
    "TOP_LEFT": (0.0, 0.0),
    "TOP_MID": (0.5, 0.0),
    "TOP_RIGHT": (1.0, 0.0),
    "LEFT_MID": (0.0, 0.5),
    "CENTER": (0.5, 0.5),
    "RIGHT_MID": (1.0, 0.5),
    "BOTTOM_LEFT": (0.0, 1.0),
    "BOTTOM_MID": (0.5, 1.0),
    "BOTTOM_RIGHT": (1.0, 1.0),
}
_OUT_ANCHORS = {
    "OUT_TOP_LEFT": (0.0, -1.0, 0.0, 0.0),
    "OUT_TOP_MID": (0.5, -1.0, 0.5, 0.0),
    "OUT_TOP_RIGHT": (1.0, -1.0, 1.0, 0.0),
    "OUT_BOTTOM_LEFT": (0.0, 1.0, 0.0, 1.0),
    "OUT_BOTTOM_MID": (0.5, 1.0, 0.5, 1.0),
    "OUT_BOTTOM_RIGHT": (1.0, 1.0, 1.0, 1.0),
    "OUT_LEFT_TOP": (-1.0, 0.0, 0.0, 0.0),
    "OUT_LEFT_MID": (-1.0, 0.5, 0.0, 0.5),
    "OUT_LEFT_BOTTOM": (-1.0, 1.0, 0.0, 1.0),
    "OUT_RIGHT_TOP": (1.0, 0.0, 1.0, 0.0),
    "OUT_RIGHT_MID": (1.0, 0.5, 1.0, 0.5),
    "OUT_RIGHT_BOTTOM": (1.0, 1.0, 1.0, 1.0),
}
class LayoutProjectionService(LayoutProjectionValuesMixin):
    """Resolve widget boxes using the same approximation as ``layout.js``."""

    def compute(
        self,
        project: dict[str, Any],
        roots: list[dict[str, Any]],
        surface_layout: dict[str, Any],
        surface_style: dict[str, Any],
    ) -> dict[int, dict[str, Any]]:
        boxes: dict[int, dict[str, Any]] = {}
        cache: dict[int, tuple[float, float]] = {}
        padding = self._padding(surface_style)
        canvas = project.get("canvas") if isinstance(project.get("canvas"), dict) else {}
        width = self._number(canvas.get("width"))
        height = self._number(canvas.get("height"))
        area = {
            "x": padding["left"],
            "y": padding["top"],
            "width": max(0.0, width - padding["left"] - padding["right"]),
            "height": max(0.0, height - padding["top"] - padding["bottom"]),
        }
        self._place_children(
            project,
            roots,
            surface_layout,
            surface_style,
            area,
            boxes,
            cache,
        )
        self._descend(project, roots, boxes, cache)
        return boxes

    def _descend(
        self,
        project: dict[str, Any],
        nodes: list[dict[str, Any]],
        boxes: dict[int, dict[str, Any]],
        cache: dict[int, tuple[float, float]],
    ) -> None:
        for node in nodes:
            outer = boxes.get(id(node))
            children = node.get("children")
            if outer is None or not isinstance(children, list) or not children:
                continue
            style = self._style(project, node)
            padding = self._padding(style)
            area = {
                "x": outer["left"] + padding["left"],
                "y": outer["top"] + padding["top"],
                "width": max(
                    0.0,
                    outer["width"] - padding["left"] - padding["right"],
                ),
                "height": max(
                    0.0,
                    outer["height"] - padding["top"] - padding["bottom"],
                ),
            }
            layout = node.get("layout") if isinstance(node.get("layout"), dict) else {}
            self._place_children(
                project,
                children,
                layout,
                style,
                area,
                boxes,
                cache,
            )
            self._descend(project, children, boxes, cache)

    def _place_children(
        self,
        project: dict[str, Any],
        children: list[dict[str, Any]],
        layout: dict[str, Any],
        style: dict[str, Any],
        area: dict[str, float],
        boxes: dict[int, dict[str, Any]],
        cache: dict[int, tuple[float, float]],
    ) -> None:
        layout_type = str(layout.get("type", "NONE")).upper()
        if layout_type == "GRID":
            self._place_grid(project, children, layout, style, area, boxes, cache)
        elif layout_type == "FLEX":
            self._place_flex(project, children, layout, style, area, boxes, cache)
        else:
            self._place_absolute(project, children, area, boxes, cache)

    def _place_absolute(
        self,
        project: dict[str, Any],
        children: list[dict[str, Any]],
        area: dict[str, float],
        boxes: dict[int, dict[str, Any]],
        cache: dict[int, tuple[float, float]],
    ) -> None:
        pending: list[tuple[dict[str, Any], float, float, str]] = []
        for child in children:
            intrinsic = self._intrinsic(project, child, cache)
            width = self._resolve_size(child.get("width"), area["width"], intrinsic[0], intrinsic[0])
            height = self._resolve_size(child.get("height"), area["height"], intrinsic[1], intrinsic[1])
            align = str(child.get("align", "TOP_LEFT")).upper()
            if align.startswith("OUT_") and child.get("align_to"):
                pending.append((child, width, height, align))
                continue
            anchor_x, anchor_y = _ALIGN_ANCHORS.get(align, (0.0, 0.0))
            boxes[id(child)] = self._box(
                area["x"] + (area["width"] - width) * anchor_x + self._number(child.get("x")),
                area["y"] + (area["height"] - height) * anchor_y + self._number(child.get("y")),
                width,
                height,
                False,
                area["x"],
                area["y"],
            )
        for child, width, height, align in pending:
            target = next(
                (item for item in children if item.get("id") == child.get("align_to")),
                None,
            )
            anchor = boxes.get(id(target)) if target is not None else None
            base = anchor or {
                "left": area["x"],
                "top": area["y"],
                "width": area["width"],
                "height": area["height"],
            }
            target_x, target_y, self_x, self_y = _OUT_ANCHORS.get(
                align, (0.0, 0.0, 0.0, 0.0)
            )
            left = (
                base["left"]
                + base["width"] * max(0.0, target_x)
                + (-width if target_x < 0 else 0.0)
                - width * self_x * (1.0 if target_x == 0 else 0.0)
                + self._number(child.get("x"))
            )
            top = (
                base["top"]
                + base["height"] * max(0.0, target_y)
                + (-height if target_y < 0 else 0.0)
                - height * self_y * (1.0 if target_y == 0 else 0.0)
                + self._number(child.get("y"))
            )
            boxes[id(child)] = self._box(
                left,
                top,
                width,
                height,
                False,
                area["x"],
                area["y"],
            )

    def _place_grid(
        self,
        project: dict[str, Any],
        children: list[dict[str, Any]],
        layout: dict[str, Any],
        style: dict[str, Any],
        area: dict[str, float],
        boxes: dict[int, dict[str, Any]],
        cache: dict[int, tuple[float, float]],
    ) -> None:
        gap_x = self._number(style.get("pad_column", layout.get("pad_column")))
        gap_y = self._number(style.get("pad_row", layout.get("pad_row")))
        column_specs = layout.get("grid_columns", ["FR(1)"])
        row_specs = layout.get("grid_rows", ["FR(1)"])
        columns_raw = column_specs if isinstance(column_specs, list) else [column_specs]
        rows_raw = row_specs if isinstance(row_specs, list) else [row_specs]
        content_widths = [0.0 for _ in columns_raw]
        content_heights = [0.0 for _ in rows_raw]
        for child in children:
            cell = child.get("grid_cell") if isinstance(child.get("grid_cell"), dict) else {}
            intrinsic = self._intrinsic(project, child, cache)
            column = int(cell.get("column_pos", 0))
            row = int(cell.get("row_pos", 0))
            if int(cell.get("column_span", 1)) == 1 and 0 <= column < len(content_widths):
                content_widths[column] = max(content_widths[column], intrinsic[0])
            if int(cell.get("row_span", 1)) == 1 and 0 <= row < len(content_heights):
                content_heights[row] = max(content_heights[row], intrinsic[1])
        columns = self._track_sizes(columns_raw, area["width"], gap_x, content_widths)
        rows = self._track_sizes(rows_raw, area["height"], gap_y, content_heights)
        column_offsets = self._track_offsets(columns, gap_x)
        row_offsets = self._track_offsets(rows, gap_y)
        if not columns or not rows:
            return
        for child in children:
            cell = child.get("grid_cell") if isinstance(child.get("grid_cell"), dict) else {}
            column = min(int(cell.get("column_pos", 0)), len(columns) - 1)
            row = min(int(cell.get("row_pos", 0)), len(rows) - 1)
            column_span = max(1, int(cell.get("column_span", 1)))
            row_span = max(1, int(cell.get("row_span", 1)))
            cell_width = sum(columns[column : column + column_span]) + gap_x * max(
                0, min(column_span, len(columns) - column) - 1
            )
            cell_height = sum(rows[row : row + row_span]) + gap_y * max(
                0, min(row_span, len(rows) - row) - 1
            )
            intrinsic = self._intrinsic(project, child, cache)
            x_align = str(cell.get("x_align", layout.get("grid_cell_x_align", "START"))).upper()
            y_align = str(cell.get("y_align", layout.get("grid_cell_y_align", "START"))).upper()
            width = self._resolve_size(
                child.get("width"), cell_width, intrinsic[0], cell_width if x_align == "STRETCH" else intrinsic[0]
            )
            height = self._resolve_size(
                child.get("height"), cell_height, intrinsic[1], cell_height if y_align == "STRETCH" else intrinsic[1]
            )
            cell_x = area["x"] + column_offsets[column]
            cell_y = area["y"] + row_offsets[row]
            boxes[id(child)] = self._box(
                cell_x + self._align_offset(x_align, cell_width, width) + self._number(child.get("x")),
                cell_y + self._align_offset(y_align, cell_height, height) + self._number(child.get("y")),
                width,
                height,
                True,
                cell_x,
                cell_y,
            )

    def _place_flex(
        self,
        project: dict[str, Any],
        children: list[dict[str, Any]],
        layout: dict[str, Any],
        style: dict[str, Any],
        area: dict[str, float],
        boxes: dict[int, dict[str, Any]],
        cache: dict[int, tuple[float, float]],
    ) -> None:
        flow = str(layout.get("flex_flow", "ROW")).upper()
        horizontal = flow.startswith("ROW")
        reverse = "REVERSE" in flow
        wrap = "WRAP" in flow
        gap_main = self._number(style.get("pad_column" if horizontal else "pad_row"))
        gap_cross = self._number(style.get("pad_row" if horizontal else "pad_column"))
        main_extent = area["width"] if horizontal else area["height"]
        cross_extent = area["height"] if horizontal else area["width"]
        items = []
        for child in children:
            intrinsic = self._intrinsic(project, child, cache)
            width = self._resolve_size(child.get("width"), area["width"], intrinsic[0], intrinsic[0])
            height = self._resolve_size(child.get("height"), area["height"], intrinsic[1], intrinsic[1])
            main = width if horizontal else height
            cross = height if horizontal else width
            style_tree = child.get("style_tree") if isinstance(child.get("style_tree"), dict) else {}
            items.append(
                {
                    "child": child,
                    "main": main,
                    "cross": cross,
                    "grow": self._number(style_tree.get("flex_grow")),
                }
            )
        if reverse:
            items.reverse()
        tracks: list[dict[str, Any]] = []
        current: list[dict[str, Any]] = []
        used = 0.0
        for item in items:
            if wrap and current and used + gap_main + item["main"] > main_extent:
                tracks.append({"items": current, "used": used})
                current = []
                used = 0.0
            used += (gap_main if current else 0.0) + item["main"]
            current.append(item)
        if current:
            tracks.append({"items": current, "used": used})
        track_cross = [max((item["cross"] for item in track["items"]), default=0.0) for track in tracks]
        total_cross = sum(track_cross) + gap_cross * max(0, len(tracks) - 1)
        cross_cursor = self._distribution_start(layout.get("flex_align_track"), cross_extent, total_cross)
        for track_index, track in enumerate(tracks):
            grow = sum(item["grow"] for item in track["items"])
            free = max(0.0, main_extent - track["used"])
            if grow > 0:
                for item in track["items"]:
                    item["main"] += free * item["grow"] / grow
                track["used"] = main_extent
            start, gap = self._distribution(
                layout.get("flex_align_main"),
                len(track["items"]),
                main_extent,
                track["used"],
                gap_main,
            )
            main_cursor = start
            for item in track["items"]:
                cross_align = str(layout.get("flex_align_cross", "START")).upper()
                cross_size = track_cross[track_index] if cross_align == "STRETCH" else item["cross"]
                cross_offset = cross_cursor + self._align_offset(
                    cross_align, track_cross[track_index], cross_size
                )
                left = area["x"] + (main_cursor if horizontal else cross_offset)
                top = area["y"] + (cross_offset if horizontal else main_cursor)
                width = item["main"] if horizontal else cross_size
                height = cross_size if horizontal else item["main"]
                child = item["child"]
                boxes[id(child)] = self._box(
                    left + self._number(child.get("x")),
                    top + self._number(child.get("y")),
                    width,
                    height,
                    True,
                    left,
                    top,
                )
                main_cursor += item["main"] + gap
            cross_cursor += track_cross[track_index] + gap_cross

    def _intrinsic(
        self,
        project: dict[str, Any],
        widget: dict[str, Any],
        cache: dict[int, tuple[float, float]],
    ) -> tuple[float, float]:
        cached = cache.get(id(widget))
        if cached is not None:
            return cached
        if widget.get("widget_type") in {"image", "animimg"}:
            properties = widget.get("properties") if isinstance(widget.get("properties"), dict) else {}
            source = properties.get("src")
            source_id = source[0] if isinstance(source, list) and source else source
            image = next(
                (
                    item
                    for item in project.get("images", [])
                    if isinstance(item, dict) and item.get("id") == source_id
                ),
                None,
            )
            resize = re.fullmatch(r"(\d+)\s*x\s*(\d+)", str(image.get("resize", ""))) if image else None
            size = (float(resize.group(1)), float(resize.group(2))) if resize else (100.0, 40.0)
        else:
            size = (100.0, 40.0)
        cache[id(widget)] = size
        return size
