"""Surface traversal and topology validation for semantic placement."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

from ..designer_core.widgetschema import ALIGN_VALUES
from ..errors import ApiError


@dataclass
class WidgetLocation:
    surface: str
    nodes: list[dict[str, Any]]
    index: int
    parent: dict[str, Any] | None
    surface_layout: dict[str, Any]
    auto_layout: bool = False

    @property
    def widget(self) -> dict[str, Any]:
        return self.nodes[self.index]


class PlacementTopologyMixin:
    """Navigation helpers shared by the semantic placement service."""

    def _surface(
        self, project: dict[str, Any], key: str
    ) -> tuple[list[dict[str, Any]], dict[str, Any], bool]:
        pages = project.get("pages") if isinstance(project.get("pages"), list) else []
        if key == "root":
            if pages:
                raise ApiError(
                    "root_page_conflict",
                    "Root widgets cannot be added while the project contains pages.",
                    422,
                )
            extra = project.get("extra_lvgl")
            layout = extra.get("layout", {}) if isinstance(extra, dict) else {}
            return project.setdefault("widgets", []), layout, False
        if key.startswith("page:"):
            if project.get("widgets"):
                raise ApiError(
                    "root_page_conflict",
                    "Page widgets cannot be added while root widgets exist.",
                    422,
                )
            page_id = key.split(":", 1)[1]
            page = next((item for item in pages if item.get("id") == page_id), None)
            if page is None:
                raise ApiError("surface_not_found", f"Page '{page_id}' was not found.", 404)
            return page.setdefault("widgets", []), page.get("layout", {}), False
        if key in {"top", "bottom"}:
            field = f"{key}_layer"
            layer = project.get(field)
            if not isinstance(layer, dict):
                raise ApiError("surface_not_found", f"Surface '{key}' does not exist.", 404)
            return layer.setdefault("widgets", []), layer.get("layout", {}), False
        if key.startswith("msgbox:"):
            _prefix, msgbox_id, collection = key.split(":", 2)
            msgboxes = project.get("msgboxes")
            entries = msgboxes if isinstance(msgboxes, list) else []
            msgbox = next(
                (
                    item
                    for item in entries
                    if isinstance(item, dict) and item.get("id") == msgbox_id
                ),
                None,
            )
            if msgbox is None:
                raise ApiError(
                    "surface_not_found", f"Message box '{msgbox_id}' was not found.", 404
                )
            return msgbox.setdefault(collection, []), {}, True
        raise ApiError("surface_not_found", f"Surface '{key}' is not supported.", 404)

    def _require_widget(
        self, project: dict[str, Any], widget_id: str
    ) -> WidgetLocation:
        found = self._find_widget(project, widget_id)
        if found is None:
            raise ApiError("widget_not_found", f"Widget '{widget_id}' was not found.", 404)
        return found

    def _find_widget(
        self, project: dict[str, Any], widget_id: str
    ) -> WidgetLocation | None:
        for key, roots, layout, auto in self._surfaces(project):
            found = self._find_in(key, roots, layout, auto, widget_id)
            if found is not None:
                return found
        return None

    def _surfaces(
        self, project: dict[str, Any]
    ) -> Iterator[tuple[str, list[dict[str, Any]], dict[str, Any], bool]]:
        extra = project.get("extra_lvgl")
        yield "root", project.get("widgets", []), (
            extra.get("layout", {}) if isinstance(extra, dict) else {}
        ), False
        pages = project.get("pages")
        for page in pages if isinstance(pages, list) else []:
            if isinstance(page, dict):
                yield (
                    f"page:{page.get('id', '')}",
                    page.get("widgets", []),
                    page.get("layout", {}),
                    False,
                )
        for key in ("top", "bottom"):
            layer = project.get(f"{key}_layer")
            if isinstance(layer, dict):
                yield key, layer.get("widgets", []), layer.get("layout", {}), False
        msgboxes = project.get("msgboxes")
        for msgbox in msgboxes if isinstance(msgboxes, list) else []:
            if not isinstance(msgbox, dict):
                continue
            for collection in ("buttons", "header_buttons"):
                yield (
                    f"msgbox:{msgbox.get('id', '')}:{collection}",
                    msgbox.get(collection, []),
                    {},
                    True,
                )

    def _find_in(
        self,
        surface: str,
        nodes: list[dict[str, Any]],
        layout: dict[str, Any],
        auto: bool,
        widget_id: str,
        parent: dict[str, Any] | None = None,
    ) -> WidgetLocation | None:
        for index, widget in enumerate(nodes):
            if widget.get("id") == widget_id:
                return WidgetLocation(surface, nodes, index, parent, layout, auto)
            found = self._find_in(
                surface,
                widget.get("children", []),
                layout,
                auto,
                widget_id,
                widget,
            )
            if found is not None:
                return found
        return None

    def _validate_alignment(
        self, project: dict[str, Any], widget: dict[str, Any], surface: str
    ) -> None:
        align = str(widget.get("align", "TOP_LEFT")).upper()
        if align not in ALIGN_VALUES:
            raise ApiError("invalid_alignment", f"Alignment '{align}' is not supported.", 422)
        widget["align"] = align
        target_id = str(widget.get("align_to", ""))
        if not target_id:
            if align.startswith("OUT_"):
                raise ApiError(
                    "alignment_target_required",
                    "OUT_* alignments require align_to on the same surface.",
                    422,
                )
            return
        target = self._find_widget(project, target_id)
        if target is None or target.surface != surface:
            raise ApiError(
                "invalid_alignment_target",
                "align_to must reference another widget on the same surface.",
                422,
            )
        if target.widget is widget:
            raise ApiError("alignment_cycle", "A widget cannot align to itself.", 422)

    def _validate_alignment_graph(self, project: dict[str, Any]) -> None:
        by_surface: dict[str, dict[str, str]] = {}
        for surface, roots, _layout, _auto in self._surfaces(project):
            links: dict[str, str] = {}
            widgets = list(self._walk(roots))
            widget_ids = {str(widget.get("id", "")) for widget in widgets}
            for widget in widgets:
                target = str(widget.get("align_to", ""))
                if target:
                    if target not in widget_ids:
                        raise ApiError(
                            "invalid_alignment_target",
                            "align_to must reference another widget on the same surface.",
                            422,
                        )
                    links[str(widget.get("id", ""))] = target
            by_surface[surface] = links
        for surface, links in by_surface.items():
            for start in links:
                seen = set()
                current = start
                while current in links:
                    if current in seen:
                        raise ApiError(
                            "alignment_cycle",
                            f"Alignment references form a cycle on surface '{surface}'.",
                            422,
                        )
                    seen.add(current)
                    current = links[current]

    def _validate_bounds(
        self,
        project: dict[str, Any],
        widget: dict[str, Any],
        destination: WidgetLocation,
        layout_type: str,
    ) -> None:
        if layout_type in {"FLEX", "GRID"} or destination.auto_layout:
            return
        if widget.get("align", "TOP_LEFT") != "TOP_LEFT" or widget.get("align_to"):
            return
        if destination.parent is None:
            canvas = project.get("canvas", {})
            extent = (canvas.get("width"), canvas.get("height"))
        else:
            extent = (destination.parent.get("width"), destination.parent.get("height"))
        if not all(isinstance(value, (int, float)) for value in extent):
            return
        x, y = widget.get("x", 0), widget.get("y", 0)
        width, height = widget.get("width", 0), widget.get("height", 0)
        if not all(isinstance(value, (int, float)) for value in (x, y, width, height)):
            raise ApiError("invalid_geometry", "AI placement requires numeric geometry.", 422)
        if x < 0 or y < 0 or x + width > extent[0] or y + height > extent[1]:
            raise ApiError(
                "placement_overflow",
                "TOP_LEFT placement must remain inside its canvas or parent.",
                422,
                {"extent": {"width": extent[0], "height": extent[1]}},
            )

    def _used_ids(self, project: dict[str, Any]) -> set[str]:
        result = set(str(item) for item in project.get("reserved_ids", []))
        for _surface, roots, _layout, _auto in self._surfaces(project):
            result.update(str(widget.get("id", "")) for widget in self._walk(roots))
        for key in ("styles", "fonts", "images", "colors"):
            entries = project.get(key)
            result.update(
                str(item.get("id", ""))
                for item in (entries if isinstance(entries, list) else [])
                if isinstance(item, dict)
            )
        pages = project.get("pages")
        result.update(
            str(page.get("id", ""))
            for page in (pages if isinstance(pages, list) else [])
            if isinstance(page, dict)
        )
        msgboxes = project.get("msgboxes")
        result.update(
            str(msgbox.get("id", ""))
            for msgbox in (msgboxes if isinstance(msgboxes, list) else [])
            if isinstance(msgbox, dict)
        )
        return result

    @classmethod
    def _contains(cls, widget: dict[str, Any], widget_id: str) -> bool:
        return any(item.get("id") == widget_id for item in cls._walk([widget]))

    @staticmethod
    def _walk(nodes: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        for widget in nodes if isinstance(nodes, list) else []:
            if not isinstance(widget, dict):
                continue
            yield widget
            yield from PlacementTopologyMixin._walk(widget.get("children", []))

    @staticmethod
    def _insert(
        nodes: list[dict[str, Any]], widget: dict[str, Any], index: int | None
    ) -> int:
        if index is None:
            nodes.append(widget)
            return len(nodes) - 1
        if index > len(nodes):
            raise ApiError(
                "invalid_insertion_index", "Insertion index exceeds the target.", 422
            )
        nodes.insert(index, widget)
        return index
