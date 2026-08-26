"""YAML export/merge-preview and argument completion, split out of query.py.

Plain functions taking the owning ``QueryService`` explicitly, matching the
pattern in query_bindings.py.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from ..api.viewer_projection import project_widget_types
from ..errors import ApiError
from ..lvgl_merge import MergeError, merge_project_into_yaml
from .limits import MCP_COMPLETION_LIMIT, MCP_CONFIGURATION_CHUNK_CHARACTERS
from .secrets_guard import assert_not_secrets_file

if TYPE_CHECKING:
    from .query import QueryService


def transform_yaml(
    service: "QueryService",
    name: str,
    project_revision: str,
    mode: str = "export",
    configuration_name: str = "",
    configuration_revision: str = "",
    offset: int = 0,
    max_characters: int = MCP_CONFIGURATION_CHUNK_CHARACTERS,
) -> dict[str, Any]:
    """Export or merge-preview one exact project revision without writing."""
    if mode not in {"export", "merge_preview"}:
        raise ApiError(
            "invalid_yaml_transform",
            "mode must be export or merge_preview.",
            422,
        )
    loaded = service.projects.read(name)
    if loaded["revision"] != project_revision:
        raise ApiError(
            "revision_conflict",
            "The stored project changed after it was selected.",
            409,
            {
                "expected_revision": project_revision,
                "actual_revision": loaded["revision"],
            },
        )

    metadata: dict[str, Any] = {}
    if mode == "export":
        exported = service.designer.export_yaml(loaded["project"])
        content = exported["yaml"]
        metadata["issues"] = exported["issues"]
    else:
        if not configuration_name or not configuration_revision:
            raise ApiError(
                "configuration_revision_required",
                "merge_preview requires a configuration name and exact revision.",
                422,
            )
        assert_not_secrets_file(configuration_name)
        configuration = service.filesystem.read_config(configuration_name)
        if configuration["revision"] != configuration_revision:
            raise ApiError(
                "revision_conflict",
                "The source configuration changed after it was selected.",
                409,
                {
                    "expected_revision": configuration_revision,
                    "actual_revision": configuration["revision"],
                },
            )
        project, issues = service.designer.validate(loaded["project"])
        if any(issue["severity"] == "error" for issue in issues):
            raise ApiError(
                "invalid_project",
                "Project validation failed.",
                422,
                {"issues": issues},
            )
        try:
            merged = merge_project_into_yaml(project, configuration["content"])
        except MergeError as exc:
            raise ApiError("merge_failed", str(exc), 422) from exc
        content = merged.content
        metadata.update(
            {
                "configuration_name": configuration_name,
                "configuration_revision": configuration_revision,
                "replaced": merged.replaced_keys,
                "appended": merged.appended_keys,
                "issues": [asdict(issue) for issue in merged.issues],
            }
        )

    return {
        "name": name,
        "project_revision": project_revision,
        "mode": mode,
        **metadata,
        **service._text_segment(content, offset, max_characters),
    }


def complete_argument(
    service: "QueryService",
    argument_name: str,
    partial: str = "",
    context: dict[str, str] | None = None,
    *,
    resource_reference: str = "",
) -> dict[str, Any]:
    """Return deterministic, bounded completion values for MCP clients."""
    arguments = context or {}
    name = str(argument_name)
    if name == "name" and "/projects/{name}/" in resource_reference:
        name = "project_name"
    needle = str(partial).strip().casefold()[:128]
    values: list[str]
    try:
        if name == "project_name":
            values = [item["name"] for item in service.projects.list()]
        elif name == "configuration_name":
            values = [item["name"] for item in service.filesystem.list_configs()]
        elif name == "device_id":
            values = [item.id for item in service.device_registry.list()]
        elif name in {"widget_id", "parent_widget_id"}:
            project = service.projects.read(str(arguments.get("project_name", "")))[
                "project"
            ]
            values = sorted(project_widget_types(project))
        elif name in {"entity_domain", "entity_id"}:
            project = service.projects.read(str(arguments.get("project_name", "")))[
                "project"
            ]
            entities = [
                item
                for item in project.get("entities", [])
                if isinstance(item, dict)
            ]
            if name == "entity_domain":
                values = sorted(
                    {
                        str(item.get("domain", ""))
                        for item in entities
                        if item.get("domain")
                    }
                )
            else:
                domain = str(arguments.get("entity_domain", ""))
                values = sorted(
                    {
                        str(item.get("id", ""))
                        for item in entities
                        if item.get("id")
                        and (not domain or item.get("domain") == domain)
                    }
                )
        else:
            values = {
                "focus": ["summary", "layout", "bindings", "validation", "yaml"],
                "direction": [
                    "entity_to_widget",
                    "widget_to_entity",
                    "bidirectional",
                ],
                "binding_kind": ["project", "viewer"],
                "source": ["active", "draft"],
            }.get(name, [])
    except ApiError:
        values = []
    matches = [value for value in values if not needle or needle in value.casefold()]
    return {
        "values": matches[:MCP_COMPLETION_LIMIT],
        "total": len(matches),
        "has_more": len(matches) > MCP_COMPLETION_LIMIT,
    }
