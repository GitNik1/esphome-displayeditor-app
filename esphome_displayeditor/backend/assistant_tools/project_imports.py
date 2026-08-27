"""Revisioned YAML-to-project import proposals for machine-driven clients."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from ..audit import AuditStore
from ..errors import ApiError
from ..filesystem import FilesystemBackend, revision_for
from ..project_store import ProjectStore
from ..settings import Settings
from .changesets import ChangeSetStore
from .secrets_guard import assert_not_secrets_file

_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")


class ProjectImportMutationService:
    def __init__(
        self,
        settings: Settings,
        filesystem: FilesystemBackend,
        projects: ProjectStore,
        audit: AuditStore,
        changesets: ChangeSetStore,
    ) -> None:
        self.settings = settings
        self.filesystem = filesystem
        self.projects = projects
        self.audit = audit
        self.changesets = changesets

    def propose(
        self,
        configuration_name: str,
        configuration_revision: str,
        project_name: str,
        *,
        canvas_width: int = 0,
        canvas_height: int = 0,
        identity: str,
    ) -> dict[str, Any]:
        self._require_write_access()
        assert_not_secrets_file(configuration_name)
        if not _REVISION.fullmatch(configuration_revision):
            raise ApiError(
                "invalid_revision", "configuration_revision is malformed.", 422
            )
        canvas = self._canvas(canvas_width, canvas_height)
        try:
            self._require_project_absent(project_name)
            source = self.filesystem.read_config(configuration_name)
            if source["revision"] != configuration_revision:
                self._conflict(configuration_revision, source["revision"])
            imported = self.projects.designer.import_yaml(
                source["content"],
                canvas=canvas,
                source_name=source["name"],
            )
            if not imported["valid"]:
                raise ApiError(
                    "import_failed",
                    "The YAML configuration contains blocking import issues.",
                    422,
                    {"issues": imported["issues"][:50]},
                )
            prepared = self.projects.prepare(imported["project"])
            all_issues = imported["issues"] + prepared["issues"]
            issue_counts = Counter(
                str(issue.get("severity", "unknown")) for issue in all_issues
            )
            preview = {
                "configuration_name": source["name"],
                "configuration_revision": source["revision"],
                "project_name": project_name,
                "stats": imported["stats"],
                "stored_project_bytes": prepared["size"],
                "issue_counts": dict(issue_counts),
                "issues": all_issues[:100],
            }
            result = self.changesets.create(
                identity=identity,
                project_name=project_name,
                base_revision=configuration_revision,
                operations=[
                    {
                        "op": "import_yaml_project",
                        "configuration_name": source["name"],
                        "configuration_revision": source["revision"],
                        "canvas": (
                            {"width": canvas[0], "height": canvas[1]}
                            if canvas is not None
                            else None
                        ),
                    }
                ],
                project=prepared["project"],
                preview=preview,
                target_kind="project_create",
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.project_import.propose",
                project_name,
                configuration_revision,
                None,
                exc.error,
                {"configuration_name": configuration_name},
            )
            raise
        self._audit(
            identity,
            "mcp.project_import.propose",
            project_name,
            configuration_revision,
            None,
            "success",
            {
                "configuration_name": source["name"],
                "change_set_id": result["change_set_id"],
            },
        )
        return result

    def propose_from_yaml(
        self,
        yaml_content: str,
        project_name: str,
        *,
        canvas_width: int = 0,
        canvas_height: int = 0,
        source_name: str = "",
        identity: str,
    ) -> dict[str, Any]:
        """Import inline YAML text a client supplies directly (no stored config).

        Unlike ``propose``, there is no filesystem revision to re-check at
        apply time: the imported project is already fully computed and
        stored in the changeset, so applying it only needs to confirm the
        target project name is still free (or byte-identical, for a safe
        idempotent retry).
        """
        self._require_write_access()
        if not isinstance(yaml_content, str) or not yaml_content.strip():
            raise ApiError(
                "invalid_yaml_content", "yaml_content must be non-empty text.", 422
            )
        content_bytes = yaml_content.encode("utf-8")
        if len(content_bytes) > self.settings.max_file_size:
            raise ApiError(
                "yaml_content_too_large",
                "yaml_content exceeds the configured maximum configuration size.",
                413,
                {"maximum_bytes": self.settings.max_file_size},
            )
        label = source_name.strip() or "mcp-upload.yaml"
        if len(label) > 128 or "/" in label or "\\" in label:
            raise ApiError("invalid_source_name", "source_name is invalid.", 422)
        canvas = self._canvas(canvas_width, canvas_height)
        content_revision = revision_for(yaml_content)
        try:
            self._require_project_absent(project_name)
            imported = self.projects.designer.import_yaml(
                yaml_content,
                canvas=canvas,
                source_name=label,
            )
            if not imported["valid"]:
                raise ApiError(
                    "import_failed",
                    "The YAML configuration contains blocking import issues.",
                    422,
                    {"issues": imported["issues"][:50]},
                )
            prepared = self.projects.prepare(imported["project"])
            all_issues = imported["issues"] + prepared["issues"]
            issue_counts = Counter(
                str(issue.get("severity", "unknown")) for issue in all_issues
            )
            preview = {
                "source_name": label,
                "project_name": project_name,
                "stats": imported["stats"],
                "stored_project_bytes": prepared["size"],
                "issue_counts": dict(issue_counts),
                "issues": all_issues[:100],
            }
            result = self.changesets.create(
                identity=identity,
                project_name=project_name,
                base_revision=content_revision,
                operations=[
                    {
                        "op": "import_yaml_project_raw",
                        "source_name": label,
                        "content_revision": content_revision,
                        "canvas": (
                            {"width": canvas[0], "height": canvas[1]}
                            if canvas is not None
                            else None
                        ),
                    }
                ],
                project=prepared["project"],
                preview=preview,
                target_kind="project_create",
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.project_import_raw.propose",
                project_name,
                content_revision,
                None,
                exc.error,
                {"source_name": label},
            )
            raise
        self._audit(
            identity,
            "mcp.project_import_raw.propose",
            project_name,
            content_revision,
            None,
            "success",
            {"source_name": label, "change_set_id": result["change_set_id"]},
        )
        return result

    def apply(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        self._require_write_access()
        record = self.changesets.payload(change_set_id, identity)
        if record["target_kind"] != "project_create":
            raise ApiError(
                "changeset_target_mismatch",
                "This changeset does not create a designer project.",
                422,
            )
        if record["status"] == "applied":
            record.pop("project", None)
            return {**record, "idempotent": True}
        name = record["project_name"]
        operation = record["operations"][0]
        is_raw_upload = operation.get("op") == "import_yaml_project_raw"
        audit_source = (
            {"source_name": operation.get("source_name")}
            if is_raw_upload
            else {"configuration_name": operation.get("configuration_name")}
        )
        try:
            existing = self._read_existing(name)
            if existing is not None:
                if existing["project"] == record["project"]:
                    return self._mark_idempotent(
                        record, identity, change_set_id, existing["revision"]
                    )
                raise ApiError(
                    "project_exists",
                    "A different project already uses this name.",
                    409,
                    {"actual_revision": existing["revision"]},
                )
            if not is_raw_upload:
                # A stored configuration can drift within the changeset TTL;
                # raw-upload content is immutable inside the changeset
                # itself, so there is nothing external left to re-verify.
                assert_not_secrets_file(operation["configuration_name"])
                source = self.filesystem.read_config(operation["configuration_name"])
                if source["revision"] != record["base_revision"]:
                    self._conflict(record["base_revision"], source["revision"])
            try:
                saved = self.projects.save(
                    name,
                    record["project"],
                    None,
                    actor=identity,
                    origin="mcp_import",
                )
            except ApiError as exc:
                if exc.error == "project_exists":
                    latest = self.projects.read(name)
                    if latest["project"] == record["project"]:
                        return self._mark_idempotent(
                            record, identity, change_set_id, latest["revision"]
                        )
                raise
            applied = self.changesets.mark_applied(
                change_set_id, identity, saved["revision"]
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.changeset.apply",
                name,
                record["base_revision"],
                None,
                exc.error,
                {
                    "change_set_id": change_set_id,
                    "target": "project_create",
                    **audit_source,
                },
            )
            raise
        self._audit(
            identity,
            "mcp.changeset.apply",
            name,
            None,
            saved["revision"],
            "success",
            {"change_set_id": change_set_id, "target": "project_create"},
        )
        return {**applied, "idempotent": False}

    def _require_project_absent(self, name: str) -> None:
        existing = self._read_existing(name)
        if existing is not None:
            raise ApiError(
                "project_exists",
                "A project with this name already exists.",
                409,
                {"actual_revision": existing["revision"]},
            )

    def _read_existing(self, name: str) -> dict[str, Any] | None:
        try:
            return self.projects.read(name)
        except ApiError as exc:
            if exc.error == "project_not_found":
                return None
            raise

    def _mark_idempotent(
        self,
        record: dict[str, Any],
        identity: str,
        change_set_id: str,
        revision: str,
    ) -> dict[str, Any]:
        applied = self.changesets.mark_applied(change_set_id, identity, revision)
        self._audit(
            identity,
            "mcp.changeset.apply",
            record["project_name"],
            None,
            revision,
            "idempotent",
            {"change_set_id": change_set_id, "target": "project_create"},
        )
        return {**applied, "idempotent": True}

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
    def _canvas(width: int, height: int) -> tuple[int, int] | None:
        if width == 0 and height == 0:
            return None
        if not (1 <= width <= 4096 and 1 <= height <= 4096):
            raise ApiError(
                "invalid_canvas",
                "Canvas width and height must both be between 1 and 4096.",
                422,
            )
        return width, height

    @staticmethod
    def _conflict(expected: str, actual: str) -> None:
        raise ApiError(
            "revision_conflict",
            "The source configuration changed after it was read.",
            409,
            {
                "target": "configuration",
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
