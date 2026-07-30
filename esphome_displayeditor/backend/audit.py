"""Small SQLite audit store without configuration or secret contents."""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class AuditStore:
    def __init__(self, data_root: Path) -> None:
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
        with self._connect() as connection:
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
                    result TEXT NOT NULL
                )
                """
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
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_events
                    (created_at, user_id, action, configuration,
                     old_revision, new_revision, result)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    user_id,
                    action,
                    configuration,
                    old_revision,
                    new_revision,
                    result,
                ),
            )

    def recent(self, limit: int = 100) -> list[dict]:
        safe_limit = min(max(limit, 1), 500)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, created_at, user_id, action, configuration,
                       old_revision, new_revision, result
                FROM audit_events ORDER BY id DESC LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

