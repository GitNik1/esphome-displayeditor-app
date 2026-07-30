"""Stable API error types."""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(
        self,
        error: str,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error = error
        self.message = message
        self.status_code = status_code
        self.details = details or {}


def capability_unavailable(capability: str, profile: str) -> ApiError:
    return ApiError(
        "capability_unavailable",
        f"Capability '{capability}' is unavailable in the current profile.",
        403,
        {"capability": capability, "profile": profile},
    )

