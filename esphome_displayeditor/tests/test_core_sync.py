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
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parents[1] / "backend" / "designer_core"
DESKTOP = (
    Path(__file__).resolve().parents[3] / "esphome-lvgl-designer" / "lvgldesigner"
)

#: Modules that must be byte-identical in both trees. ``__init__.py`` is
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
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
