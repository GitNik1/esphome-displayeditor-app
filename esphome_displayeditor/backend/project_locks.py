"""Cross-process advisory locks for revision-protected project writes."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Any, Callable

from .errors import ApiError


@contextmanager
def project_file_lock(
    root: Path,
    name: str,
    timeout: float = 5.0,
    *,
    busy_error: str = "project_busy",
    busy_message: str = "Another process is currently updating this project.",
):
    lock_root = root / ".locks"
    lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if lock_root.is_symlink() or not lock_root.is_dir():
        raise ApiError("invalid_path", "Project lock directory is unsafe.")
    lock_path = lock_root / f"{name}.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        raise ApiError("invalid_path", "Project lock could not be opened safely.") from exc
    handle = os.fdopen(descriptor, "r+b", closefd=True)
    try:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                _lock(handle)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise ApiError(
                        busy_error,
                        busy_message,
                        409,
                    ) from exc
                time.sleep(0.05)
        try:
            yield
        finally:
            _unlock(handle)
    finally:
        handle.close()


def locked_project_write(method: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(method)
    def wrapped(store, name: str, *args, **kwargs):
        store._path(name)
        with project_file_lock(store.root, name):
            return method(store, name, *args, **kwargs)

    return wrapped


def _lock(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
