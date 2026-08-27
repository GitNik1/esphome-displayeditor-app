"""Read-only projections over the project revision history.

Plain functions taking the owning ``QueryService`` explicitly, matching the
pattern in query_bindings.py and query_yaml.py.

Read only on purpose: rolling a project back goes through the existing
changeset pipeline (``display_project_propose`` -> ``display_changeset_apply``),
which carries base-revision safety, quotas and a human-inspectable proposal. A
dedicated restore tool would be a second write path around exactly the review
that matters most.
"""

from __future__ import annotations

import difflib
import json
from typing import TYPE_CHECKING, Any

from ..errors import ApiError
from ..project_revisions import PROJECT_REVISION_DEPTH
from .limits import MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS

if TYPE_CHECKING:
    from .query import QueryService

_METADATA_FIELDS = (
    "id",
    "revision",
    "created_at",
    "actor",
    "origin",
    "action",
    "byte_size",
    "encoding",
    "restored_from",
    "label",
    "locked",
)


def _entry(item: dict[str, Any], current: str | None, current_id: int | None) -> dict:
    return {
        **{field: item[field] for field in _METADATA_FIELDS},
        "is_current": item["id"] == current_id,
        "restorable": item["encoding"] not in {"tombstone", "skipped"},
    }


def list_revisions(
    service: "QueryService", name: str, limit: int = PROJECT_REVISION_DEPTH
) -> dict[str, Any]:
    """Metadata for the stored versions of one project. Never returns content."""
    current = service.projects.current_revision(name)
    versions = service.projects.revisions.list(name)
    # A restored version is byte-identical to its source, so several rows can
    # share the current revision; only the newest of them is on disk.
    current_id = next(
        (
            item["id"]
            for item in versions
            if item["revision"] == current and item["action"] == "save"
        ),
        None,
    )
    safe_limit = min(max(limit, 1), PROJECT_REVISION_DEPTH)
    return {
        "name": name,
        "exists": current is not None,
        "current_revision": current,
        "versions": [_entry(item, current, current_id) for item in versions[:safe_limit]],
        "truncated": len(versions) > safe_limit,
    }


def read_revision(
    service: "QueryService",
    name: str,
    revision_id: int,
    view: str = "summary",
    against: str = "current",
) -> dict[str, Any]:
    """One stored version as a bounded summary or a unified diff."""
    if view not in {"summary", "diff"}:
        raise ApiError("invalid_request", "view must be 'summary' or 'diff'.")
    found = service.projects.revisions.content(name, revision_id)
    if found is None:
        raise ApiError("revision_not_found", "Version was not found.", 404)
    raw, metadata = found
    current = service.projects.current_revision(name)
    base = {
        **{field: metadata[field] for field in _METADATA_FIELDS},
        "name": name,
        "is_current": metadata["revision"] == current,
    }
    if metadata["encoding"] in {"tombstone", "skipped"}:
        return {**base, "restorable": False, "view": view}
    if view == "summary":
        return {**base, "restorable": True, "view": "summary", **_summary(service, raw)}
    return {**base, "restorable": True, "view": "diff", **_diff(service, name, raw, against)}


def _summary(service: "QueryService", raw: bytes) -> dict[str, Any]:
    payload = json.loads(raw.decode("utf-8"))
    project, issues = service.designer.validate(payload)
    widgets = getattr(project, "widgets", []) or []
    pages = getattr(project, "pages", []) or []
    return {
        "widget_count": len(widgets),
        "page_count": len(pages),
        "issue_count": len(issues),
        "valid": not any(issue.get("severity") == "error" for issue in issues),
    }


def _diff(
    service: "QueryService", name: str, raw: bytes, against: str
) -> dict[str, Any]:
    if against == "current":
        target = service.projects.current_bytes(name) or b""
        label = "current"
    else:
        try:
            other_id = int(against)
        except ValueError as exc:
            raise ApiError(
                "invalid_request", "'against' must be 'current' or a version id."
            ) from exc
        other = service.projects.revisions.content(name, other_id)
        if other is None:
            raise ApiError("revision_not_found", "Version was not found.", 404)
        target, label = other[0], str(other_id)
    diff = "".join(
        difflib.unified_diff(
            raw.decode("utf-8", "replace").splitlines(keepends=True),
            target.decode("utf-8", "replace").splitlines(keepends=True),
            fromfile=f"{name}@stored",
            tofile=f"{name}@{label}",
        )
    )
    return {
        "against": label,
        "diff": diff[:MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS],
        "diff_truncated": len(diff) > MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS,
    }
