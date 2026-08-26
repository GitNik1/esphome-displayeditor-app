"""Semantic operations for add-on-only Viewer binding sidecars."""

from __future__ import annotations

import copy
from typing import Any, Callable

from ..api.viewer_projection import project_widget_types
from ..errors import ApiError
from ..viewer_bindings import validate_binding_targets


class ViewerBindingService:
    def apply(
        self,
        project: dict[str, Any],
        current: list[dict[str, Any]],
        operations: list[dict[str, Any]],
        *,
        device_lookup: Callable[[str], Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        proposed = copy.deepcopy(current)
        before = self._keys(proposed)
        results: list[dict[str, Any]] = []
        for index, operation in enumerate(operations):
            key = (operation["widget_id"], operation["target"])
            matches = [
                item_index
                for item_index, binding in enumerate(proposed)
                if self._key(binding) == key
            ]
            if len(matches) > 1:
                raise ApiError("duplicate_binding", "The Viewer binding is duplicated.", 409)
            if operation["op"] == "set_viewer_binding":
                binding = {
                    field: copy.deepcopy(operation[field])
                    for field in (
                        "widget_id",
                        "target",
                        "device_id",
                        "entity_id",
                        "value_format",
                        "fallback",
                        "stale_after",
                    )
                }
                if matches:
                    proposed[matches[0]] = binding
                    action = "updated"
                else:
                    proposed.append(binding)
                    action = "added"
            elif operation["op"] == "remove_viewer_binding":
                if not matches:
                    raise ApiError(
                        "binding_not_found", "The Viewer binding was not found.", 404
                    )
                proposed.pop(matches[0])
                action = "removed"
            else:
                raise ApiError(
                    "unsupported_operation",
                    f"Viewer binding operation {index} has an unsupported type.",
                    422,
                )
            results.append(
                {
                    "operation_index": index,
                    "op": operation["op"],
                    "widget_id": key[0],
                    "target": key[1],
                    "action": action,
                }
            )
        normalized = validate_binding_targets(
            proposed,
            project_widget_types(project),
            device_lookup,
        )
        after = self._keys(normalized)
        return normalized, {
            "operation_count": len(results),
            "operations": results,
            "viewer_binding_count": {
                "before": len(current),
                "after": len(normalized),
            },
            "added_viewer_bindings": self._labels(after - before),
            "removed_viewer_bindings": self._labels(before - after),
        }

    @staticmethod
    def _key(binding: dict[str, Any]) -> tuple[str, str]:
        return str(binding.get("widget_id", "")), str(binding.get("target", ""))

    @classmethod
    def _keys(cls, bindings: list[dict[str, Any]]) -> set[tuple[str, str]]:
        return {cls._key(binding) for binding in bindings}

    @staticmethod
    def _labels(keys: set[tuple[str, str]]) -> list[str]:
        return sorted(f"{widget_id}:{target}" for widget_id, target in keys)
