"""Strict semantic widget placement over normalized designer projects."""

from __future__ import annotations

import copy
import math
import re
from typing import Any

from ..designer_core.widgetschema import (
    CONTENT,
    LAYOUT,
    STYLE,
    WIDGET_SCHEMAS,
    PropertyDef,
)
from ..errors import ApiError
from .limits import MCP_OPERATION_TEXT_LENGTH
from .operations import PlacementOperation, operation_payload
from .placement_topology import PlacementTopologyMixin, WidgetLocation

_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PERCENT = re.compile(r"^-?(?:\d+(?:\.\d+)?|\.\d+)%$")
_TRACK = re.compile(r"^(?:\d+(?:\.\d+)?|FR\(\d+(?:\.\d+)?\)|CONTENT)$", re.I)


class PlacementService(PlacementTopologyMixin):
    def apply(
        self,
        project: dict[str, Any],
        operations: list[PlacementOperation | dict[str, Any]],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        proposed = copy.deepcopy(project)
        results = []
        for index, raw in enumerate(operations):
            operation = operation_payload(raw)
            kind = operation.get("op")
            if kind == "add_widget":
                result = self._add(proposed, operation)
            elif kind == "update_widget":
                result = self._update(proposed, operation)
            elif kind == "place_widget":
                result = self._place(proposed, operation)
            else:
                raise ApiError(
                    "unsupported_operation",
                    f"Operation {index} has an unsupported type.",
                    422,
                )
            results.append({"operation_index": index, "op": kind, **result})
        self._validate_alignment_graph(proposed)
        return proposed, {
            "operation_count": len(results),
            "operations": results,
        }

    def _add(self, project: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
        widget_id = operation["widget_id"]
        if widget_id in self._used_ids(project):
            raise ApiError(
                "duplicate_id",
                f"The id '{widget_id}' is already used in the project.",
                409,
            )
        schema = WIDGET_SCHEMAS.get(operation["widget_type"])
        if schema is None:
            raise ApiError("unknown_widget_type", "The widget type is not supported.", 422)

        destination = self._destination(
            project,
            operation.get("surface", "root"),
            operation.get("parent_id", ""),
        )
        self._validate_child(destination, schema.type_key)
        properties = {
            prop.key: copy.deepcopy(prop.default)
            for prop in schema.properties
            if prop.category == CONTENT and prop.default is not None
        }
        self._patch_values(
            properties,
            operation.get("properties", {}),
            self._property_map(schema.type_key, CONTENT),
            "properties",
        )
        style: dict[str, Any] = {}
        self._patch_values(
            style,
            operation.get("style", {}),
            self._property_map(schema.type_key, STYLE),
            "style",
        )
        layout: dict[str, Any] = {}
        self._patch_values(
            layout,
            operation.get("layout", {}),
            self._property_map(schema.type_key, LAYOUT),
            "layout",
        )
        self._normalise_layout(layout)
        widget = {
            "id": widget_id,
            "widget_type": schema.type_key,
            "name": "",
            "x": 0,
            "y": 0,
            "width": schema.default_size[0],
            "height": schema.default_size[1],
            "align": "TOP_LEFT",
            "align_to": "",
            "hidden": False,
            "locked": False,
            "properties": properties,
            "style_mode": "inline",
            "style_refs": [],
            "style_tree": style,
            "events": {},
            "children": [],
            "tab_title": "",
            "tile_row": 0,
            "tile_col": 0,
            "tile_dir": "ALL",
            "layout": layout,
            "grid_cell": {},
            "extra": {},
            "source": "editor",
            "synthetic_id": False,
        }
        self._apply_placement(project, widget, destination, operation.get("placement", {}))
        inserted = self._insert(destination.nodes, widget, operation.get("index"))
        return {
            "widget_id": widget_id,
            "surface": destination.surface,
            "parent_id": destination.parent.get("id", "") if destination.parent else "",
            "index": inserted,
        }

    def _update(self, project: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
        location = self._require_widget(project, operation["widget_id"])
        widget = location.widget
        if widget.get("locked"):
            raise ApiError("widget_locked", "The selected widget is locked.", 409)
        changed: list[str] = []
        for key in ("name", "hidden", "locked"):
            if key in operation:
                widget[key] = operation[key]
                changed.append(key)
        widget_type = str(widget.get("widget_type", ""))
        for operation_key, target_key, category in (
            ("properties", "properties", CONTENT),
            ("style", "style_tree", STYLE),
            ("layout", "layout", LAYOUT),
        ):
            if operation_key not in operation:
                continue
            if not operation[operation_key]:
                continue
            target = widget.setdefault(target_key, {})
            self._patch_values(
                target,
                operation[operation_key],
                self._property_map(widget_type, category),
                operation_key,
            )
            if target_key == "layout":
                self._normalise_layout(target)
                self._normalise_children(widget)
            changed.append(operation_key)
        if "placement" in operation:
            self._apply_placement(project, widget, location, operation["placement"])
            changed.append("placement")
        if (
            widget_type == "button"
            and widget.get("children")
            and "text" in widget.get("properties", {})
        ):
            raise ApiError(
                "button_text_children_conflict",
                "A button with child widgets cannot also use the text shorthand.",
                422,
            )
        if not changed:
            raise ApiError("empty_operation", "The update operation changes no fields.", 422)
        return {
            "widget_id": operation["widget_id"],
            "surface": location.surface,
            "changed": changed,
        }

    def _place(self, project: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
        current = self._require_widget(project, operation["widget_id"])
        widget = current.widget
        if widget.get("locked"):
            raise ApiError("widget_locked", "The selected widget is locked.", 409)
        surface = operation.get("surface", current.surface)
        if "parent_id" in operation:
            parent_id = operation["parent_id"]
        elif surface == current.surface:
            parent_id = current.parent.get("id", "") if current.parent else ""
        else:
            parent_id = ""
        if parent_id and self._contains(widget, parent_id):
            raise ApiError(
                "placement_cycle",
                "A widget cannot be placed inside its own subtree.",
                422,
            )
        destination = self._destination(project, surface, parent_id)
        self._validate_child(destination, str(widget.get("widget_type", "")))

        original_index = current.index
        same_nodes = current.nodes is destination.nodes
        index = operation.get("index")
        maximum_index = len(destination.nodes) - (1 if same_nodes else 0)
        if index is not None and index > maximum_index:
            raise ApiError("invalid_insertion_index", "Insertion index exceeds the target.", 422)
        current.nodes.pop(current.index)
        inserted_widget = False
        try:
            inserted = self._insert(destination.nodes, widget, index)
            inserted_widget = True
            self._apply_placement(
                project,
                widget,
                destination,
                operation.get("placement", {}),
            )
        except Exception:
            if inserted_widget:
                destination.nodes.remove(widget)
            current.nodes.insert(original_index, widget)
            raise
        return {
            "widget_id": operation["widget_id"],
            "from_surface": current.surface,
            "surface": destination.surface,
            "parent_id": destination.parent.get("id", "") if destination.parent else "",
            "index": inserted,
        }

    def _destination(
        self,
        project: dict[str, Any],
        surface: str,
        parent_id: str,
    ) -> WidgetLocation:
        roots, layout, auto_layout = self._surface(project, surface)
        if parent_id:
            found = self._find_in(surface, roots, layout, auto_layout, parent_id)
            if found is None:
                raise ApiError(
                    "parent_not_found",
                    f"Parent widget '{parent_id}' was not found on surface '{surface}'.",
                    404,
                )
            if found.widget.get("locked"):
                raise ApiError("widget_locked", "The destination parent is locked.", 409)
            return WidgetLocation(
                surface,
                found.widget.setdefault("children", []),
                0,
                found.widget,
                layout,
                auto_layout,
            )
        return WidgetLocation(surface, roots, 0, None, layout, auto_layout)

    def _apply_placement(
        self,
        project: dict[str, Any],
        widget: dict[str, Any],
        destination: WidgetLocation,
        placement: dict[str, Any],
    ) -> None:
        parent_layout = (
            destination.parent.get("layout", {})
            if destination.parent is not None
            else destination.surface_layout
        )
        layout_type = str(parent_layout.get("type", "NONE")).upper()
        for key in ("width", "height", "align", "align_to"):
            if key in placement:
                widget[key] = placement[key]
        if layout_type in {"FLEX", "GRID"} or destination.auto_layout:
            widget["x"] = 0
            widget["y"] = 0
        else:
            for key in ("x", "y"):
                if key in placement:
                    widget[key] = placement[key]
        if layout_type == "GRID":
            grid = placement.get("grid_cell", widget.get("grid_cell") or {})
            widget["grid_cell"] = {
                "row_pos": int(grid.get("row_pos", 0)),
                "column_pos": int(grid.get("column_pos", 0)),
                "row_span": int(grid.get("row_span", 1)),
                "column_span": int(grid.get("column_span", 1)),
                "x_align": str(grid.get("x_align", "START")),
                "y_align": str(grid.get("y_align", "START")),
            }
            self._validate_grid_cell(widget["grid_cell"], parent_layout)
        else:
            if placement.get("grid_cell"):
                raise ApiError(
                    "grid_cell_without_grid",
                    "grid_cell is valid only inside a GRID parent.",
                    422,
                )
            widget["grid_cell"] = {}
        self._validate_alignment(project, widget, destination.surface)
        self._validate_bounds(project, widget, destination, layout_type)

    def _validate_child(self, destination: WidgetLocation, widget_type: str) -> None:
        schema = WIDGET_SCHEMAS[widget_type]
        if destination.auto_layout:
            if destination.parent is not None or widget_type != "button":
                raise ApiError(
                    "invalid_msgbox_widget",
                    "Message-box collections accept top-level button widgets only.",
                    422,
                )
            return
        if destination.parent is None:
            if schema.is_stub:
                raise ApiError(
                    "invalid_stub_placement",
                    "Tab and tile helper nodes require their matching parent widget.",
                    422,
                )
            return
        parent_type = str(destination.parent.get("widget_type", ""))
        parent_schema = WIDGET_SCHEMAS.get(parent_type)
        if parent_schema is None or not parent_schema.allows_children:
            raise ApiError(
                "parent_rejects_children",
                f"Widget '{destination.parent.get('id', '')}' cannot contain children.",
                422,
            )
        expected = parent_schema.child_role
        if expected in {"tab", "tile"} and widget_type != expected:
            raise ApiError(
                "invalid_child_role",
                f"A {parent_type} accepts only {expected} child nodes.",
                422,
            )
        if expected == "generic" and schema.is_stub:
            raise ApiError(
                "invalid_child_role",
                "Tab and tile helper nodes require their matching parent widget.",
                422,
            )
        if (
            parent_type == "button"
            and "text" in destination.parent.get("properties", {})
        ):
            raise ApiError(
                "button_text_children_conflict",
                "Remove the button text shorthand before adding child widgets.",
                422,
            )

    @staticmethod
    def _validate_grid_cell(cell: dict[str, Any], layout: dict[str, Any]) -> None:
        rows = layout.get("grid_rows") or ["FR(1)"]
        columns = layout.get("grid_columns") or ["FR(1)"]
        if cell["row_pos"] + cell["row_span"] > len(rows):
            raise ApiError("grid_cell_overflow", "Grid row placement exceeds the grid.", 422)
        if cell["column_pos"] + cell["column_span"] > len(columns):
            raise ApiError("grid_cell_overflow", "Grid column placement exceeds the grid.", 422)

    def _normalise_children(self, widget: dict[str, Any]) -> None:
        layout = widget.get("layout", {})
        layout_type = str(layout.get("type", "NONE")).upper()
        for child in widget.get("children", []):
            if layout_type in {"FLEX", "GRID"}:
                child["x"] = 0
                child["y"] = 0
            if layout_type == "GRID":
                raw_cell = child.get("grid_cell") or {}
                cell = {
                    "row_pos": int(raw_cell.get("row_pos", 0)),
                    "column_pos": int(raw_cell.get("column_pos", 0)),
                    "row_span": int(raw_cell.get("row_span", 1)),
                    "column_span": int(raw_cell.get("column_span", 1)),
                    "x_align": str(raw_cell.get("x_align", "START")),
                    "y_align": str(raw_cell.get("y_align", "START")),
                }
                self._validate_grid_cell(cell, layout)
                child["grid_cell"] = cell
            else:
                child["grid_cell"] = {}

    @staticmethod
    def _normalise_layout(layout: dict[str, Any]) -> None:
        layout_type = str(layout.get("type", "NONE")).upper()
        if layout_type == "NONE":
            layout.clear()
            return
        layout["type"] = layout_type

    def _property_map(self, widget_type: str, category: str) -> dict[str, PropertyDef]:
        schema = WIDGET_SCHEMAS.get(widget_type)
        if schema is None:
            raise ApiError("unknown_widget_type", "The widget type is not supported.", 422)
        return {
            prop.key: prop
            for prop in schema.properties
            if prop.category == category and (category != STYLE or prop.part == "main")
        }

    def _patch_values(
        self,
        target: dict[str, Any],
        patch: dict[str, Any],
        definitions: dict[str, PropertyDef],
        label: str,
    ) -> None:
        for key, value in patch.items():
            definition = definitions.get(key)
            if definition is None:
                raise ApiError(
                    "unsupported_property",
                    f"'{key}' is not an editable {label} field for this widget.",
                    422,
                )
            if value is None:
                target.pop(key, None)
                continue
            self._validate_value(definition, value)
            target[key] = copy.deepcopy(value)

    @staticmethod
    def _validate_value(definition: PropertyDef, value: Any) -> None:
        kind = definition.kind
        valid = True
        if kind == "bool":
            valid = isinstance(value, bool)
        elif kind == "int":
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif kind == "float":
            valid = (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            )
        elif kind == "enum":
            valid = isinstance(value, str) and value in definition.enum_values
        elif kind == "color":
            valid = (
                isinstance(value, int)
                and not isinstance(value, bool)
                and 0 <= value <= 0xFFFFFF
            ) or (
                isinstance(value, str)
                and len(value) <= 64
                and bool(re.fullmatch(r"(?:0x|#)?[0-9A-Fa-f]{6}|[A-Za-z_][A-Za-z0-9_]*", value))
            )
        elif kind == "percent_or_enum":
            valid = (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            ) or (
                isinstance(value, str)
                and (value in definition.enum_values or bool(_PERCENT.fullmatch(value)))
            )
        elif kind in {"font_ref", "image_ref", "widget_ref"}:
            valid = isinstance(value, str) and bool(_ID.fullmatch(value))
        elif kind in {"text_list", "image_ref_list"}:
            valid = (
                isinstance(value, list)
                and len(value) <= 64
                and all(isinstance(item, str) and len(item) <= 256 for item in value)
            )
        elif kind == "grid_track_list":
            valid = (
                isinstance(value, list)
                and 1 <= len(value) <= 32
                and all(
                    (isinstance(item, (int, float)) and not isinstance(item, bool) and item >= 0)
                    or (isinstance(item, str) and bool(_TRACK.fullmatch(item)))
                    for item in value
                )
            )
        elif kind == "text":
            valid = isinstance(value, str) and len(value) <= MCP_OPERATION_TEXT_LENGTH
        if not valid:
            raise ApiError(
                "invalid_property_value",
                f"Value for '{definition.key}' does not match type '{kind}'.",
                422,
            )
