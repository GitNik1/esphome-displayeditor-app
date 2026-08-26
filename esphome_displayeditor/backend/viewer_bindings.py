"""Add-on-only persistence for read-only Viewer runtime bindings."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .errors import ApiError
from .filesystem import revision_for
from .project_locks import locked_project_write


_PROJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.lvgldesign$")
_WIDGET_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_ENTITY_ID = re.compile(r"^[a-z0-9_]{1,64}:[A-Za-z0-9_.:-]{1,128}$")
_TARGETS = {"text", "value", "state_checked"}
_MAX_FILE_SIZE = 256 * 1024
_TARGET_WIDGET_TYPES = {
    "text": {"label"},
    "value": {"slider", "bar", "arc"},
    "state_checked": {"switch"},
}


def viewer_targets_for_widget_type(widget_type: str) -> list[str]:
    """Return deterministic Viewer-sidecar targets for a widget type."""
    return sorted(
        target
        for target, widget_types in _TARGET_WIDGET_TYPES.items()
        if widget_type in widget_types
    )


def validate_bindings(bindings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(bindings) > 256:
        raise ApiError("too_many_bindings", "A project may contain at most 256 Viewer bindings.", 422)
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in bindings:
        if not isinstance(raw, dict):
            raise ApiError("invalid_binding", "Every Viewer binding must be an object.", 422)
        widget_id = str(raw.get("widget_id", "")).strip()
        target = str(raw.get("target", "")).strip()
        device_id = str(raw.get("device_id", "")).strip()
        entity_id = str(raw.get("entity_id", "")).strip()
        value_format = str(raw.get("value_format", "{state}"))
        fallback = str(raw.get("fallback", ""))
        try:
            stale_after = int(raw.get("stale_after", 0))
        except (TypeError, ValueError) as exc:
            raise ApiError("invalid_binding", "stale_after must be a whole number.", 422) from exc
        if not _WIDGET_ID.fullmatch(widget_id):
            raise ApiError("invalid_binding", "The binding contains an invalid widget ID.", 422)
        if target not in _TARGETS:
            raise ApiError("invalid_binding", "The binding target is not supported.", 422)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}", device_id):
            raise ApiError("invalid_binding", "The binding contains an invalid device ID.", 422)
        if not _ENTITY_ID.fullmatch(entity_id):
            raise ApiError("invalid_binding", "The binding contains an invalid entity ID.", 422)
        if len(value_format) > 128 or len(fallback) > 128:
            raise ApiError("invalid_binding", "Binding format and fallback are limited to 128 characters.", 422)
        if not 0 <= stale_after <= 86400:
            raise ApiError("invalid_binding", "stale_after must be between 0 and 86400 seconds.", 422)
        identity = (widget_id, target)
        if identity in seen:
            raise ApiError("duplicate_binding", "A widget target may only be bound once.", 422)
        seen.add(identity)
        normalized.append(
            {
                "widget_id": widget_id,
                "target": target,
                "device_id": device_id,
                "entity_id": entity_id,
                "value_format": value_format,
                "fallback": fallback,
                "stale_after": stale_after,
            }
        )
    return normalized


def validate_binding_targets(
    bindings: list[dict[str, Any]],
    widget_types: dict[str, str],
    device_lookup=None,
) -> list[dict[str, Any]]:
    """Validate sidecar syntax and references against a concrete project."""
    normalized = validate_bindings(bindings)
    for binding in normalized:
        actual_type = widget_types.get(binding["widget_id"])
        if actual_type not in _TARGET_WIDGET_TYPES[binding["target"]]:
            raise ApiError(
                "invalid_binding_target",
                "The selected Viewer target does not match the stored widget.",
                422,
                {"widget_id": binding["widget_id"], "widget_type": actual_type},
            )
        if device_lookup is not None:
            device_lookup(binding["device_id"])
    return normalized


class ViewerBindingStore:
    """Revision-protected JSON sidecars that never enter the LVGL project model."""

    def __init__(self, data_root: Path) -> None:
        self.root = data_root / "viewer_bindings"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, project_name: str) -> Path:
        if not _PROJECT_NAME.fullmatch(project_name):
            raise ApiError("invalid_project_name", "Invalid designer project name.")
        path = self.root / f"{project_name}.json"
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise ApiError("invalid_path", "Viewer binding path is not a regular file.")
        return path

    def read(self, project_name: str) -> dict[str, Any]:
        path = self._path(project_name)
        if not path.exists():
            return {"project": project_name, "bindings": [], "revision": None}
        try:
            raw = self._read_bytes(path)
            payload = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError("invalid_bindings", "Stored Viewer bindings are invalid.", 500) from exc
        bindings = validate_bindings(payload.get("bindings", []) if isinstance(payload, dict) else [])
        return {"project": project_name, "bindings": bindings, "revision": revision_for(raw)}

    @locked_project_write
    def save(
        self,
        project_name: str,
        bindings: list[dict[str, Any]],
        expected_revision: str | None,
    ) -> dict[str, Any]:
        path = self._path(project_name)
        normalized = validate_bindings(bindings)
        old_revision = None
        if path.exists():
            old_revision = revision_for(self._read_bytes(path))
            if expected_revision != old_revision:
                raise ApiError(
                    "revision_conflict",
                    "Viewer bindings changed after they were loaded.",
                    409,
                    {"expected_revision": expected_revision, "actual_revision": old_revision},
                )
        elif expected_revision is not None:
            raise ApiError(
                "revision_conflict",
                "Viewer bindings no longer exist.",
                409,
                {"expected_revision": expected_revision, "actual_revision": None},
            )
        raw = (json.dumps({"version": 1, "bindings": normalized}, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self._atomic_write(path, raw)
        return {
            "project": project_name,
            "bindings": normalized,
            "old_revision": old_revision,
            "revision": revision_for(raw),
        }

    @locked_project_write
    def delete(self, project_name: str) -> None:
        path = self._path(project_name)
        if path.exists():
            path.unlink()

    @staticmethod
    def _read_bytes(path: Path) -> bytes:
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError as exc:
            raise ApiError("invalid_path", "Viewer binding file could not be opened safely.") from exc
        try:
            if os.fstat(descriptor).st_size > _MAX_FILE_SIZE:
                raise ApiError("file_too_large", "Viewer binding file is too large.", 413)
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                raw = handle.read(_MAX_FILE_SIZE + 1)
            if len(raw) > _MAX_FILE_SIZE:
                raise ApiError("file_too_large", "Viewer binding file is too large.", 413)
            return raw
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    @staticmethod
    def _atomic_write(path: Path, raw: bytes) -> None:
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
            ) as handle:
                temporary_name = handle.name
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
        finally:
            if temporary_name:
                try:
                    Path(temporary_name).unlink()
                except FileNotFoundError:
                    pass
