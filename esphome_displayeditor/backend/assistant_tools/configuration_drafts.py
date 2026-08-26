"""Revision-protected project-to-configuration draft change sets."""

from __future__ import annotations

import difflib
import re
from collections import Counter
from typing import Any

from ..audit import AuditStore
from ..errors import ApiError
from ..filesystem import FilesystemBackend, revision_for
from ..lvgl_merge import MergeError, merge_project_into_yaml
from ..project_locks import project_file_lock
from ..project_store import ProjectStore
from ..settings import Settings
from .changesets import ChangeSetStore
from .secrets_guard import assert_not_secrets_file

_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
_DIFF_PREVIEW_CHARACTERS = 32 * 1024


class ConfigurationDraftMutationService:
    """Merge a stored project into a draft only after an explicit apply."""

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
        project_name: str,
        project_revision: str,
        configuration_name: str,
        configuration_revision: str,
        draft_revision: str | None,
        *,
        identity: str,
    ) -> dict[str, Any]:
        self._require_write_access()
        assert_not_secrets_file(configuration_name)
        self._validate_revision(project_revision, "project_revision")
        self._validate_revision(configuration_revision, "configuration_revision")
        if draft_revision is not None:
            self._validate_revision(draft_revision, "draft_revision")
        try:
            loaded = self.projects.read(project_name)
            self._require_revision(
                project_revision,
                loaded["revision"],
                target="project",
            )
            active = self.filesystem.read_config(configuration_name)
            self._require_revision(
                configuration_revision,
                active["revision"],
                target="configuration",
            )
            draft = self._read_draft(configuration_name)
            actual_draft_revision = draft["revision"] if draft else None
            self._require_revision(
                draft_revision,
                actual_draft_revision,
                target="configuration_draft",
            )
            base_content = draft["content"] if draft else active["content"]
            project, issues = self.projects.designer.validate(loaded["project"])
            if any(issue["severity"] == "error" for issue in issues):
                raise ApiError(
                    "invalid_project",
                    "Project validation failed.",
                    422,
                    {"issues": issues[:100]},
                )
            try:
                merged = merge_project_into_yaml(project, base_content)
            except MergeError as exc:
                raise ApiError("merge_failed", str(exc), 422) from exc
            blocking = [issue for issue in merged.issues if issue.severity == "A"]
            if blocking:
                raise ApiError(
                    "invalid_project",
                    "Project merge contains blocking issues.",
                    422,
                    {
                        "issues": [
                            {"severity": issue.severity, "message": issue.message}
                            for issue in blocking[:100]
                        ]
                    },
                )
            content_bytes = len(merged.content.encode("utf-8"))
            if content_bytes > self.settings.max_file_size:
                raise ApiError(
                    "file_too_large",
                    "Merged configuration exceeds the configured size limit.",
                    413,
                )
            diff = "".join(
                difflib.unified_diff(
                    base_content.splitlines(keepends=True),
                    merged.content.splitlines(keepends=True),
                    fromfile=f"source/{configuration_name}",
                    tofile=f"draft/{configuration_name}",
                )
            )
            issue_counts = Counter(issue.severity for issue in merged.issues)
            result_revision = revision_for(merged.content)
            preview = {
                "project_name": project_name,
                "project_revision": project_revision,
                "configuration_name": active["name"],
                "configuration_revision": configuration_revision,
                "draft_base_revision": actual_draft_revision,
                "result_draft_revision": result_revision,
                "result_bytes": content_bytes,
                "replaced": merged.replaced_keys,
                "appended": merged.appended_keys,
                "issue_counts": dict(issue_counts),
                "issues": [
                    {"severity": issue.severity, "message": issue.message}
                    for issue in merged.issues[:100]
                ],
                "diff": diff[:_DIFF_PREVIEW_CHARACTERS],
                "diff_truncated": len(diff) > _DIFF_PREVIEW_CHARACTERS,
            }
            result = self.changesets.create(
                identity=identity,
                project_name=project_name,
                base_revision=project_revision,
                operations=[
                    {
                        "op": "merge_configuration_draft",
                        "configuration_name": active["name"],
                        "configuration_revision": configuration_revision,
                        "draft_revision": actual_draft_revision,
                    }
                ],
                project={"content": merged.content},
                preview=preview,
                target_kind="configuration_draft",
            )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.configuration_draft.propose",
                configuration_name,
                draft_revision,
                None,
                exc.error,
                {"project_name": project_name},
            )
            raise
        self._audit(
            identity,
            "mcp.configuration_draft.propose",
            active["name"],
            actual_draft_revision,
            None,
            "success",
            {
                "project_name": project_name,
                "change_set_id": result["change_set_id"],
                "result_draft_revision": result_revision,
            },
        )
        return result

    def apply(self, change_set_id: str, *, identity: str) -> dict[str, Any]:
        self._require_write_access()
        record = self.changesets.payload(change_set_id, identity)
        if record["target_kind"] != "configuration_draft":
            raise ApiError(
                "changeset_target_mismatch",
                "This changeset does not target a configuration draft.",
                422,
            )
        if record["status"] == "applied":
            record.pop("project", None)
            return {**record, "idempotent": True}

        operation = record["operations"][0]
        configuration_name = operation["configuration_name"]
        assert_not_secrets_file(configuration_name)
        content = record["project"].get("content")
        if not isinstance(content, str):
            raise ApiError(
                "invalid_changeset",
                "The configuration draft changeset payload is invalid.",
                500,
            )
        desired_revision = revision_for(content)
        project_name = record["project_name"]
        try:
            self.projects._path(project_name)
            with project_file_lock(self.projects.root, project_name):
                project = self.projects.read(project_name)
                self._require_revision(
                    record["base_revision"],
                    project["revision"],
                    target="project",
                )
                try:
                    saved = self.filesystem.save_draft_checked(
                        configuration_name,
                        content,
                        expected_active_revision=operation["configuration_revision"],
                        expected_draft_revision=operation.get("draft_revision"),
                    )
                except ApiError as exc:
                    actual = (exc.details or {}).get("actual_revision")
                    if (
                        exc.error == "revision_conflict"
                        and (exc.details or {}).get("target")
                        == "configuration_draft"
                        and actual == desired_revision
                    ):
                        return self._mark_idempotent(
                            record,
                            identity,
                            change_set_id,
                            desired_revision,
                            configuration_name,
                        )
                    raise
                applied = self.changesets.mark_applied(
                    change_set_id,
                    identity,
                    saved["revision"],
                )
        except ApiError as exc:
            self._audit(
                identity,
                "mcp.changeset.apply",
                configuration_name,
                operation.get("draft_revision"),
                None,
                exc.error,
                {
                    "change_set_id": change_set_id,
                    "target": "configuration_draft",
                    "project_name": project_name,
                },
            )
            raise
        self._audit(
            identity,
            "mcp.changeset.apply",
            configuration_name,
            saved["old_draft_revision"],
            saved["revision"],
            "success",
            {
                "change_set_id": change_set_id,
                "target": "configuration_draft",
                "project_name": project_name,
            },
        )
        return {**applied, "idempotent": False}

    def _mark_idempotent(
        self,
        record: dict[str, Any],
        identity: str,
        change_set_id: str,
        revision: str,
        configuration_name: str,
    ) -> dict[str, Any]:
        applied = self.changesets.mark_applied(change_set_id, identity, revision)
        self._audit(
            identity,
            "mcp.changeset.apply",
            configuration_name,
            None,
            revision,
            "idempotent",
            {
                "change_set_id": change_set_id,
                "target": "configuration_draft",
                "project_name": record["project_name"],
            },
        )
        return {**applied, "idempotent": True}

    def _read_draft(self, name: str) -> dict[str, Any] | None:
        try:
            return self.filesystem.read_draft(name)
        except ApiError as exc:
            if exc.error == "draft_not_found":
                return None
            raise

    def _require_write_access(self) -> None:
        if self.settings.mcp_access != "project_write" or self.settings.access_level not in {
            "write",
            "write_with_builder",
        }:
            raise ApiError(
                "mcp_write_disabled",
                "MCP configuration draft writes are disabled by the app configuration.",
                403,
            )

    @staticmethod
    def _validate_revision(value: str, field: str) -> None:
        if not _REVISION.fullmatch(value):
            raise ApiError("invalid_revision", f"{field} is malformed.", 422)

    @staticmethod
    def _require_revision(
        expected: str | None,
        actual: str | None,
        *,
        target: str,
    ) -> None:
        if expected != actual:
            raise ApiError(
                "revision_conflict",
                f"The {target.replace('_', ' ')} changed after it was selected.",
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
        configuration: str,
        old_revision: str | None,
        new_revision: str | None,
        result: str,
        metadata: dict[str, Any],
    ) -> None:
        self.audit.record(
            user_id=identity,
            action=action,
            configuration=configuration,
            old_revision=old_revision,
            new_revision=new_revision,
            result=result,
            metadata=metadata,
        )
