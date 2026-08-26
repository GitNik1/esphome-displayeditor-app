"""Per-identity concurrency limiting for synchronous MCP tool handlers.

MCP tool handlers registered via ``@server.tool`` are plain (non-async)
callables that the SDK runs in a thread pool, so multiple calls from the same
authenticated identity can execute genuinely concurrently. Without a limit, a
single identity could exhaust the thread pool or hammer the shared project
store with parallel requests; the MCP implementation plan bounds this to a
small number of concurrent reads and a single concurrent write per identity.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import threading

from ..errors import ApiError
from .limits import (
    MCP_CONCURRENT_READS_PER_IDENTITY,
    MCP_CONCURRENT_WRITES_PER_IDENTITY,
)


class ConcurrencyLimiter:
    """Bounds concurrent in-flight calls per ``(identity, write)`` bucket."""

    def __init__(self, *, read_limit: int, write_limit: int) -> None:
        self._read_limit = read_limit
        self._write_limit = write_limit
        self._lock = threading.Lock()
        self._counts: dict[tuple[str, bool], int] = {}

    @contextmanager
    def slot(self, identity: str, *, write: bool) -> Iterator[None]:
        key = (identity, write)
        limit = self._write_limit if write else self._read_limit
        with self._lock:
            current = self._counts.get(key, 0)
            if current >= limit:
                raise ApiError(
                    "too_many_concurrent_mcp_requests",
                    "Too many concurrent MCP requests for this identity; retry shortly.",
                    429,
                    {"limit": limit, "write": write},
                )
            self._counts[key] = current + 1
        try:
            yield
        finally:
            with self._lock:
                remaining = self._counts.get(key, 0) - 1
                if remaining <= 0:
                    self._counts.pop(key, None)
                else:
                    self._counts[key] = remaining


_default_limiter = ConcurrencyLimiter(
    read_limit=MCP_CONCURRENT_READS_PER_IDENTITY,
    write_limit=MCP_CONCURRENT_WRITES_PER_IDENTITY,
)


def default_limiter() -> ConcurrencyLimiter:
    """The process-wide limiter shared by every MCP server instance.

    Concurrency must be bounded per operating-system process (the real
    resource being protected is the thread pool and the shared project
    store), not per MCP server object, so a single module-level instance is
    intentional here.
    """
    return _default_limiter
