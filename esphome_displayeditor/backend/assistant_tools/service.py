"""Bounded application operations for AI clients."""

from __future__ import annotations

import secrets
from typing import Any

from ..audit import AuditStore
from ..builder import BuilderManager
from ..designer import DesignerService
from ..errors import ApiError
from ..filesystem import FilesystemBackend
from ..project_store import ProjectStore
from ..runtime.registry import DeviceRegistry
from ..settings import Settings
from ..version import APP_VERSION
from ..viewer_bindings import ViewerBindingStore
from ..workflow import WorkflowStore
from .binding_operations import ProjectBindingOperation
from .limits import (
    MCP_ACTIVE_CHANGESET_LIMIT,
    MCP_ACTIVE_TOKEN_LIMIT,
    MCP_APPLIED_CHANGESET_RETENTION_SECONDS,
    MCP_BINDING_TARGET_SCAN_LIMIT,
    MCP_CHANGESET_PAYLOAD_MAX_BYTES,
    MCP_CHANGESET_RECORD_LIMIT,
    MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY,
    MCP_CHANGESET_STORAGE_MAX_BYTES,
    MCP_CHANGESET_TTL_SECONDS,
    MCP_COMPLETION_LIMIT,
    MCP_CONFIGURATION_CHUNK_CHARACTERS,
    MCP_DEVICE_SCAN_LIMIT,
    MCP_HEALTH_PROBE_TIMEOUT_SECONDS,
    MCP_HEALTH_RESPONSE_MAX_BYTES,
    MCP_PAGE_SIZE_LIMIT,
    MCP_OPERATIONS_PER_CHANGESET,
    MCP_PROJECT_LIST_LIMIT,
    MCP_REQUEST_MAX_BYTES,
    MCP_RESPONSE_MAX_BYTES,
    MCP_TREE_WIDGET_LIMIT,
    MCP_TOKEN_RECORD_LIMIT,
)
from .changesets import ChangeSetStore
from .configuration_drafts import ConfigurationDraftMutationService
from .device_discovery import DeviceDiscoveryService
from .firmware import FirmwareService
from .mutations import ProjectMutationService
from .operations import PlacementOperation
from .pagination import CursorCodec
from .preview import LayoutPreviewService
from .project_imports import ProjectImportMutationService
from .query import QueryService
from .viewer_binding_operations import ViewerBindingOperation
from .viewer_mutations import ViewerBindingMutationService


