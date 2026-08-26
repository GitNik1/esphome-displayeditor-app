"""Proposal/apply workflow for revisioned Viewer binding sidecars."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..audit import AuditStore
from ..errors import ApiError
from ..project_locks import project_file_lock
from ..project_store import ProjectStore
from ..runtime.registry import DeviceRegistry
from ..settings import Settings
from ..viewer_bindings import ViewerBindingStore
from .changesets import ChangeSetStore
from .limits import MCP_OPERATIONS_PER_CHANGESET
from .viewer_binding_operations import (
    ViewerBindingOperation,
    viewer_binding_operation_payload,
)
from .viewer_binding_service import ViewerBindingService

_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
_OPERATIONS = TypeAdapter(list[ViewerBindingOperation])


class ViewerBindingMutationService:
    def __init__(
        self,
        settings: Settings,
        projects: ProjectStore,
        bindings: ViewerBindingStore,
        registry: DeviceRegistry,
        audit: AuditStore,
        changesets: ChangeSetStore,
    ) -> None:
        self.settings = settings
        self.projects = projects
        self.bindings = bindings
        self.registry = registry
        self.audit = audit
        self.changesets = changesets
        self.operations = ViewerBindingService()

    def propose(
        self,
        name: str,
        base_revision: str,
        viewer_base_revision: str | None,
        operations: list[ViewerBindingOperation | dict[str, Any]],
        *,
        identity: str,
    ) -> dict[str, Any]:
        self._require_write_access()
        self._validate_revision(base_revision, "base_revision", optional=False)
        self._validate_revision(
            viewer_base_revision, "viewer_base_revision", optional=True
        )
        normalized = self._validate_operations(operations)
        try:
            project = self.projects.read(name)
            if project["revision"] != base_revision:
                self._conflict(
                    "project", base_revision, project["revision"], "The project changed."
                )
            current = self.bindings.read(name)
            if current["revision"] != viewer_base_revision:
                self._conflict(
                    "viewer_bindings",
                    viewer_base_revision,
                    current["revision"],
                    "Viewer bindings changed after they were read.",
                )
            proposed, preview = self.operations.apply(
                project["project"],
                current["bindings"],
                normalized,
                device_lookup=self.registry.get,
            )
            preview["stored_viewer_binding_bytes"] = len(
                json.dumps(
                    {"version": 1, "bindings": proposed},
                    ensure_ascii=False,
                    indent=2,
                ).encode("utf-8")
            ) + 1
            result = self.changesets.create(
                identity=identity,
                project_name=name,
                base_revision=base_revision,
                operations=normalized,
                project=project["project"],
                preview=preview,
                target_kind="viewer_bindings",
                viewer_base_revision=viewer_base_revision,
                viewer_bindings=proposed,
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.viewer_binding.propose",
                name,
                viewer_base_revision,
                None,
                exc.error,
                {"operation_count": len(normalized)},
            )
            raise
        self._audit(
            identity,
            "mcp.viewer_binding.propose",
            name,
            viewer_base_revision,
            None,
            "success",
            {
                "change_set_id": result["change_set_id"],
                "operation_count": len(normalized),
                "project_revision": base_revision,
            },
        )
        return result

    def apply(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        self._require_write_access()
        record = self.changesets.payload(change_set_id, identity)
        if record["target_kind"] != "viewer_bindings":
            raise ApiError(
                "changeset_target_mismatch",
                "This changeset does not target Viewer bindings.",
                422,
            )
        if record["status"] == "applied":
            record.pop("project", None)
            record.pop("viewer_bindings", None)
            return {**record, "idempotent": True}
        name = record["project_name"]
        expected = record["viewer_base_revision"]
        try:
            with project_file_lock(self.projects.root, name):
                persisted = self._persist_locked(record, identity, change_set_id)
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.changeset.apply",
                name,
                expected,
                None,
                exc.error,
                {"change_set_id": change_set_id, "target": "viewer_bindings"},
            )
            raise
        if isinstance(persisted, dict):
            return persisted
        applied, saved = persisted
        self._audit(
            identity,
            "mcp.changeset.apply",
            name,
            saved["old_revision"],
            saved["revision"],
            "success",
            {"change_set_id": change_set_id, "target": "viewer_bindings"},
        )
        return {**applied, "idempotent": False}

    def _persist_locked(
        self,
        record: dict[str, Any],
        identity: str,
        change_set_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any]] | dict[str, Any]:
        name = record["project_name"]
        expected = record["viewer_base_revision"]
        proposed = record["viewer_bindings"]
        project = self.projects.read(name)
        if project["revision"] != record["base_revision"]:
            self._conflict(
                "project",
                record["base_revision"],
                project["revision"],
                "The project changed after this changeset was proposed.",
            )
        current = self.bindings.read(name)
        if current["revision"] != expected:
            if current["bindings"] == proposed:
                return self._mark_idempotent(
                    record, identity, change_set_id, current["revision"]
                )
            self._conflict(
                "viewer_bindings",
                expected,
                current["revision"],
                "Viewer bindings changed after this changeset was proposed.",
            )
        try:
            saved = self.bindings.save(name, proposed, expected)
        except ApiError as exc:
            if exc.error == "revision_conflict":
                latest = self.bindings.read(name)
                if latest["bindings"] == proposed:
                    return self._mark_idempotent(
                        record, identity, change_set_id, latest["revision"]
                    )
            raise
        applied = self.changesets.mark_applied(
            change_set_id, identity, saved["revision"]
        )
        return applied, saved

    def _mark_idempotent(
        self,
        record: dict[str, Any],
        identity: str,
        change_set_id: str,
        revision: str,
    ) -> dict[str, Any]:
        recovered = self.changesets.mark_applied(
            change_set_id, identity, revision
        )
        self._audit(
            identity,
            "mcp.changeset.apply",
            record["project_name"],
            record["viewer_base_revision"],
            revision,
            "idempotent",
            {"change_set_id": change_set_id, "target": "viewer_bindings"},
        )
        return {**recovered, "idempotent": True}

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
    def _validate_revision(value: str | None, name: str, *, optional: bool) -> None:
        if value is None and optional:
            return
        if not isinstance(value, str) or not _REVISION.fullmatch(value):
            raise ApiError("invalid_revision", f"{name} is malformed.", 422)

    @staticmethod
    def _validate_operations(
        operations: list[ViewerBindingOperation | dict[str, Any]],
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
                "One or more Viewer binding operations are malformed.",
                422,
                {"errors": errors},
            ) from exc
        return [viewer_binding_operation_payload(operation) for operation in validated]

    @staticmethod
    def _conflict(
        target: str,
        expected: str | None,
        actual: str | None,
        message: str,
    ) -> None:
        raise ApiError(
            "revision_conflict",
            message,
            409,
            {
                "target": target,
                "expected_revision": expected,
                "actual_revision": actual,
            },
        )

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
