"""Bounded version history for designer projects.

Every write that goes through :class:`~backend.project_store.ProjectStore`
records the version it just wrote, so a change made by the browser *or* by the
separate MCP listener process can be inspected, diffed and rolled back.

Each row is the state that was written, attributed to whoever wrote it - not
the state it displaced. Attributing rows to the displacing write would relabel
an MCP-authored version as ``restore`` the moment a user rolled back onto it,
which is exactly the question the global feed exists to answer.

The store is best effort by contract: it must never turn a storage problem
into a failed save. Every public method degrades to an empty result instead of
raising, and construction failures leave :attr:`enabled` false.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import zlib
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .errors import ApiError

_LOGGER = logging.getLogger(__name__)

#: Rolling versions kept per project. Locked versions live *beside* these.
PROJECT_REVISION_DEPTH = 10
#: Locked versions kept per project, on top of the rolling window.
PROJECT_REVISION_LOCKED_DEPTH = 5
PROJECT_REVISION_LABEL_MAX_CHARS = 80
#: Matches the ceiling of the ``max_file_size_kib`` add-on option.
PROJECT_REVISION_MAX_BLOB_BYTES = 4 * 1024 * 1024
PROJECT_REVISION_STORAGE_MAX_BYTES = 128 * 1024 * 1024
PROJECT_REVISION_LOCKED_STORAGE_MAX_BYTES = 64 * 1024 * 1024
PROJECT_REVISION_FEED_LIMIT = 200
PROJECT_REVISION_COMPRESSION_LEVEL = 6
_EVICTION_BATCH = 32

ORIGINS = frozenset({"ui", "mcp", "mcp_import", "restore", "unknown"})
ACTIONS = frozenset({"save", "delete"})

_METADATA_COLUMNS = (
    "id, project_name, revision, created_at, actor, origin, action, "
    "byte_size, encoding, restored_from, label, locked, locked_at, "
    "locked_by, metadata_json"
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_label(label: str | None) -> str | None:
    if label is None:
        return None
    cleaned = label.strip()[:PROJECT_REVISION_LABEL_MAX_CHARS]
    return cleaned or None


class ProjectRevisionStore:
    """SQLite-backed, size-bounded history of written project versions."""

    def __init__(self, data_root: Path) -> None:
        self.enabled = False
        self.path = data_root / "database" / "project_revisions.sqlite3"
        self._lock = threading.Lock()
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._initialize()
        except Exception:  # noqa: BLE001 - history must never block startup
            _LOGGER.warning(
                "Project revision history unavailable at %s", self.path, exc_info=True
            )
            return
        self.enabled = True

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA secure_delete = FAST")
            # WAL lets the separate MCP listener process and the main app
            # process write history concurrently without blocking each other.
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
        except BaseException:
            # A corrupt file makes the very first PRAGMA fail; without this the
            # connection would leak on every degraded call.
            connection.close()
            raise
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute("PRAGMA auto_vacuum = INCREMENTAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS project_revisions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_name   TEXT    NOT NULL,
                    revision       TEXT    NOT NULL,
                    created_at     TEXT    NOT NULL,
                    actor          TEXT    NOT NULL,
                    origin         TEXT    NOT NULL,
                    action         TEXT    NOT NULL,
                    byte_size      INTEGER NOT NULL,
                    encoding       TEXT    NOT NULL,
                    content        BLOB    NOT NULL,
                    restored_from  INTEGER,
                    label          TEXT,
                    locked         INTEGER NOT NULL DEFAULT 0,
                    locked_at      TEXT,
                    locked_by      TEXT,
                    metadata_json  TEXT
                )
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(project_revisions)")
            }
            for name, declaration in (
                ("restored_from", "INTEGER"),
                ("label", "TEXT"),
                ("locked", "INTEGER NOT NULL DEFAULT 0"),
                ("locked_at", "TEXT"),
                ("locked_by", "TEXT"),
                ("metadata_json", "TEXT"),
            ):
                if name not in columns:
                    connection.execute(
                        f"ALTER TABLE project_revisions ADD COLUMN {name} {declaration}"
                    )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_project_revisions_project
                ON project_revisions(project_name, id DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_project_revisions_recent
                ON project_revisions(id DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_project_revisions_locked
                ON project_revisions(project_name, locked)
                """
            )

    # -- writing ---------------------------------------------------------

    def record(
        self,
        *,
        project_name: str,
        content: bytes,
        revision: str,
        actor: str,
        origin: str,
        action: str,
        restored_from: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Store one written version. Returns whether a row was inserted."""
        if not self.enabled:
            return False
        if origin not in ORIGINS:
            origin = "unknown"
        if action not in ACTIONS:
            action = "save"
        if action == "delete":
            encoding, blob, byte_size = "tombstone", b"", 0
        elif len(content) > PROJECT_REVISION_MAX_BLOB_BYTES:
            encoding, blob, byte_size = "skipped", b"", len(content)
        else:
            encoding = "zlib"
            blob = zlib.compress(content, PROJECT_REVISION_COMPRESSION_LEVEL)
            byte_size = len(content)
        try:
            with self._lock, closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    newest = connection.execute(
                        """
                        SELECT revision, action FROM project_revisions
                        WHERE project_name = ? ORDER BY id DESC LIMIT 1
                        """,
                        (project_name,),
                    ).fetchone()
                    # Only consecutive duplicates are skipped: restoring an old
                    # version must still produce a row even though the same
                    # content already sits further down the list.
                    if (
                        newest is not None
                        and newest["revision"] == revision
                        and newest["action"] == action
                    ):
                        connection.rollback()
                        return False
                    connection.execute(
                        """
                        INSERT INTO project_revisions
                            (project_name, revision, created_at, actor, origin,
                             action, byte_size, encoding, content, restored_from,
                             metadata_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            project_name,
                            revision,
                            _now(),
                            actor,
                            origin,
                            action,
                            byte_size,
                            encoding,
                            blob,
                            restored_from,
                            json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
                            if metadata
                            else None,
                        ),
                    )
                    self._prune(connection, project_name)
                    self._enforce_storage(connection)
                    connection.execute("PRAGMA incremental_vacuum(128)")
                except Exception:
                    connection.rollback()
                    raise
                connection.commit()
            return True
        except sqlite3.Error:
            _LOGGER.warning(
                "Could not record a revision for %s", project_name, exc_info=True
            )
            return False

    @staticmethod
    def _prune(connection: sqlite3.Connection, project_name: str) -> None:
        """Keep the newest unlocked versions; locked ones are never swept."""
        connection.execute(
            """
            DELETE FROM project_revisions
             WHERE project_name = ? AND locked = 0
               AND id NOT IN (SELECT id FROM project_revisions
                               WHERE project_name = ? AND locked = 0
                               ORDER BY id DESC LIMIT ?)
            """,
            (project_name, project_name, PROJECT_REVISION_DEPTH),
        )

    @staticmethod
    def _enforce_storage(connection: sqlite3.Connection) -> None:
        """Evict oldest unlocked rows until the global budget is met.

        Each project always keeps its newest row: for a deleted project that
        row is the only remaining copy of its content.
        """
        for _ in range(64):
            used = connection.execute(
                "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM project_revisions"
                " WHERE locked = 0"
            ).fetchone()[0]
            if used <= PROJECT_REVISION_STORAGE_MAX_BYTES:
                return
            removed = connection.execute(
                """
                DELETE FROM project_revisions
                 WHERE id IN (SELECT id FROM project_revisions
                               WHERE locked = 0
                                 AND id NOT IN (SELECT MAX(id) FROM project_revisions
                                                 GROUP BY project_name)
                               ORDER BY id ASC LIMIT ?)
                """,
                (_EVICTION_BATCH,),
            ).rowcount
            if not removed:
                return

    # -- annotation ------------------------------------------------------

    def set_label(
        self, project_name: str, revision_id: int, label: str | None
    ) -> dict[str, Any]:
        """Name a version. Never touches the lock - the two are independent."""
        cleaned = _normalize_label(label)
        with self._lock, closing(self._connect()) as connection, connection:
            self._require(connection, project_name, revision_id)
            connection.execute(
                "UPDATE project_revisions SET label = ? WHERE id = ?",
                (cleaned, revision_id),
            )
            return self._fetch(connection, revision_id)

    def set_locked(
        self, project_name: str, revision_id: int, locked: bool, actor: str
    ) -> dict[str, Any]:
        """Pin or unpin a version. Never touches the label."""
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._require(connection, project_name, revision_id)
                if locked and not row["locked"]:
                    self._check_lock_quota(connection, project_name, row)
                connection.execute(
                    """
                    UPDATE project_revisions
                       SET locked = ?, locked_at = ?, locked_by = ?
                     WHERE id = ?
                    """,
                    (
                        1 if locked else 0,
                        _now() if locked else None,
                        actor if locked else None,
                        revision_id,
                    ),
                )
                result = self._fetch(connection, revision_id)
            except Exception:
                connection.rollback()
                raise
            connection.commit()
            return result

    @staticmethod
    def _check_lock_quota(
        connection: sqlite3.Connection, project_name: str, row: sqlite3.Row
    ) -> None:
        used = connection.execute(
            "SELECT COUNT(*) FROM project_revisions"
            " WHERE project_name = ? AND locked = 1",
            (project_name,),
        ).fetchone()[0]
        if used >= PROJECT_REVISION_LOCKED_DEPTH:
            raise ApiError(
                "revision_lock_limit",
                "This project already has the maximum number of locked versions.",
                409,
                {"limit": PROJECT_REVISION_LOCKED_DEPTH, "used": used},
            )
        # Locked rows are exempt from automatic eviction, so the budget is
        # enforced here instead - failing the lock rather than silently
        # dropping somebody else's pinned version.
        stored = connection.execute(
            "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM project_revisions"
            " WHERE locked = 1"
        ).fetchone()[0]
        if stored + len(row["content"]) > PROJECT_REVISION_LOCKED_STORAGE_MAX_BYTES:
            raise ApiError(
                "revision_lock_storage_exhausted",
                "Locked versions already use the whole storage budget.",
                409,
                {"maximum_bytes": PROJECT_REVISION_LOCKED_STORAGE_MAX_BYTES},
            )

    @staticmethod
    def _require(
        connection: sqlite3.Connection, project_name: str, revision_id: int
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM project_revisions WHERE id = ?", (revision_id,)
        ).fetchone()
        # An ownership check, not just an existence check.
        if row is None or row["project_name"] != project_name:
            raise ApiError("revision_not_found", "Version was not found.", 404)
        return row

    # -- reading ---------------------------------------------------------

    def list(self, project_name: str) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    f"SELECT {_METADATA_COLUMNS} FROM project_revisions"
                    " WHERE project_name = ? ORDER BY id DESC",
                    (project_name,),
                ).fetchall()
        except sqlite3.Error:
            _LOGGER.warning("Could not list revisions for %s", project_name, exc_info=True)
            return []
        return [_metadata(row) for row in rows]

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        safe_limit = min(max(limit, 1), PROJECT_REVISION_FEED_LIMIT)
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    f"SELECT {_METADATA_COLUMNS} FROM project_revisions"
                    " ORDER BY id DESC LIMIT ?",
                    (safe_limit,),
                ).fetchall()
        except sqlite3.Error:
            _LOGGER.warning("Could not read the revision feed", exc_info=True)
            return []
        return [_metadata(row) for row in rows]

    def content(
        self, project_name: str, revision_id: int
    ) -> tuple[bytes, dict[str, Any]] | None:
        """Return the stored bytes and metadata, or ``None`` if unavailable."""
        if not self.enabled:
            return None
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT * FROM project_revisions WHERE id = ?", (revision_id,)
                ).fetchone()
        except sqlite3.Error:
            _LOGGER.warning("Could not read revision %s", revision_id, exc_info=True)
            return None
        if row is None or row["project_name"] != project_name:
            return None
        if row["encoding"] == "zlib":
            try:
                raw = zlib.decompress(row["content"])
            except zlib.error:
                _LOGGER.warning("Revision %s is corrupt", revision_id, exc_info=True)
                return None
        elif row["encoding"] == "raw":
            raw = bytes(row["content"])
        else:  # tombstone / skipped carry no content
            raw = b""
        return raw, _metadata(row)

    @staticmethod
    def _fetch(connection: sqlite3.Connection, revision_id: int) -> dict[str, Any]:
        row = connection.execute(
            f"SELECT {_METADATA_COLUMNS} FROM project_revisions WHERE id = ?",
            (revision_id,),
        ).fetchone()
        return _metadata(row)


def _metadata(row: sqlite3.Row) -> dict[str, Any]:
    item = {
        "id": row["id"],
        "project_name": row["project_name"],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "actor": row["actor"],
        "origin": row["origin"],
        "action": row["action"],
        "byte_size": row["byte_size"],
        "encoding": row["encoding"],
        "restored_from": row["restored_from"],
        "label": row["label"],
        "locked": bool(row["locked"]),
        "locked_at": row["locked_at"],
        "locked_by": row["locked_by"],
    }
    raw_metadata = row["metadata_json"]
    try:
        item["metadata"] = json.loads(raw_metadata) if raw_metadata else None
    except (TypeError, ValueError):
        item["metadata"] = None
    return item