class AssistantToolService:
    """Expose domain operations without coupling them to an MCP transport.

    Mutation (change-set) operations live directly on this facade; bounded
    read-only projections are delegated to :class:`QueryService` to keep this
    module under the project's backend line limit.
    """

    def __init__(self, settings: Settings, *, builder: BuilderManager | None = None) -> None:
        self.settings = settings
        self.designer = DesignerService(settings.data_root)
        self.filesystem = FilesystemBackend(settings)
        self.projects = ProjectStore(
            settings.data_root,
            self.designer,
            settings.max_file_size,
        )
        self.audit = AuditStore(settings.data_root)
        self.workflow = WorkflowStore(settings.data_root)
        self.changesets = ChangeSetStore(settings.data_root)
        self.viewer_bindings = ViewerBindingStore(settings.data_root)
        self.device_registry = DeviceRegistry(settings.data_root)
        self.device_discovery = DeviceDiscoveryService(
            self.device_registry,
            runtime_available=settings.runtime_provider == "native",
        )
        self.layout_previews = LayoutPreviewService(self.projects)
        self.cursors = CursorCodec(
            settings.mcp_access_token or secrets.token_hex(32)
        )
        self.mutations = ProjectMutationService(
            settings,
            self.projects,
            self.audit,
            self.changesets,
        )
        self.viewer_mutations = ViewerBindingMutationService(
            settings,
            self.projects,
            self.viewer_bindings,
            self.device_registry,
            self.audit,
            self.changesets,
        )
        self.project_imports = ProjectImportMutationService(
            settings,
            self.filesystem,
            self.projects,
            self.audit,
            self.changesets,
        )
        self.configuration_drafts = ConfigurationDraftMutationService(
            settings,
            self.filesystem,
            self.projects,
            self.audit,
            self.changesets,
        )
        self.query = QueryService(
            designer=self.designer,
            projects=self.projects,
            filesystem=self.filesystem,
            viewer_bindings=self.viewer_bindings,
            device_registry=self.device_registry,
            device_discovery=self.device_discovery,
            layout_previews=self.layout_previews,
            cursors=self.cursors,
        )
        self.firmware = FirmwareService(
            settings,
            self.filesystem,
            self.workflow,
            self.audit,
            builder=builder,
        )

    def server_info(self) -> dict[str, Any]:
        return {
            "name": "ESPHome Display Editor",
            "version": APP_VERSION,
            "access": self.settings.mcp_access,
            "mode": self.settings.mcp_mode,
            "features": {
                "project_discovery": True,
                "project_inspection": True,
                "project_validation": True,
                "structured_preview": True,
                "widget_catalog": True,
                "project_mutation": self.settings.mcp_access == "project_write",
                "project_binding_mutation": (
                    self.settings.mcp_access == "project_write"
                ),
                "viewer_binding_mutation": (
                    self.settings.mcp_access == "project_write"
                ),
                "configuration_read": True,
                "yaml_import": self.settings.mcp_access == "project_write",
                "yaml_export": True,
                "yaml_merge_preview": True,
                "yaml_merge_draft": self.settings.mcp_access == "project_write",
                "binding_target_suggestions": True,
                "device_registry_read": True,
                "device_live_read": False,
                "managed_client_tokens": True,
                "request_scopes": True,
                "prompts": True,
                "completions": True,
            },
            "limits": {
                "request_bytes": MCP_REQUEST_MAX_BYTES,
                "response_bytes": MCP_RESPONSE_MAX_BYTES,
                "project_file_bytes": self.settings.max_file_size,
                "projects_per_request": MCP_PROJECT_LIST_LIMIT,
                "page_size": MCP_PAGE_SIZE_LIMIT,
                "binding_target_scan": MCP_BINDING_TARGET_SCAN_LIMIT,
                "device_scan": MCP_DEVICE_SCAN_LIMIT,
                "completion_values": MCP_COMPLETION_LIMIT,
                "widgets_per_tree": MCP_TREE_WIDGET_LIMIT,
                "configuration_chunk_characters": (
                    MCP_CONFIGURATION_CHUNK_CHARACTERS
                ),
                "requests_per_minute": self.settings.api_rate_limit_per_minute,
                "changeset_ttl_seconds": MCP_CHANGESET_TTL_SECONDS,
                "applied_changeset_retention_seconds": (
                    MCP_APPLIED_CHANGESET_RETENTION_SECONDS
                ),
                "active_changesets": MCP_ACTIVE_CHANGESET_LIMIT,
                "stored_changesets_per_client": (
                    MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY
                ),
                "stored_changesets": MCP_CHANGESET_RECORD_LIMIT,
                "changeset_payload_bytes": MCP_CHANGESET_PAYLOAD_MAX_BYTES,
                "changeset_storage_bytes": MCP_CHANGESET_STORAGE_MAX_BYTES,
                "active_client_tokens": MCP_ACTIVE_TOKEN_LIMIT,
                "stored_token_records": MCP_TOKEN_RECORD_LIMIT,
                "listener_probe_timeout_seconds": MCP_HEALTH_PROBE_TIMEOUT_SECONDS,
                "listener_probe_response_bytes": MCP_HEALTH_RESPONSE_MAX_BYTES,
                "operations_per_changeset": MCP_OPERATIONS_PER_CHANGESET,
            },
        }

    # -- Mutation (change-set) operations -----------------------------------

    def propose_project(
        self,
        name: str,
        base_revision: str,
        operations: list[PlacementOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        return self.mutations.propose(
            name,
            base_revision,
            operations,
            identity=identity,
        )

    def read_changeset(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        return self.mutations.read(change_set_id, identity=identity)

    def propose_project_bindings(
        self,
        name: str,
        base_revision: str,
        operations: list[ProjectBindingOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        return self.mutations.propose_bindings(
            name,
            base_revision,
            operations,
            identity=identity,
        )

    def apply_changeset(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        record = self.changesets.read(change_set_id, identity)
        if record["target_kind"] == "viewer_bindings":
            return self.viewer_mutations.apply(change_set_id, identity=identity)
        if record["target_kind"] == "project_create":
            return self.project_imports.apply(change_set_id, identity=identity)
        if record["target_kind"] == "configuration_draft":
            return self.configuration_drafts.apply(change_set_id, identity=identity)
        return self.mutations.apply(change_set_id, identity=identity)

    def propose_configuration_draft(
        self,
        project_name: str,
        project_revision: str,
        configuration_name: str,
        configuration_revision: str,
        draft_revision: str | None,
        *,
        identity: str,
    ) -> dict[str, Any]:
        return self.configuration_drafts.propose(
            project_name,
            project_revision,
            configuration_name,
            configuration_revision,
            draft_revision,
            identity=identity,
        )

    def propose_viewer_bindings(
        self,
        name: str,
        base_revision: str,
        viewer_base_revision: str | None,
        operations: list[ViewerBindingOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        return self.viewer_mutations.propose(
            name,
            base_revision,
            viewer_base_revision,
            operations,
            identity=identity,
        )

    def propose_project_import(
        self,
        configuration_name: str,
        configuration_revision: str,
        project_name: str,
        *,
        canvas_width: int = 0,
        canvas_height: int = 0,
        identity: str,
    ) -> dict[str, Any]:
        return self.project_imports.propose(
            configuration_name,
            configuration_revision,
            project_name,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            identity=identity,
        )

    def propose_project_import_from_yaml(
        self,
        yaml_content: str,
        project_name: str,
        *,
        canvas_width: int = 0,
        canvas_height: int = 0,
        source_name: str = "",
        identity: str,
    ) -> dict[str, Any]:
        return self.project_imports.propose_from_yaml(
            yaml_content,
            project_name,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            source_name=source_name,
            identity=identity,
        )

    def publish_configuration(
        self,
        name: str,
        expected_revision: str,
        *,
        identity: str,
    ) -> dict[str, Any]:
        """Publish an already-reviewed draft as the active ESPHome YAML.

        Unlike the change-set tools, this has no separate propose step: the
        draft's content was already reviewed when it was created or merged
        via ``display_configuration_draft_propose`` /
        ``display_changeset_apply``. Publishing is the further, deliberately
        separate and revision-checked step that makes it active, mirroring
        the app's own ``configuration.publish`` capability.
        """
        if self.settings.mcp_access != "project_write" or self.settings.access_level not in {
            "write",
            "write_with_builder",
        }:
            raise ApiError(
                "mcp_write_disabled",
                "MCP project writes are disabled by the app configuration.",
                403,
            )
        try:
            result = self.filesystem.publish(name, expected_revision)
        except ApiError as exc:
            self.audit.record(
                user_id=identity,
                action="mcp.configuration.publish",
                configuration=name,
                old_revision=expected_revision,
                new_revision=None,
                result=exc.error,
            )
            raise
        self.workflow.invalidate_validation(name)
        self.audit.record(
            user_id=identity,
            action="mcp.configuration.publish",
            configuration=name,
            old_revision=result["old_revision"],
            new_revision=result["revision"],
            result="success",
        )
        return result

    # Firmware validate/compile/install operations are exposed directly via
    # ``self.firmware`` (a ``FirmwareService``) rather than facade methods
    # here: they are the only async operations on this service (the Device
    # Builder is WebSocket-backed and must run on the MCP server's own event
    # loop, see firmware.py), and mirroring every one of its methods as a
    # one-line wrapper would push this module over the backend line limit.

    # -- Read-only projections, delegated to QueryService --------------------

    def list_projects(self, limit: int = 50, cursor: str = "") -> dict[str, Any]:
        return self.query.list_projects(limit, cursor)

    def preview_project(
        self,
        name: str,
        project_revision: str,
        surface: str = "root",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        return self.query.preview_project(name, project_revision, surface, limit, cursor)

    def list_devices(self, limit: int = 50, cursor: str = "") -> dict[str, Any]:
        return self.query.list_devices(limit, cursor)

    def read_device(self, device_id: str) -> dict[str, Any]:
        return self.query.read_device(device_id)

    def list_configurations(
        self, limit: int = 50, cursor: str = ""
    ) -> dict[str, Any]:
        return self.query.list_configurations(limit, cursor)

    def read_configuration(
        self,
        name: str,
        offset: int = 0,
        max_characters: int = MCP_CONFIGURATION_CHUNK_CHARACTERS,
        source: str = "active",
    ) -> dict[str, Any]:
        return self.query.read_configuration(name, offset, max_characters, source)

    def binding_targets(
        self,
        name: str,
        target: str = "widgets",
        direction: str = "entity_to_widget",
        entity_domain: str = "",
        entity_id: str = "",
        widget_id: str = "",
        query: str = "",
        limit: int = 50,
        cursor: str = "",
    ) -> dict[str, Any]:
        return self.query.binding_targets(
            name,
            target,
            direction,
            entity_domain,
            entity_id,
            widget_id,
            query,
            limit,
            cursor,
        )

    def transform_yaml(
        self,
        name: str,
        project_revision: str,
        mode: str = "export",
        configuration_name: str = "",
        configuration_revision: str = "",
        offset: int = 0,
        max_characters: int = MCP_CONFIGURATION_CHUNK_CHARACTERS,
    ) -> dict[str, Any]:
        return self.query.transform_yaml(
            name,
            project_revision,
            mode,
            configuration_name,
            configuration_revision,
            offset,
            max_characters,
        )

    def complete_argument(
        self,
        argument_name: str,
        partial: str = "",
        context: dict[str, str] | None = None,
        *,
        resource_reference: str = "",
    ) -> dict[str, Any]:
        return self.query.complete_argument(
            argument_name,
            partial,
            context,
            resource_reference=resource_reference,
        )

    def catalog(
        self,
        kind: str = "widgets",
        language: str = "de",
        widget_type: str = "",
    ) -> dict[str, Any]:
        return self.query.catalog(kind, language, widget_type)

    def read_project(
        self,
        name: str,
        view: str = "summary",
        widget_id: str = "",
    ) -> dict[str, Any]:
        return self.query.read_project(name, view, widget_id)

    def validate_project(self, name: str) -> dict[str, Any]:
        return self.query.validate_project(name)

    def list_project_revisions(self, name: str, limit: int = 10) -> dict[str, Any]:
        return self.query.list_revisions(name, limit)

    def read_project_revision(
        self,
        name: str,
        revision_id: int,
        view: str = "summary",
        against: str = "current",
    ) -> dict[str, Any]:
        return self.query.read_revision(name, revision_id, view, against)
