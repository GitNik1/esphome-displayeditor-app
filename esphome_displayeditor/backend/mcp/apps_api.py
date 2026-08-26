"""MCP Apps extension: the sandboxed Preview and Change-Set Review views
(plan §9).

Tools that create or apply changesets move here from discovery.py/write_api.py
one at a time: each is the exact same function, same scope check, timeout,
and concurrency limiting as before - the only addition is
`_meta.ui.resourceUri`, so a supporting host renders the matching bundled
``ui://`` view alongside the plain structured result. A client that never
negotiated MCP Apps ignores that `_meta` entry and sees exactly the same
JSON as if this file did not exist.

Neither bundle has external origins: no `csp` domains are granted, so an
iframe cannot fetch, connect to, or frame anything outside itself. The
Change-Set Review view's Apply button only ever calls the already-registered,
already-scope-checked ``display_changeset_apply`` tool through the same MCP
Apps bridge a client would use for any other tool call - it is a UI
convenience for triggering an already-authorized action, not a new
capability or a bypass of any check in support.py or identity.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mcp.server.apps import Apps

from ..assistant_tools import AssistantToolService
from ..assistant_tools.binding_operations import ProjectBindingOperation
from ..assistant_tools.limits import MCP_APP_BUNDLE_MAX_BYTES
from ..assistant_tools.operations import PlacementOperation
from ..assistant_tools.viewer_binding_operations import ViewerBindingOperation
from .identity import MCPAuthorization
from .support import PROPOSAL, READ_ONLY, scoped_tool_result

_APPS_DIR = Path(__file__).with_name("apps")
_PREVIEW_RESOURCE_URI = "ui://display-editor/preview"
_REVIEW_RESOURCE_URI = "ui://display-editor/changeset-review"


def _load_bundle(filename: str) -> str:
    path = _APPS_DIR / filename
    html = path.read_text(encoding="utf-8")
    size = len(html.encode("utf-8"))
    if size > MCP_APP_BUNDLE_MAX_BYTES:
        raise ValueError(
            f"MCP App bundle {filename} is {size} bytes, "
            f"over the {MCP_APP_BUNDLE_MAX_BYTES}-byte limit."
        )
    return html


def build_apps_extension(
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
    *,
    include_changeset_review: bool,
) -> Apps:
    apps = Apps()
    _register_preview(apps, service, fallback)
    if include_changeset_review:
        _register_changeset_review(apps, service, fallback)
    return apps


def _register_preview(
    apps: Apps,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    apps.add_html_resource(
        _PREVIEW_RESOURCE_URI,
        _load_bundle("preview.html"),
        name="display-editor-preview",
        title="Display Editor Preview",
        description="Sandboxed canvas rendering of a project surface preview.",
    )

    @apps.tool(
        resource_uri=_PREVIEW_RESOURCE_URI,
        name="display_preview",
        annotations=READ_ONLY,
    )
    def display_preview(
        name: str,
        project_revision: str,
        surface: str = "root",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        """Read a paginated placement preview of one exact project revision."""
        return scoped_tool_result(
            ("project:read",),
            fallback,
            lambda _authorization: service.preview_project(
                name,
                project_revision,
                surface,
                limit,
                cursor,
            ),
        )


def _register_changeset_review(
    apps: Apps,
    service: AssistantToolService,
    fallback: MCPAuthorization | None,
) -> None:
    apps.add_html_resource(
        _REVIEW_RESOURCE_URI,
        _load_bundle("changeset-review.html"),
        name="display-editor-changeset-review",
        title="Display Editor Change-Set Review",
        description=(
            "Sandboxed diff review for a proposed change set, with an Apply "
            "button that calls display_changeset_apply through the bridge."
        ),
    )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_project_propose",
        annotations=PROPOSAL,
    )
    def display_project_propose(
        name: str,
        base_revision: str,
        operations: list[PlacementOperation],
    ) -> dict[str, Any]:
        """Create a validated, expiring project changeset without saving the project."""
        return scoped_tool_result(
            ("project:write",),
            fallback,
            lambda authorization: service.propose_project(
                name,
                base_revision,
                operations,
                identity=authorization.identity,
            ),
        )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_project_import_propose",
        annotations=PROPOSAL,
    )
    def display_project_import_propose(
        configuration_name: str,
        configuration_revision: str,
        project_name: str,
        canvas_width: int = 0,
        canvas_height: int = 0,
    ) -> dict[str, Any]:
        """Import exact-revision YAML into an expiring project-create changeset."""
        return scoped_tool_result(
            ("project:write", "configuration:read"),
            fallback,
            lambda authorization: service.propose_project_import(
                configuration_name,
                configuration_revision,
                project_name,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                identity=authorization.identity,
            ),
        )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_project_import_yaml_propose",
        annotations=PROPOSAL,
    )
    def display_project_import_yaml_propose(
        yaml_content: str,
        project_name: str,
        canvas_width: int = 0,
        canvas_height: int = 0,
        source_name: str = "",
    ) -> dict[str, Any]:
        """Import client-supplied inline YAML into an expiring project-create changeset."""
        return scoped_tool_result(
            ("project:write",),
            fallback,
            lambda authorization: service.propose_project_import_from_yaml(
                yaml_content,
                project_name,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                source_name=source_name,
                identity=authorization.identity,
            ),
        )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_configuration_draft_propose",
        annotations=PROPOSAL,
    )
    def display_configuration_draft_propose(
        project_name: str,
        project_revision: str,
        configuration_name: str,
        configuration_revision: str,
        draft_revision: str | None = None,
    ) -> dict[str, Any]:
        """Propose merging an exact project revision into a YAML draft."""
        return scoped_tool_result(
            ("project:read", "configuration:draft"),
            fallback,
            lambda authorization: service.propose_configuration_draft(
                project_name,
                project_revision,
                configuration_name,
                configuration_revision,
                draft_revision,
                identity=authorization.identity,
            ),
        )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_binding_propose",
        annotations=PROPOSAL,
    )
    def display_binding_propose(
        name: str,
        base_revision: str,
        operations: list[ProjectBindingOperation],
    ) -> dict[str, Any]:
        """Propose validated exportable project-binding changes without saving."""
        return scoped_tool_result(
            ("project:write",),
            fallback,
            lambda authorization: service.propose_project_bindings(
                name,
                base_revision,
                operations,
                identity=authorization.identity,
            ),
        )

    @apps.tool(
        resource_uri=_REVIEW_RESOURCE_URI,
        name="display_viewer_binding_propose",
        annotations=PROPOSAL,
    )
    def display_viewer_binding_propose(
        name: str,
        base_revision: str,
        operations: list[ViewerBindingOperation],
        viewer_base_revision: str | None = None,
    ) -> dict[str, Any]:
        """Propose revisioned Viewer-sidecar binding changes without saving."""
        return scoped_tool_result(
            ("project:write", "device:read"),
            fallback,
            lambda authorization: service.propose_viewer_bindings(
                name,
                base_revision,
                viewer_base_revision,
                operations,
                identity=authorization.identity,
            ),
        )
