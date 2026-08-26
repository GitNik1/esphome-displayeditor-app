"""Persistent, revision-protected storage for designer project files."""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .designer import DesignerService
from .errors import ApiError
from .filesystem import revision_for
from .project_locks import locked_project_write

_PROJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.lvgldesign$")


class ProjectStore:
    def __init__(
        self, data_root: Path, designer: DesignerService, max_size: int
    ) -> None:
        self.root = data_root / "projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self.designer = designer
        self.max_size = max_size

    def _path(self, name: str) -> Path:
        if not _PROJECT_NAME.fullmatch(name):
            raise ApiError(
                "invalid_project_name",
                "Project names must end in .lvgldesign and contain only letters, numbers, '.', '_' or '-'.",
            )
        path = self.root / name
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise ApiError("invalid_path", "Project path is not a regular file.")
        return path

    def list(self) -> list[dict]:
        projects = []
        for path in self.root.glob("*.lvgldesign"):
            if (
                path.is_symlink()
                or not path.is_file()
                or not _PROJECT_NAME.fullmatch(path.name)
            ):
                continue
            try:
                raw = self._read_bytes(path)
                stat = path.stat()
            except (OSError, ApiError):
                continue
            projects.append(
                {
                    "name": path.name,
                    "size": len(raw),
                    "revision": revision_for(raw),
                    "updated_at": datetime.fromtimestamp(
                        stat.st_mtime, timezone.utc
                    ).isoformat(),
                }
            )
        return sorted(projects, key=lambda item: item["name"].casefold())

    def read(self, name: str) -> dict:
        path = self._path(name)
        raw = self._read_bytes(path)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ApiError("invalid_encoding", "Project must be valid UTF-8.") from exc
        except json.JSONDecodeError as exc:
            raise ApiError(
                "invalid_project", "Stored project contains invalid JSON.", 422
            ) from exc
        if not isinstance(payload, dict):
            raise ApiError(
                "invalid_project", "Stored project root must be an object.", 422
            )
        project, issues = self.designer.validate(payload)
        return {
            "name": name,
            "project": self.designer.project_payload(project),
            "revision": revision_for(raw),
            "issues": issues,
        }

    def prepare(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Validate and canonicalize a project without writing it."""
        project, issues, raw = self._prepare(payload)
        return {
            "project": self.designer.project_payload(project),
            "issues": issues,
            "size": len(raw),
        }

    @locked_project_write
    def save(
        self,
        name: str,
        payload: dict[str, Any],
        expected_revision: str | None,
    ) -> dict:
        path = self._path(name)
        _project, issues, raw = self._prepare(payload)

        old_revision: str | None = None
        if path.exists():
            old_revision = revision_for(self._read_bytes(path))
            if expected_revision is None:
                raise ApiError(
                    "project_exists",
                    "Project already exists; load it before overwriting.",
                    409,
                    {"actual_revision": old_revision},
                )
            if expected_revision != old_revision:
                raise ApiError(
                    "revision_conflict",
                    "The stored project changed after it was loaded.",
                    409,
                    {
                        "expected_revision": expected_revision,
                        "actual_revision": old_revision,
                    },
                )
        elif expected_revision is not None:
            raise ApiError(
                "revision_conflict",
                "The project no longer exists.",
                409,
                {"expected_revision": expected_revision, "actual_revision": None},
            )

        self._atomic_write(path, raw)
        verified = self._read_bytes(path)
        new_revision = revision_for(verified)
        if verified != raw:
            raise ApiError(
                "save_verification_failed", "Saved project could not be verified.", 500
            )
        return {
            "name": name,
            "old_revision": old_revision,
            "revision": new_revision,
            "issues": issues,
        }

    @locked_project_write
    def delete(self, name: str, expected_revision: str) -> dict:
        path = self._path(name)
        current_revision = revision_for(self._read_bytes(path))
        if expected_revision != current_revision:
            raise ApiError(
                "revision_conflict",
                "The stored project changed after it was loaded.",
                409,
                {
                    "expected_revision": expected_revision,
                    "actual_revision": current_revision,
                },
            )
        path.unlink()
        return {"name": name, "revision": current_revision}

    def _prepare(
        self, payload: dict[str, Any]
    ) -> tuple[Any, list[dict], bytes]:
        project, issues = self.designer.validate(payload)
        blocking = [issue for issue in issues if issue["severity"] == "error"]
        if blocking:
            raise ApiError(
                "invalid_project", "Project validation failed.", 422, {"issues": issues}
            )
        stored_payload = project.to_dict()
        stored_payload["entities"] = getattr(project, "entities", [])
        stored_payload["bindings"] = getattr(project, "bindings", [])
        raw = (json.dumps(stored_payload, ensure_ascii=False, indent=2) + "\n").encode(
            "utf-8"
        )
        if len(raw) > self.max_size:
            raise ApiError(
                "file_too_large", "Project exceeds the configured size limit.", 413
            )
        return project, issues, raw

    def _read_bytes(self, path: Path) -> bytes:
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError as exc:
            raise ApiError(
                "project_not_found", "Designer project was not found.", 404
            ) from exc
        except OSError as exc:
            raise ApiError(
                "invalid_path", "Project file could not be opened safely."
            ) from exc
        try:
            stat = os.fstat(descriptor)
            if stat.st_size > self.max_size:
                raise ApiError(
                    "file_too_large", "Project exceeds the configured size limit.", 413
                )
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                raw = handle.read(self.max_size + 1)
            if len(raw) > self.max_size:
                raise ApiError(
                    "file_too_large", "Project exceeds the configured size limit.", 413
                )
            return raw
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    @staticmethod
    def _atomic_write(path: Path, raw: bytes) -> None:
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_name = handle.name
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temporary_name:
                try:
                    Path(temporary_name).unlink()
                except FileNotFoundError:
                    pass
