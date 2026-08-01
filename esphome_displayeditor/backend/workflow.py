"""Persistent safety state for validation-bound firmware operations."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .errors import ApiError


class WorkflowStore:
    """Keep validation proofs and idempotent job responses across restarts.

    The store deliberately contains no YAML or secrets.  If its database is
    damaged, it is archived and recreated empty.  Losing a validation proof
    fails closed: the operator has to validate again before a build can start.
    """

    IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

    def __init__(self, data_root: Path) -> None:
        database_dir = data_root / "database"
        database_dir.mkdir(parents=True, exist_ok=True)
        self.path = database_dir / "workflow.sqlite3"
        self._lock = threading.Lock()
        try:
            self._initialize()
        except sqlite3.DatabaseError:
            self._recover_corrupt_database()
            self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS validation_proofs (
                    configuration TEXT PRIMARY KEY,
                    revision TEXT NOT NULL,
                    validated_at REAL NOT NULL,
                    esphome_version TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS job_requests (
                    idempotency_key TEXT PRIMARY KEY,
                    operation TEXT NOT NULL,
                    configuration TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    job_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )

    def _recover_corrupt_database(self) -> None:
        if not self.path.exists():
            return
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        self.path.replace(self.path.with_name(f"workflow.corrupt-{timestamp}.sqlite3"))

    def record_validation(
        self,
        configuration: str,
        revision: str,
        esphome_version: str | None,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        validated_at = time.time() if now is None else now
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO validation_proofs
                    (configuration, revision, validated_at, esphome_version)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(configuration) DO UPDATE SET
                    revision=excluded.revision,
                    validated_at=excluded.validated_at,
                    esphome_version=excluded.esphome_version
                """,
                (configuration, revision, validated_at, esphome_version),
            )
        return {
            "configuration": configuration,
            "revision": revision,
            "validated_at": validated_at,
            "esphome_version": esphome_version,
        }

    def invalidate_validation(self, configuration: str) -> None:
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM validation_proofs WHERE configuration = ?",
                (configuration,),
            )

    def require_validation(
        self,
        configuration: str,
        revision: str,
        max_age_seconds: int,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                """
                SELECT configuration, revision, validated_at, esphome_version
                FROM validation_proofs WHERE configuration = ?
                """,
                (configuration,),
            ).fetchone()
        if row is None:
            raise ApiError(
                "validation_required",
                "Validate the active configuration before compiling or installing it.",
                409,
                {"configuration": configuration, "revision": revision},
            )
        proof = dict(row)
        if proof["revision"] != revision:
            raise ApiError(
                "validation_revision_mismatch",
                "The active configuration changed after its last validation.",
                409,
                {
                    "configuration": configuration,
                    "active_revision": revision,
                    "validated_revision": proof["revision"],
                },
            )
        current_time = time.time() if now is None else now
        age = max(0.0, current_time - float(proof["validated_at"]))
        if age > max_age_seconds:
            raise ApiError(
                "validation_expired",
                "The validation is too old. Validate the configuration again.",
                409,
                {
                    "configuration": configuration,
                    "revision": revision,
                    "age_seconds": int(age),
                    "max_age_seconds": max_age_seconds,
                },
            )
        proof["age_seconds"] = int(age)
        return proof

    def job_request(
        self, idempotency_key: str, *, now: float | None = None
    ) -> dict[str, Any] | None:
        current_time = time.time() if now is None else now
        cutoff = current_time - self.IDEMPOTENCY_TTL_SECONDS
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM job_requests WHERE created_at < ?", (cutoff,))
            row = connection.execute(
                """
                SELECT idempotency_key, operation, configuration, revision,
                       job_json, created_at
                FROM job_requests WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["job"] = json.loads(result.pop("job_json"))
        return result

    def record_job_request(
        self,
        idempotency_key: str,
        operation: str,
        configuration: str,
        revision: str,
        job: dict[str, Any],
        *,
        now: float | None = None,
    ) -> None:
        created_at = time.time() if now is None else now
        payload = json.dumps(job, ensure_ascii=False, separators=(",", ":"))
        try:
            with self._lock, closing(self._connect()) as connection, connection:
                connection.execute(
                    """
                    INSERT INTO job_requests
                        (idempotency_key, operation, configuration, revision,
                         job_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        idempotency_key,
                        operation,
                        configuration,
                        revision,
                        payload,
                        created_at,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ApiError(
                "idempotency_conflict",
                "The idempotency key was already used by another request.",
                409,
            ) from exc
