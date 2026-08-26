"""Persistent, revocable MCP client tokens stored only as secret hashes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import tempfile
import threading
from typing import Any

from ..assistant_tools.limits import (
    MCP_ACTIVE_TOKEN_LIMIT,
    MCP_TOKEN_LAST_USED_FLUSH_SECONDS,
    MCP_TOKEN_RECORD_LIMIT,
    MCP_TOKEN_STORE_MAX_BYTES,
)
from ..errors import ApiError
from ..project_locks import project_file_lock
from .identity import (
    MCPAuthorization,
    READ_SCOPES,
    WRITE_SCOPES,
    authorization_for_token,
)


ALL_SCOPES = READ_SCOPES | WRITE_SCOPES


class MCPTokenStore:
    """Manage bounded client credentials shared by the app and MCP listener."""

    def __init__(self, data_root: Path) -> None:
        self.root = data_root / "mcp"
        self.path = self.root / "tokens.json"
        self._cache_lock = threading.Lock()
        self._cache_signature: tuple[int, int, int, int] | None = None
        self._cache_records: tuple[dict[str, Any], ...] | None = None
        self._skipped_invalid_records = 0
        # last_used_at is authenticated in the MCP listener process but
        # displayed by the main app process's admin API, so it must be
        # persisted to be visible there - but authenticate() is the hottest
        # path in the store, so writes are batched and throttled rather than
        # flushed to disk on every request.
        self._pending_last_used: dict[str, float] = {}
        self._last_flush_at: float = 0.0

    def list(self) -> list[dict[str, Any]]:
        now = self._now()
        return [self._public(item, now) for item in self._load()]

    def create(
        self,
        name: str,
        scopes: list[str],
        expires_in_seconds: int,
    ) -> dict[str, Any]:
        clean_name = str(name).strip()
        if (
            not clean_name
            or len(clean_name) > 80
            or any(ord(char) < 32 for char in clean_name)
        ):
            raise ApiError("invalid_mcp_token_name", "The MCP token name is invalid.", 422)
        requested = frozenset(str(scope) for scope in scopes)
        if not requested or not requested <= ALL_SCOPES:
            raise ApiError(
                "invalid_mcp_token_scopes",
                "The MCP token scopes are empty or unsupported.",
                422,
                {"allowed_scopes": sorted(ALL_SCOPES)},
            )
        lifetime = int(expires_in_seconds)
        if not 3600 <= lifetime <= 365 * 24 * 60 * 60:
            raise ApiError(
                "invalid_mcp_token_expiry",
                "The MCP token lifetime must be between one hour and one year.",
                422,
            )
        raw_token = "mcp_" + secrets.token_urlsafe(32)
        now = self._now()
        record = {
            "id": secrets.token_hex(12),
            "name": clean_name,
            "secret_hash": self._hash(raw_token),
            "scopes": sorted(requested),
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=lifetime)).isoformat(),
            "revoked_at": None,
            "last_used_at": None,
        }
        self._ensure_root()
        with project_file_lock(
            self.root,
            "tokens",
            busy_error="mcp_token_store_busy",
            busy_message="Another process is currently updating MCP tokens.",
        ):
            records = self._load()
            active_count = sum(
                self._status(item, now) == "active" for item in records
            )
            if active_count >= MCP_ACTIVE_TOKEN_LIMIT:
                raise ApiError(
                    "mcp_token_limit_reached",
                    "The maximum number of MCP client tokens has been reached.",
                    409,
                    {"maximum": MCP_ACTIVE_TOKEN_LIMIT},
                )
            if len(records) >= MCP_TOKEN_RECORD_LIMIT:
                active = [
                    item for item in records if self._status(item, now) == "active"
                ]
                inactive = [
                    item for item in reversed(records) if item not in active
                ]
                records = active + inactive[
                    : max(0, MCP_TOKEN_RECORD_LIMIT - len(active) - 1)
                ]
            records.append(record)
            self._write(records)
        return {"token": raw_token, "client": self._public(record, now)}

    def revoke(self, token_id: str) -> dict[str, Any]:
        self._ensure_root()
        with project_file_lock(
            self.root,
            "tokens",
            busy_error="mcp_token_store_busy",
            busy_message="Another process is currently updating MCP tokens.",
        ):
            records = self._load()
            record = next((item for item in records if item["id"] == token_id), None)
            if record is None:
                raise ApiError("mcp_token_not_found", "The MCP token was not found.", 404)
            if record.get("revoked_at") is None:
                record["revoked_at"] = self._now().isoformat()
                self._write(records)
        return self._public(record, self._now())

    def authenticate(
        self,
        raw_token: str,
        *,
        allowed_scopes: frozenset[str],
    ) -> MCPAuthorization | None:
        candidate_hash = self._hash(raw_token)
        now = self._now()
        match = None
        for record in self._load():
            if secrets.compare_digest(candidate_hash, record["secret_hash"]):
                match = record
        if match is None or self._status(match, now) != "active":
            return None
        scopes = frozenset(match["scopes"]) & allowed_scopes
        if not scopes:
            return None
        self._record_use(match["id"], now)
        return MCPAuthorization(
            identity=f"mcp:token:{match['id']}",
            token_id=match["id"],
            scopes=scopes,
        )

    def _record_use(self, token_id: str, now: datetime) -> None:
        timestamp = now.timestamp()
        with self._cache_lock:
            self._pending_last_used[token_id] = timestamp
            due = timestamp - self._last_flush_at >= MCP_TOKEN_LAST_USED_FLUSH_SECONDS
        if due:
            self._flush_last_used(now)

    def _flush_last_used(self, now: datetime) -> None:
        with self._cache_lock:
            pending = dict(self._pending_last_used)
        if not pending:
            return
        try:
            with project_file_lock(
                self.root,
                "tokens",
                busy_error="mcp_token_store_busy",
                busy_message="Another process is currently updating MCP tokens.",
            ):
                records = self._load()
                changed = False
                for record in records:
                    seen = pending.get(record["id"])
                    if seen is None:
                        continue
                    previous = record.get("last_used_at")
                    previous_ts = (
                        datetime.fromisoformat(previous).timestamp()
                        if isinstance(previous, str)
                        else None
                    )
                    if previous_ts is None or previous_ts < seen:
                        record["last_used_at"] = datetime.fromtimestamp(
                            seen, timezone.utc
                        ).isoformat()
                        changed = True
                if changed:
                    self._write(records)
        except (ApiError, OSError):
            # last_used_at is diagnostic bookkeeping; a busy or temporarily
            # unavailable store must never break authentication. The next
            # successful flush will catch up.
            return
        with self._cache_lock:
            self._last_flush_at = now.timestamp()
            self._pending_last_used.clear()

    def _load(self) -> list[dict[str, Any]]:
        if self.root.exists() and (self.root.is_symlink() or not self.root.is_dir()):
            raise ApiError("mcp_token_store_unsafe", "The MCP token store is unsafe.", 500)
        if self.path.is_symlink():
            raise ApiError("mcp_token_store_unsafe", "The MCP token store is unsafe.", 500)
        try:
            descriptor = os.open(
                self.path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            )
        except FileNotFoundError:
            with self._cache_lock:
                self._cache_signature = None
                self._cache_records = tuple()
            return []
        except OSError as exc:
            raise ApiError(
                "mcp_token_store_unavailable",
                "The MCP token store cannot be read.",
                500,
            ) from exc
        try:
            file_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(file_stat.st_mode)
                or file_stat.st_size > MCP_TOKEN_STORE_MAX_BYTES
            ):
                raise ApiError(
                    "mcp_token_store_invalid",
                    "The MCP token store is invalid.",
                    500,
                )
            signature = (
                file_stat.st_dev,
                file_stat.st_ino,
                file_stat.st_mtime_ns,
                file_stat.st_size,
            )
            with self._cache_lock:
                if (
                    self._cache_records is not None
                    and signature == self._cache_signature
                ):
                    return [dict(item) for item in self._cache_records]
            with os.fdopen(descriptor, "rb", closefd=True) as stream:
                descriptor = -1
                raw = stream.read(MCP_TOKEN_STORE_MAX_BYTES + 1)
            if len(raw) > MCP_TOKEN_STORE_MAX_BYTES:
                raise ApiError(
                    "mcp_token_store_invalid",
                    "The MCP token store is invalid.",
                    500,
                )
            payload = json.loads(raw.decode("utf-8"))
        except ApiError:
            raise
        except (OSError, UnicodeDecodeError, ValueError, TypeError) as exc:
            raise ApiError(
                "mcp_token_store_unavailable",
                "The MCP token store cannot be read.",
                500,
            ) from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        records = payload.get("tokens") if isinstance(payload, dict) else None
        if (
            not isinstance(payload, dict)
            or payload.get("version") != 1
            or not isinstance(records, list)
            or len(records) > MCP_TOKEN_RECORD_LIMIT
        ):
            raise ApiError("mcp_token_store_invalid", "The MCP token store is invalid.", 500)
        validated = []
        seen_ids: set[str] = set()
        seen_hashes: set[str] = set()
        skipped = 0
        for item in records:
            # A single corrupted or duplicated record (partial write, disk
            # fault, manual edit) must not take every other valid token
            # offline; skip it and let the store self-heal on the next write.
            if (
                not self._valid_record(item)
                or item["id"] in seen_ids
                or item["secret_hash"] in seen_hashes
            ):
                skipped += 1
                continue
            seen_ids.add(item["id"])
            seen_hashes.add(item["secret_hash"])
            validated.append(dict(item))
        with self._cache_lock:
            self._cache_signature = signature
            self._cache_records = tuple(dict(item) for item in validated)
            self._skipped_invalid_records = skipped
        return [dict(item) for item in validated]

    @property
    def skipped_invalid_record_count(self) -> int:
        """Number of corrupted/duplicate records dropped on the last read."""
        with self._cache_lock:
            return self._skipped_invalid_records

    def _write(self, records: list[dict[str, Any]]) -> None:
        self._ensure_root()
        if self.path.is_symlink():
            raise ApiError("mcp_token_store_unsafe", "The MCP token store is unsafe.", 500)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".tokens.",
            dir=self.root,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(
                    {"version": 1, "tokens": records},
                    stream,
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, self.path)
            os.chmod(self.path, 0o600)
            self._invalidate_cache()
        except BaseException:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    @staticmethod
    def _valid_record(item: Any) -> bool:
        if not isinstance(item, dict):
            return False
        scopes = item.get("scopes")
        revoked_at = item.get("revoked_at")
        last_used_at = item.get("last_used_at")
        return (
            isinstance(item.get("id"), str)
            and len(item["id"]) == 24
            and all(char in "0123456789abcdef" for char in item["id"])
            and isinstance(item.get("name"), str)
            and 1 <= len(item["name"]) <= 80
            and not any(ord(char) < 32 for char in item["name"])
            and isinstance(item.get("secret_hash"), str)
            and len(item["secret_hash"]) == 64
            and all(char in "0123456789abcdef" for char in item["secret_hash"])
            and isinstance(scopes, list)
            and bool(scopes)
            and all(isinstance(scope, str) for scope in scopes)
            and len(scopes) == len(set(scopes))
            and set(scopes) <= ALL_SCOPES
            and MCPTokenStore._valid_timestamp(item.get("created_at"))
            and MCPTokenStore._valid_timestamp(item.get("expires_at"))
            and (revoked_at is None or MCPTokenStore._valid_timestamp(revoked_at))
            and (last_used_at is None or MCPTokenStore._valid_timestamp(last_used_at))
        )

    @staticmethod
    def _valid_timestamp(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return False
        return parsed.tzinfo is not None

    @classmethod
    def _public(cls, item: dict[str, Any], now: datetime) -> dict[str, Any]:
        return {
            "id": item["id"],
            "name": item["name"],
            "scopes": list(item["scopes"]),
            "created_at": item["created_at"],
            "expires_at": item["expires_at"],
            "revoked_at": item.get("revoked_at"),
            "last_used_at": item.get("last_used_at"),
            "status": cls._status(item, now),
        }

    @staticmethod
    def _status(item: dict[str, Any], now: datetime) -> str:
        if item.get("revoked_at"):
            return "revoked"
        try:
            expires_at = datetime.fromisoformat(item["expires_at"])
        except (TypeError, ValueError):
            return "invalid"
        if expires_at.tzinfo is None:
            return "invalid"
        return "expired" if expires_at <= now else "active"

    @staticmethod
    def _hash(raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    def _ensure_root(self) -> None:
        if self.root.is_symlink():
            raise ApiError("mcp_token_store_unsafe", "The MCP token store is unsafe.", 500)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink() or not self.root.is_dir():
            raise ApiError("mcp_token_store_unsafe", "The MCP token store is unsafe.", 500)

    def _invalidate_cache(self) -> None:
        with self._cache_lock:
            self._cache_signature = None
            self._cache_records = None

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)


class MCPTokenAuthenticator:
    """Authenticate managed tokens first and the legacy add-on token second."""

    def __init__(self, store: MCPTokenStore, legacy_token: str, access: str) -> None:
        self.store = store
        self.legacy_token = legacy_token
        self.legacy = authorization_for_token(legacy_token, access)
        self.allowed_scopes = READ_SCOPES | (
            WRITE_SCOPES if access == "project_write" else frozenset()
        )

    def authenticate(self, raw_token: str) -> MCPAuthorization | None:
        managed = self.store.authenticate(
            raw_token,
            allowed_scopes=self.allowed_scopes,
        )
        if managed is not None:
            return managed
        if secrets.compare_digest(raw_token, self.legacy_token):
            return self.legacy
        return None
