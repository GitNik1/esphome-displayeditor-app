"""Value, style and distribution helpers shared by layout projection passes."""

from __future__ import annotations

import math
import re
from typing import Any


_FR_TRACK = re.compile(r"^FR\((\d+(?:\.\d+)?)\)$", re.I)


class LayoutProjectionValuesMixin:
    @staticmethod
    def _style(project: dict[str, Any], widget: dict[str, Any]) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        if widget.get("style_mode") == "named":
            references = (
                widget.get("style_refs")
                if isinstance(widget.get("style_refs"), list)
                else []
            )
            for reference in references:
                entry = next(
                    (
                        item
                        for item in project.get("styles", [])
                        if isinstance(item, dict) and item.get("id") == reference
                    ),
                    None,
                )
                if entry and isinstance(entry.get("style_tree"), dict):
                    merged.update(entry["style_tree"])
        theme = project.get("theme") if isinstance(project.get("theme"), dict) else {}
        themed = theme.get(widget.get("widget_type"))
        if isinstance(themed, dict):
            merged.update(themed)
        inline = widget.get("style_tree")
        if isinstance(inline, dict):
            merged.update(inline)
        return merged

    @classmethod
    def _padding(cls, style: dict[str, Any]) -> dict[str, float]:
        all_padding = cls._number(style.get("pad_all"))
        return {
            "top": cls._number(style.get("pad_top", all_padding)),
            "right": cls._number(style.get("pad_right", all_padding)),
            "bottom": cls._number(style.get("pad_bottom", all_padding)),
            "left": cls._number(style.get("pad_left", all_padding)),
        }

    @staticmethod
    def _resolve_size(
        value: Any,
        parent: float,
        intrinsic: float,
        fallback: float,
    ) -> float:
        if value is None or value == "":
            return fallback
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        text = str(value).strip()
        if text.endswith("%"):
            try:
                return parent * float(text[:-1]) / 100.0
            except ValueError:
                return fallback
        if text.upper() == "SIZE_CONTENT":
            return intrinsic
        try:
            return float(text)
        except ValueError:
            return fallback

    @classmethod
    def _track_sizes(
        cls,
        specs: list[Any],
        extent: float,
        gap: float,
        content_sizes: list[float],
    ) -> list[float]:
        parsed = [cls._parse_track(item) for item in specs]
        sizes = [
            track.get("px", content_sizes[index] if track.get("content") else 0.0)
            for index, track in enumerate(parsed)
        ]
        used = sum(sizes) + gap * max(0, len(specs) - 1)
        total_fraction = sum(track.get("fr", 0.0) for track in parsed)
        free = max(0.0, extent - used)
        if total_fraction > 0:
            for index, track in enumerate(parsed):
                if track.get("fr"):
                    sizes[index] = free * track["fr"] / total_fraction
        return sizes

    @staticmethod
    def _parse_track(value: Any) -> dict[str, float | bool]:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return {"px": float(value)}
        text = str(value or "").strip().upper()
        fraction = _FR_TRACK.fullmatch(text)
        if fraction:
            return {"fr": float(fraction.group(1))}
        if text == "CONTENT":
            return {"content": True}
        try:
            return {"px": float(text)}
        except ValueError:
            return {"content": True}

    @staticmethod
    def _track_offsets(sizes: list[float], gap: float) -> list[float]:
        offsets = []
        running = 0.0
        for size in sizes:
            offsets.append(running)
            running += size + gap
        return offsets

    @staticmethod
    def _align_offset(align: str, available: float, size: float) -> float:
        if align == "CENTER":
            return (available - size) / 2.0
        if align == "END":
            return available - size
        return 0.0

    @staticmethod
    def _distribution_start(align: Any, extent: float, total: float) -> float:
        fraction = {"START": 0.0, "END": 1.0, "CENTER": 0.5}.get(
            str(align or "START").upper(), 0.0
        )
        return (extent - total) * fraction

    @classmethod
    def _distribution(
        cls,
        align: Any,
        count: int,
        extent: float,
        used: float,
        gap: float,
    ) -> tuple[float, float]:
        key = str(align or "START").upper()
        free = max(0.0, extent - used)
        if key == "SPACE_BETWEEN" and count > 1:
            return 0.0, gap + free / (count - 1)
        if key == "SPACE_AROUND" and count > 0:
            share = free / count
            return share / 2.0, gap + share
        if key == "SPACE_EVENLY" and count > 0:
            share = free / (count + 1)
            return share, gap + share
        return cls._distribution_start(key, extent, used), gap

    @staticmethod
    def _number(value: Any) -> float:
        try:
            number = float(value or 0)
        except (TypeError, ValueError):
            return 0.0
        return number if math.isfinite(number) else 0.0

    @staticmethod
    def _box(
        left: float,
        top: float,
        width: float,
        height: float,
        managed: bool,
        origin_x: float,
        origin_y: float,
    ) -> dict[str, Any]:
        return {
            "left": left,
            "top": top,
            "width": width,
            "height": height,
            "managed": managed,
            "origin_x": origin_x,
            "origin_y": origin_y,
        }
