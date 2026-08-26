"""Persistent, bounded and expiring MCP project changesets."""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..errors import ApiError
from .limits import (
    MCP_ACTIVE_CHANGESET_LIMIT,
    MCP_APPLIED_CHANGESET_RETENTION_SECONDS,
    MCP_CHANGESET_PAYLOAD_MAX_BYTES,
    MCP_CHANGESET_RECORD_LIMIT,
    MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY,
    MCP_CHANGESET_STORAGE_MAX_BYTES,
    MCP_CHANGESET_TTL_SECONDS,
)


class ChangeSetStore:
    def __init__(self, data_root: Path) -> None:
        database_dir = data_root / "database"
        database_dir.mkdir(parents=True, exist_ok=True)
        self.path = database_dir / "mcp_changesets.sqlite3"
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA secure_delete = FAST")
        # WAL lets the separate MCP listener process and the main app
        # process read/write this file concurrently without blocking each
        # other under the default rollback-journal locking.
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute("PRAGMA auto_vacuum = INCREMENTAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS project_changesets (
                    id TEXT PRIMARY KEY,
                    identity TEXT NOT NULL,
                    project_name TEXT NOT NULL,
                    base_revision TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    status TEXT NOT NULL,
                    operations_json TEXT NOT NULL,
                    project_json TEXT NOT NULL,
                    preview_json TEXT NOT NULL,
                    applied_revision TEXT,
                    target_kind TEXT NOT NULL DEFAULT 'project',
                    viewer_base_revision TEXT,
                    viewer_bindings_json TEXT
                )
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(project_changesets)")
            }
            for name, declaration in (
                ("target_kind", "TEXT NOT NULL DEFAULT 'project'"),
                ("viewer_base_revision", "TEXT"),
                ("viewer_bindings_json", "TEXT"),
            ):
                if name not in columns:
                    connection.execute(
                        f"ALTER TABLE project_changesets ADD COLUMN {name} {declaration}"
                    )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_project_changesets_identity_status
                ON project_changesets(identity, status, expires_at)
                """
            )

    def create(
        self,
        *,
        identity: str,
        project_name: str,
        base_revision: str,
        operations: list[dict[str, Any]],
        project: dict[str, Any],
        preview: dict[str, Any],
        target_kind: str = "project",
        viewer_base_revision: str | None = None,
        viewer_bindings: list[dict[str, Any]] | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        if target_kind not in {
            "project",
            "project_create",
            "viewer_bindings",
            "configuration_draft",
        }:
            raise ValueError("Unsupported changeset target kind.")
        if target_kind == "viewer_bindings" and viewer_bindings is None:
            raise ValueError("Viewer binding changesets require a sidecar payload.")
        timestamp = time.time() if now is None else now
        change_id = f"cs_{secrets.token_urlsafe(24)}"
        expires_at = timestamp + MCP_CHANGESET_TTL_SECONDS
        operations_json = _json(operations)
        project_json = _json(project)
        preview_json = _json(preview)
        viewer_bindings_json = (
            _json(viewer_bindings) if viewer_bindings is not None else None
        )
        payload_bytes = _payload_size(
            operations_json,
            project_json,
            preview_json,
            viewer_bindings_json,
        )
        if payload_bytes > MCP_CHANGESET_PAYLOAD_MAX_BYTES:
            raise ApiError(
                "changeset_too_large",
                "The MCP changeset payload exceeds the configured storage limit.",
                413,
                {"maximum_bytes": MCP_CHANGESET_PAYLOAD_MAX_BYTES},
            )
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._cleanup(connection, timestamp)
            active = connection.execute(
                """
                SELECT COUNT(*) FROM project_changesets
                WHERE identity = ? AND status = 'pending' AND expires_at > ?
                """,
                (identity, timestamp),
            ).fetchone()[0]
            if active >= MCP_ACTIVE_CHANGESET_LIMIT:
                connection.rollback()
                raise ApiError(
                    "changeset_limit_reached",
                    "Too many active MCP changesets; wait for older proposals to expire.",
                    429,
                    {"maximum": MCP_ACTIVE_CHANGESET_LIMIT},
                )
            identity_records = connection.execute(
                "SELECT COUNT(*) FROM project_changesets WHERE identity = ?",
                (identity,),
            ).fetchone()[0]
            if identity_records >= MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY:
                # Evict the oldest already-applied/expired history for this
                # identity to make room. Pending proposals are never touched
                # here; the active-changeset check above already keeps them
                # well under this limit, so a client that merely keeps
                # working cannot be locked out by its own history.
                to_evict = identity_records - MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY + 1
                evictable = connection.execute(
                    """
                    SELECT id FROM project_changesets
                    WHERE identity = ? AND status != 'pending'
                    ORDER BY created_at ASC
                    LIMIT ?
                    """,
                    (identity, to_evict),
                ).fetchall()
                if len(evictable) < to_evict:
                    connection.rollback()
                    raise ApiError(
                        "changeset_record_limit_reached",
                        "The MCP client has reached its stored changeset limit.",
                        429,
                        {"maximum": MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY},
                    )
                connection.executemany(
                    "DELETE FROM project_changesets WHERE id = ?",
                    [(row["id"],) for row in evictable],
                )
            record_count, stored_bytes = connection.execute(
                """
                SELECT COUNT(*), COALESCE(SUM(
                    length(CAST(operations_json AS BLOB)) +
                    length(CAST(project_json AS BLOB)) +
                    length(CAST(preview_json AS BLOB)) +
                    COALESCE(length(CAST(viewer_bindings_json AS BLOB)), 0)
                ), 0)
                FROM project_changesets
                """
            ).fetchone()
            if record_count >= MCP_CHANGESET_RECORD_LIMIT:
                connection.rollback()
                raise ApiError(
                    "changeset_record_limit_reached",
                    "The global stored changeset limit has been reached.",
                    429,
                    {"maximum": MCP_CHANGESET_RECORD_LIMIT},
                )
            if stored_bytes + payload_bytes > MCP_CHANGESET_STORAGE_MAX_BYTES:
                connection.rollback()
                raise ApiError(
                    "changeset_storage_limit_reached",
                    "The global MCP changeset storage limit has been reached.",
                    429,
                    {"maximum_bytes": MCP_CHANGESET_STORAGE_MAX_BYTES},
                )
            connection.execute(
                """
                INSERT INTO project_changesets
                    (id, identity, project_name, base_revision, created_at,
                     expires_at, status, operations_json, project_json, preview_json,
                     target_kind, viewer_base_revision, viewer_bindings_json)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                """,
                (
                    change_id,
                    identity,
                    project_name,
                    base_revision,
                    timestamp,
                    expires_at,
                    operations_json,
                    project_json,
                    preview_json,
                    target_kind,
                    viewer_base_revision,
                    viewer_bindings_json,
                ),
            )
            connection.commit()
        return self.read(change_id, identity, now=timestamp)

    def read(
        self, change_id: str, identity: str, *, now: float | None = None
    ) -> dict[str, Any]:
        return self._record(change_id, identity, include_project=False, now=now)

    def payload(
        self, change_id: str, identity: str, *, now: float | None = None
    ) -> dict[str, Any]:
        return self._record(change_id, identity, include_project=True, now=now)

    def mark_applied(
        self,
        change_id: str,
        identity: str,
        revision: str,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        timestamp = time.time() if now is None else now
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status, expires_at FROM project_changesets WHERE id = ? AND identity = ?",
                (change_id, identity),
            ).fetchone()
            self._ensure_available(row, timestamp)
            if row["status"] == "pending":
                connection.execute(
                    """
                    UPDATE project_changesets
                    SET status = 'applied', applied_revision = ?, expires_at = ?,
                        operations_json = '[]', project_json = '{}',
                        preview_json = '{}', viewer_bindings_json = NULL
                    WHERE id = ? AND identity = ? AND status = 'pending'
                    """,
                    (
                        revision,
                        timestamp + MCP_APPLIED_CHANGESET_RETENTION_SECONDS,
                        change_id,
                        identity,
                    ),
                )
            connection.commit()
        return self.read(change_id, identity, now=timestamp)

    def _record(
        self,
        change_id: str,
        identity: str,
        *,
        include_project: bool,
        now: float | None,
    ) -> dict[str, Any]:
        timestamp = time.time() if now is None else now
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM project_changesets WHERE id = ? AND identity = ?",
                (change_id, identity),
            ).fetchone()
        self._ensure_available(row, timestamp)
        result = {
            "change_set_id": row["id"],
            "project_name": row["project_name"],
            "base_revision": row["base_revision"],
            "created_at": _iso(row["created_at"]),
            "expires_at": _iso(row["expires_at"]),
            "status": row["status"],
            "target_kind": row["target_kind"],
            "operations": json.loads(row["operations_json"]),
            "preview": json.loads(row["preview_json"]),
            "applied_revision": row["applied_revision"],
        }
        if row["target_kind"] == "viewer_bindings":
            result["viewer_base_revision"] = row["viewer_base_revision"]
        if include_project:
            result["project"] = json.loads(row["project_json"])
            if row["viewer_bindings_json"] is not None:
                result["viewer_bindings"] = json.loads(row["viewer_bindings_json"])
        return result

    @staticmethod
    def _ensure_available(row: sqlite3.Row | None, timestamp: float) -> None:
        if row is None:
            raise ApiError("changeset_not_found", "The MCP changeset was not found.", 404)
        if row["expires_at"] <= timestamp:
            raise ApiError("changeset_expired", "The MCP changeset has expired.", 410)

    @staticmethod
    def _cleanup(connection: sqlite3.Connection, timestamp: float) -> None:
        connection.execute(
            "DELETE FROM project_changesets WHERE expires_at <= ?",
            (timestamp,),
        )
        connection.execute("PRAGMA incremental_vacuum(128)")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _payload_size(*values: str | None) -> int:
    return sum(len(value.encode("utf-8")) for value in values if value is not None)


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
