"""Settings shared by the add-on's small SQLite stores."""

from __future__ import annotations

import sqlite3


def use_write_ahead_log(connection: sqlite3.Connection) -> None:
    """Switch a database to write-ahead logging.

    The app and the separate MCP process write the same databases. In
    SQLite's default rollback-journal mode a reader blocks a writer, so a
    save could fail with "database is locked" while the other process read
    the version history. The mode is stored in the database file; call this
    before the connection's first INSERT/UPDATE (outside a transaction).
    """
    connection.execute("PRAGMA journal_mode=WAL")
