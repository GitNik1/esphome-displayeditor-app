"""Replace a file in one step - the one way the add-on writes its files."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

#: Permission bits of a file that did not exist before: the add-on's own
#: data (projects, drafts, tokens) is private to the add-on.
NEW_FILE_MODE = 0o600


def write_atomic(path: Path, data: bytes, *, mode: int | None = None) -> None:
    """Write ``data`` to ``path`` so that a crash leaves the old or the new
    file, never a mix of both.

    - The data goes to a temporary file next to ``path`` (a rename is only
      atomic within one filesystem), is flushed and fsynced, and then
      renamed over ``path``; the directory is fsynced as well, so the rename
      itself survives a power cut.
    - Without ``mode`` the file keeps the permission bits of the file it
      replaces. The temporary file starts as 0600, so publishing used to
      leave the user's ESPHome YAML readable by its owner only. A new file
      gets ``NEW_FILE_MODE``; pass ``mode`` for secrets that must stay 0600.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode is None:
        mode = _existing_mode(path)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    _fsync_directory(path.parent)


def _existing_mode(path: Path) -> int:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return NEW_FILE_MODE
    # A symlink's own bits (0777) must never end up on a regular file.
    return stat.S_IMODE(info.st_mode) if stat.S_ISREG(info.st_mode) else NEW_FILE_MODE


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return  # Windows cannot open a directory; its renames need no fsync.
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)
