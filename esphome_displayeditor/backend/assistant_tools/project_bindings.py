"""Semantic mutations for exportable bindings stored in designer projects."""

from __future__ import annotations

import copy
from typing import Any

from ..errors import ApiError


class ProjectBindingService:
    def apply(
        self, project: dict[str, Any], operations: list[dict[str, Any]]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        proposed = copy.deepcopy(project)
        bindings = proposed.setdefault("bindings", [])
        if not isinstance(bindings, list):
            raise ApiError("invalid_bindings", "Project bindings must be a list.", 422)
        before_count = len(bindings)
        before_ids = self._binding_ids(bindings)
        results: list[dict[str, Any]] = []
        for index, operation in enumerate(operations):
            kind = operation["op"]
            if kind == "set_project_binding":
                result = self._set(bindings, operation)
            elif kind == "remove_project_binding":
                result = self._remove(bindings, operation["binding_id"])
            else:
                raise ApiError(
                    "unsupported_operation",
                    f"Binding operation {index} has an unsupported type.",
                    422,
                )
            results.append({"operation_index": index, "op": kind, **result})
        after_ids = self._binding_ids(bindings)
        return proposed, {
            "operation_count": len(results),
            "operations": results,
            "binding_count": {"before": before_count, "after": len(bindings)},
            "added_binding_ids": sorted(after_ids - before_ids),
            "removed_binding_ids": sorted(before_ids - after_ids),
        }

    def _set(
        self, bindings: list[dict[str, Any]], operation: dict[str, Any]
    ) -> dict[str, Any]:
        binding_id = operation["binding_id"]
        found = self._find(bindings, binding_id)
        if len(found) > 1:
            raise ApiError("duplicate_binding", "The binding id is duplicated.", 409)
        if found and found[0][1].get("kind") in {"opaque_yaml", "custom_yaml"}:
            raise ApiError(
                "protected_custom_binding",
                "Imported custom-YAML bindings are read-only over MCP.",
                422,
            )
        binding = self._binding(operation)
        action = "updated"
        if found:
            bindings[found[0][0]] = binding
        else:
            if len(bindings) >= 512:
                raise ApiError(
                    "too_many_bindings",
                    "A project may contain at most 512 device bindings.",
                    422,
                )
            bindings.append(binding)
            action = "added"
        return {"binding_id": binding_id, "action": action}

    def _remove(
        self, bindings: list[dict[str, Any]], binding_id: str
    ) -> dict[str, Any]:
        found = self._find(bindings, binding_id)
        if not found:
            raise ApiError("binding_not_found", f"Binding '{binding_id}' was not found.", 404)
        if len(found) > 1:
            raise ApiError("duplicate_binding", "The binding id is duplicated.", 409)
        if found[0][1].get("kind") in {"opaque_yaml", "custom_yaml"}:
            raise ApiError(
                "protected_custom_binding",
                "Imported custom-YAML bindings are read-only over MCP.",
                422,
            )
        bindings.pop(found[0][0])
        return {"binding_id": binding_id, "action": "removed"}

    @staticmethod
    def _binding(operation: dict[str, Any]) -> dict[str, Any]:
        direction = operation["direction"]
        entity: dict[str, Any] = {
            "domain": operation["entity_domain"],
            "id": operation["entity_id"],
        }
        widget: dict[str, Any] = {"widget_id": operation["widget_id"]}
        if direction in {"entity_to_widget", "bidirectional"}:
            widget["property"] = operation["widget_property"]
        if direction in {"widget_to_entity", "bidirectional"}:
            widget["event"] = operation["widget_event"]
            entity["command"] = operation["entity_command"]
        for key in ("indicator_id", "reverse_widget_id"):
            if operation.get(key):
                widget[key] = operation[key]
        binding: dict[str, Any] = {
            "id": operation["binding_id"],
            "direction": direction,
            "source": entity if direction != "widget_to_entity" else widget,
            "target": widget if direction != "widget_to_entity" else entity,
        }
        if operation.get("transform"):
            binding["transform"] = copy.deepcopy(operation["transform"])
        if operation.get("conditions"):
            binding["conditions"] = copy.deepcopy(operation["conditions"])
        return binding

    @staticmethod
    def _find(
        bindings: list[dict[str, Any]], binding_id: str
    ) -> list[tuple[int, dict[str, Any]]]:
        return [
            (index, binding)
            for index, binding in enumerate(bindings)
            if isinstance(binding, dict) and binding.get("id") == binding_id
        ]

    @staticmethod
    def _binding_ids(bindings: list[dict[str, Any]]) -> set[str]:
        return {
            str(binding.get("id"))
            for binding in bindings
            if isinstance(binding, dict) and binding.get("id")
        }
