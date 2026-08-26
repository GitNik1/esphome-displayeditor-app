"""Unconditional secrets.yaml protection for the MCP/assistant-tools layer.

``FilesystemBackend``'s own secrets.yaml block (``_assert_access``) is gated
by the configurable ``protect_sensitive_paths`` setting - an administrator
can disable it for the REST API/browser UI. MCP, and anything built on
``AssistantToolService`` (including the in-app assistant), must never be
able to read ``secrets.yaml``/``secrets.yml`` regardless of that setting:
only ESPHome configuration YAML is in scope for machine-driven access. This
check is independent of and in addition to ``FilesystemBackend``'s own.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from ..errors import ApiError

_FORBIDDEN_NAMES = frozenset({"secrets.yaml", "secrets.yml"})


def assert_not_secrets_file(name: str) -> None:
    parts = {part.lower() for part in PurePosixPath(str(name)).parts}
    if parts & _FORBIDDEN_NAMES:
        raise ApiError(
            "secrets_file_protected",
            "secrets.yaml is never accessible through MCP or the assistant tools.",
            403,
        )
