"""The designer core is duplicated, not shared.

``backend/designer_core/`` is a verbatim copy of the desktop application's
``lvgldesigner/`` modules. That duplication is deliberate for now (extracting a
shared package would couple a build-system change to feature work), but it is
only safe while the two stay identical: every dataclass reads its fields with
``d.get(key, default)``, so a desktop build older than the add-on would load a
newer project file, silently drop every field it does not know, and write the
truncated version back.

``PROJECT_FORMAT_VERSION`` is the guard against that (both entry points refuse
an unknown version). This test is the guard against the guard drifting: it
fails the moment one copy is edited without the other.

Skipped inside the add-on container, where only one copy exists.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parents[1] / "backend" / "designer_core"


def _desktop_core() -> Path:
    """The desktop checkout next to this repository - found from any depth,
    so a git worktree (``.claude/worktrees/<name>/...``) runs the check too;
    ``ESPHOME_DESKTOP_DESIGNER`` points at it explicitly (e.g. in CI)."""
    configured = os.getenv("ESPHOME_DESKTOP_DESIGNER")
    if configured:
        return Path(configured) / "lvgldesigner"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "esphome-lvgl-designer" / "lvgldesigner"
        if candidate.is_dir():
            return candidate
    return Path(__file__).resolve().parents[3] / "esphome-lvgl-designer" / "lvgldesigner"


DESKTOP = _desktop_core()

#: Modules that must be identical in both trees (up to line endings). ``__init__.py`` is
#: excluded: the package docstring legitimately differs between the two.
SHARED_MODULES = (
    "model.py",
    "widgetschema.py",
    "yamlexport.py",
    "yamlimport.py",
    "projectformat.py",
    "idgen.py",
)


def _digest(path: Path) -> str:
    # Line endings are a checkout setting, not content: the add-on forces LF
    # (.gitattributes), a Windows desktop checkout may have CRLF.
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


@pytest.mark.skipif(not DESKTOP.is_dir(), reason="desktop checkout not present")
@pytest.mark.parametrize("name", SHARED_MODULES)
def test_designer_core_matches_desktop(name: str) -> None:
    ours, theirs = CORE / name, DESKTOP / name

    assert theirs.is_file(), f"{name} is missing from the desktop checkout"
    assert _digest(ours) == _digest(theirs), (
        f"{name} differs between the add-on and the desktop designer. "
        f"Apply the change to both copies:\n  {ours}\n  {theirs}"
    )


def test_shared_module_list_is_complete() -> None:
    """A new module added to designer_core must be added to SHARED_MODULES
    too, otherwise it silently escapes the sync check above."""
    present = {p.name for p in CORE.glob("*.py")} - {"__init__.py"}

    assert present == set(SHARED_MODULES), (
        "designer_core module list changed; update SHARED_MODULES. "
        f"Unlisted: {sorted(present - set(SHARED_MODULES))}"
    )
