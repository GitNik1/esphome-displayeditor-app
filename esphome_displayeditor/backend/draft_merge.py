"""Merge a Designer project into a configuration draft - shared by the web API
(``POST /designer/projects/merge-draft``) and the MCP draft proposal.

Both used to carry their own copy of base selection, merge-error mapping and
the check for blocking issues; they differed in messages and in what reached
the client. They differ now only in how the result is stored: directly as a
draft, or as a change set to review first.
"""

from __future__ import annotations

from .designer_core.model import Project
from .errors import ApiError
from .lvgl_merge import (
    DisplayTakeoverRequired,
    MergeError,
    MergeResult,
    choose_merge_base,
    merge_project_into_yaml,
)


def merge_for_draft(
    project: Project,
    draft: str | None,
    active: str,
    *,
    confirm_display_takeover: bool,
    takeover_hint: str = "",
) -> tuple[MergeResult, str]:
    """Merge ``project`` into the draft (or, without a usable draft, the
    active configuration). Returns the result and the text it was built on;
    raises ``ApiError`` for a display takeover that needs confirmation, a
    merge that cannot be done safely, and blocking (severity A) issues."""
    base, base_issues = choose_merge_base(draft, active)
    try:
        merged = merge_project_into_yaml(
            project, base,
            display_takeover="comment" if confirm_display_takeover else "ask",
        )
    except DisplayTakeoverRequired as exc:
        message = f"{exc} {takeover_hint}".strip()
        raise ApiError("display_takeover_required", message, 409,
                       {"displays": exc.conflicts}) from exc
    except MergeError as exc:
        raise ApiError("merge_failed", str(exc), 422) from exc
    merged.issues[:0] = base_issues
    blocking = [issue for issue in merged.issues if issue.severity == "A"]
    if blocking:
        raise ApiError(
            "invalid_project",
            "Project merge contains blocking issues.",
            422,
            {"issues": [{"severity": issue.severity, "message": issue.message}
                        for issue in blocking[:100]]},
        )
    return merged, base
