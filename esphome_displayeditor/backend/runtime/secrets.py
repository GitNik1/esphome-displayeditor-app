"""Write-only-at-the-API-boundary storage for ESPHome Noise keys."""

from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

from ..errors import ApiError
from .registry import _SLUG, _atomic_json_write


class SecretStore:
    def __init__(self, data_root: Path) -> None:
        self.path = data_root / "runtime" / "native_api_keys.json"
        self._lock = threading.RLock()

    def _load(self) -> dict[str, str]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError) as exc:
            raise ApiError("secret_store_unavailable", "The device secret store cannot be read.", 500) from exc
        if not isinstance(raw, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in raw.items()):
            raise ApiError("secret_store_invalid", "The device secret store is invalid.", 500)
        return raw

    @staticmethod
    def validate_key(value: str) -> str:
        key = value.strip()
        try:
            decoded = base64.b64decode(key, validate=True)
        except (ValueError, base64.binascii.Error):
            decoded = b""
        if len(decoded) != 32:
            raise ApiError(
                "invalid_encryption_key",
                "The ESPHome encryption key must be Base64-encoded and decode to 32 bytes.",
                422,
            )
        return key

    def has(self, key_ref: str) -> bool:
        with self._lock:
            return key_ref in self._load()

    def get(self, key_ref: str) -> str | None:
        """Internal-only access. Callers must never return this value through the API."""
        with self._lock:
            return self._load().get(key_ref)

    def set(self, key_ref: str, value: str) -> None:
        if not _SLUG.fullmatch(key_ref):
            raise ApiError("invalid_key_reference", "The encryption key reference is invalid.", 422)
        key = self.validate_key(value)
        with self._lock:
            secrets = self._load()
            secrets[key_ref] = key
            _atomic_json_write(self.path, secrets)

    def delete(self, key_ref: str) -> bool:
        if not _SLUG.fullmatch(key_ref):
            raise ApiError("invalid_key_reference", "The encryption key reference is invalid.", 422)
        with self._lock:
            secrets = self._load()
            existed = secrets.pop(key_ref, None) is not None
            if existed:
                _atomic_json_write(self.path, secrets)
        return existed
