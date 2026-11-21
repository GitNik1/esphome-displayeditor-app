"""Small SQLite audit store without configuration or secret contents."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .sqlite_support import use_write_ahead_log

_LOGGER = logging.getLogger(__name__)

#: Rows kept; older ones are pruned. Generous - an install writes a few
#: hundred a day - but the table no longer grows without bound (every
#: refused request writes a row too).
AUDIT_RETENTION_ROWS = 50_000
_PRUNE_EVERY = 500


class AuditStore:
    def __init__(self, data_root: Path, *, retention_rows: int = AUDIT_RETENTION_ROWS) -> None:
        self.retention_rows = retention_rows
        self._writes = 0
        database_dir = data_root / "database"
        database_dir.mkdir(parents=True, exist_ok=True)
        self.path = database_dir / "audit.sqlite3"
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            use_write_ahead_log(connection)
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    configuration TEXT NOT NULL,
                    old_revision TEXT,
                    new_revision TEXT,
                    result TEXT NOT NULL,
                    job_id TEXT,
                    esphome_version TEXT,
                    metadata_json TEXT
                )
                """
            )
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(audit_events)")
            }
            for name in ("job_id", "esphome_version", "metadata_json"):
                if name not in columns:
                    connection.execute(f"ALTER TABLE audit_events ADD COLUMN {name} TEXT")
            self._prune(connection)

    def _prune(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            "DELETE FROM audit_events WHERE id <= (SELECT MAX(id) FROM audit_events) - ?",
            (self.retention_rows,),
        )

    def record(
        self,
        *,
        user_id: str,
        action: str,
        configuration: str,
        old_revision: str | None,
        new_revision: str | None,
        result: str,
        job_id: str | None = None,
        esphome_version: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Append an event. Never raises: an audit row that cannot be
        written (a full disk, the database locked by the other process) is
        logged, but must not turn the change it describes - usually already
        saved - into an error response."""
        try:
            self._insert(user_id, action, configuration, old_revision, new_revision,
                         result, job_id, esphome_version, metadata)
        except sqlite3.Error as exc:
            _LOGGER.warning("Audit event %s for %s could not be written: %s",
                            action, configuration, exc)

    def _insert(self, user_id, action, configuration, old_revision, new_revision,
                result, job_id, esphome_version, metadata) -> None:
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO audit_events
                    (created_at, user_id, action, configuration,
                     old_revision, new_revision, result, job_id,
                     esphome_version, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    user_id,
                    action,
                    configuration,
                    old_revision,
                    new_revision,
                    result,
                    job_id,
                    esphome_version,
                    json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
                    if metadata
                    else None,
                ),
            )
            self._writes += 1
            if self._writes % _PRUNE_EVERY == 0:
                self._prune(connection)

    def recent(self, limit: int = 100) -> list[dict]:
        safe_limit = min(max(limit, 1), 500)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                """
                SELECT id, created_at, user_id, action, configuration,
                       old_revision, new_revision, result, job_id,
                       esphome_version, metadata_json
                FROM audit_events ORDER BY id DESC LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        result: list[dict] = []
        for row in rows:
            item = dict(row)
            raw_metadata = item.pop("metadata_json", None)
            try:
                item["metadata"] = json.loads(raw_metadata) if raw_metadata else None
            except (TypeError, ValueError):
                item["metadata"] = None
            result.append(item)
        return result
