"""Validated proposal/apply workflow for MCP project mutations."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..api.viewer_projection import project_widget_types
from ..audit import AuditStore
from ..errors import ApiError
from ..project_store import ProjectStore
from ..settings import Settings
from .binding_operations import (
    ProjectBindingOperation,
    binding_operation_payload,
)
from .changesets import ChangeSetStore
from .limits import MCP_OPERATIONS_PER_CHANGESET
from .operations import PlacementOperation, operation_payload
from .placement import PlacementService
from .project_bindings import ProjectBindingService

_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
_OPERATIONS = TypeAdapter(list[PlacementOperation])
_BINDING_OPERATIONS = TypeAdapter(list[ProjectBindingOperation])


class ProjectMutationService:
    def __init__(
        self,
        settings: Settings,
        projects: ProjectStore,
        audit: AuditStore,
        changesets: ChangeSetStore,
    ) -> None:
        self.settings = settings
        self.projects = projects
        self.audit = audit
        self.changesets = changesets
        self.placement = PlacementService()
        self.project_bindings = ProjectBindingService()

    def propose(
        self,
        name: str,
        base_revision: str,
        operations: list[PlacementOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        self._require_write_access()
        if not _REVISION.fullmatch(base_revision):
            raise ApiError("invalid_revision", "base_revision is malformed.", 422)
        normalized = self._validate_operations(operations)
        try:
            loaded = self.projects.read(name)
            if loaded["revision"] != base_revision:
                raise ApiError(
                    "revision_conflict",
                    "The project changed after the supplied base revision.",
                    409,
                    {
                        "expected_revision": base_revision,
                        "actual_revision": loaded["revision"],
                    },
                )
            proposed, placement_preview = self.placement.apply(
                loaded["project"], normalized
            )
            prepared = self.projects.prepare(proposed)
            preview = self._preview(
                loaded["project"],
                prepared["project"],
                placement_preview,
                prepared["issues"],
                prepared["size"],
            )
            result = self.changesets.create(
                identity=identity,
                project_name=name,
                base_revision=base_revision,
                operations=normalized,
                project=prepared["project"],
                preview=preview,
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.project.propose",
                name,
                base_revision,
                None,
                exc.error,
                {"operation_count": len(normalized)},
            )
            raise
        self._audit(
            identity,
            "mcp.project.propose",
            name,
            base_revision,
            None,
            "success",
            {
                "change_set_id": result["change_set_id"],
                "operation_count": len(normalized),
            },
        )
        return result

    def propose_bindings(
        self,
        name: str,
        base_revision: str,
        operations: list[ProjectBindingOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        self._require_write_access()
        if not _REVISION.fullmatch(base_revision):
            raise ApiError("invalid_revision", "base_revision is malformed.", 422)
        normalized = self._validate_binding_operations(operations)
        try:
            loaded = self.projects.read(name)
            if loaded["revision"] != base_revision:
                raise ApiError(
                    "revision_conflict",
                    "The project changed after the supplied base revision.",
                    409,
                    {
                        "expected_revision": base_revision,
                        "actual_revision": loaded["revision"],
                    },
                )
            proposed, binding_preview = self.project_bindings.apply(
                loaded["project"], normalized
            )
            prepared = self.projects.prepare(proposed)
            preview = self._preview(
                loaded["project"],
                prepared["project"],
                binding_preview,
                prepared["issues"],
                prepared["size"],
            )
            result = self.changesets.create(
                identity=identity,
                project_name=name,
                base_revision=base_revision,
                operations=normalized,
                project=prepared["project"],
                preview=preview,
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.binding.propose",
                name,
                base_revision,
                None,
                exc.error,
                {"operation_count": len(normalized)},
            )
            raise
        self._audit(
            identity,
            "mcp.binding.propose",
            name,
            base_revision,
            None,
            "success",
            {
                "change_set_id": result["change_set_id"],
                "operation_count": len(normalized),
            },
        )
        return result

    def read(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        return self.changesets.read(change_set_id, identity)

    def apply(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        self._require_write_access()
        record = self.changesets.payload(change_set_id, identity)
        if record["target_kind"] != "project":
            raise ApiError(
                "changeset_target_mismatch",
                "This changeset does not target the designer project.",
                422,
            )
        if record["status"] == "applied":
            record.pop("project", None)
            return {**record, "idempotent": True}
        name = record["project_name"]
        try:
            current = self.projects.read(name)
            if current["revision"] != record["base_revision"]:
                if current["project"] == record["project"]:
                    applied = self.changesets.mark_applied(
                        change_set_id, identity, current["revision"]
                    )
                    self._audit(
                        identity,
                        "mcp.changeset.apply",
                        name,
                        record["base_revision"],
                        current["revision"],
                        "idempotent",
                        {"change_set_id": change_set_id},
                    )
                    return {**applied, "idempotent": True}
                raise ApiError(
                    "revision_conflict",
                    "The project changed after this changeset was proposed.",
                    409,
                    {
                        "expected_revision": record["base_revision"],
                        "actual_revision": current["revision"],
                    },
                )
            saved = self.projects.save(
                name,
                record["project"],
                record["base_revision"],
            )
            applied = self.changesets.mark_applied(
                change_set_id,
                identity,
                saved["revision"],
            )
        except ApiError as exc:
            # Another process may have completed this exact changeset between the
            # optimistic read above and the locked compare-and-swap in save().
            if exc.error == "revision_conflict":
                latest = self.projects.read(name)
                if latest["project"] == record["project"]:
                    recovered = self.changesets.mark_applied(
                        change_set_id,
                        identity,
                        latest["revision"],
                    )
                    self._audit(
                        identity,
                        "mcp.changeset.apply",
                        name,
                        record["base_revision"],
                        latest["revision"],
                        "idempotent",
                        {"change_set_id": change_set_id},
                    )
                    return {**recovered, "idempotent": True}
            self._audit(
                identity,
                "mcp.changeset.apply",
                name,
                record["base_revision"],
                None,
                exc.error,
                {"change_set_id": change_set_id},
            )
            raise
        self._audit(
            identity,
            "mcp.changeset.apply",
            name,
            saved["old_revision"],
            saved["revision"],
            "success",
            {"change_set_id": change_set_id},
        )
        return {**applied, "idempotent": False}

    def _require_write_access(self) -> None:
        if self.settings.mcp_access != "project_write" or self.settings.access_level not in {
            "write",
            "write_with_builder",
        }:
            raise ApiError(
                "mcp_write_disabled",
                "MCP project writes are disabled by the app configuration.",
                403,
            )

    @staticmethod
    def _validate_operations(
        operations: list[PlacementOperation | dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not isinstance(operations, list) or not operations:
            raise ApiError("empty_changeset", "At least one operation is required.", 422)
        if len(operations) > MCP_OPERATIONS_PER_CHANGESET:
            raise ApiError(
                "operation_limit_exceeded",
                "The changeset contains too many operations.",
                413,
                {"maximum": MCP_OPERATIONS_PER_CHANGESET},
            )
        try:
            validated = _OPERATIONS.validate_python(operations)
        except ValidationError as exc:
            errors = [
                {
                    "location": list(error["loc"]),
                    "type": error["type"],
                    "message": error["msg"],
                }
                for error in exc.errors(include_url=False, include_input=False)[:20]
            ]
            raise ApiError(
                "invalid_operation_schema",
                "One or more placement operations are malformed.",
                422,
                {"errors": errors},
            ) from exc
        return [operation_payload(operation) for operation in validated]

    @staticmethod
    def _validate_binding_operations(
        operations: list[ProjectBindingOperation | dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not isinstance(operations, list) or not operations:
            raise ApiError("empty_changeset", "At least one operation is required.", 422)
        if len(operations) > MCP_OPERATIONS_PER_CHANGESET:
            raise ApiError(
                "operation_limit_exceeded",
                "The changeset contains too many operations.",
                413,
                {"maximum": MCP_OPERATIONS_PER_CHANGESET},
            )
        try:
            validated = _BINDING_OPERATIONS.validate_python(operations)
        except ValidationError as exc:
            errors = [
                {
                    "location": list(error["loc"]),
                    "type": error["type"],
                    "message": error["msg"],
                }
                for error in exc.errors(include_url=False, include_input=False)[:20]
            ]
            raise ApiError(
                "invalid_operation_schema",
                "One or more binding operations are malformed.",
                422,
                {"errors": errors},
            ) from exc
        return [binding_operation_payload(operation) for operation in validated]

    @staticmethod
    def _preview(
        before: dict[str, Any],
        after: dict[str, Any],
        placement: dict[str, Any],
        issues: list[dict],
        stored_size: int,
    ) -> dict[str, Any]:
        before_types = project_widget_types(before)
        after_types = project_widget_types(after)
        issue_counts = Counter(str(issue.get("severity", "unknown")) for issue in issues)
        return {
            **placement,
            "widget_count": {
                "before": len(before_types),
                "after": len(after_types),
            },
            "added_widget_ids": sorted(set(after_types) - set(before_types)),
            "removed_widget_ids": sorted(set(before_types) - set(after_types)),
            "stored_project_bytes": stored_size,
            "issue_counts": dict(issue_counts),
            "issues": issues,
        }

    def _audit(
        self,
        identity: str,
        action: str,
        name: str,
        old_revision: str | None,
        new_revision: str | None,
        result: str,
        metadata: dict[str, Any],
    ) -> None:
        self.audit.record(
            user_id=identity,
            action=action,
            configuration=name,
            old_revision=old_revision,
            new_revision=new_revision,
            result=result,
            metadata=metadata,
        )
