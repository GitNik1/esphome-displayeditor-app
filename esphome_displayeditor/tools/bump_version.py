#!/usr/bin/env python3
"""Increase the add-on version and create its changelog release section.

Examples::

    python tools/bump_version.py patch
    python tools/bump_version.py minor --note "Neue Designer-Funktion"
    python tools/bump_version.py 1.0.0 --dry-run
"""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[1]
SEMVER_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class VersionError(RuntimeError):
    """Raised when the repository's version state cannot be updated safely."""


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, value: str) -> "Version":
        match = SEMVER_PATTERN.fullmatch(value.strip())
        if not match:
            raise VersionError(
                f"Ungültige Version '{value}'. Erwartet wird MAJOR.MINOR.PATCH."
            )
        return cls(*(int(part) for part in match.groups()))

    def bump(self, part: str) -> "Version":
        if part == "major":
            return Version(self.major + 1, 0, 0)
        if part == "minor":
            return Version(self.major, self.minor + 1, 0)
        if part == "patch":
            return Version(self.major, self.minor, self.patch + 1)
        raise VersionError(f"Unbekannter Versionsschritt: {part}")

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


@dataclass(frozen=True)
class VersionTarget:
    relative_path: str
    pattern: re.Pattern[str]
    replacement: Callable[[re.Match[str], str], str]


def _surrounded(match: re.Match[str], version: str) -> str:
    return f"{match.group(1)}{version}{match.group(3)}"


def _cache_parameter(match: re.Match[str], version: str) -> str:
    return f"{match.group(1)}{version}"


VERSION_TARGETS = (
    VersionTarget(
        "backend/version.py",
        re.compile(r'(?m)^(APP_VERSION\s*=\s*")(\d+\.\d+\.\d+)("\s*)$'),
        _surrounded,
    ),
    VersionTarget(
        "config.yaml",
        re.compile(r'(?m)^(version:\s*")(\d+\.\d+\.\d+)("\s*)$'),
        _surrounded,
    ),
    VersionTarget(
        "frontend/index.html",
        re.compile(r'([?&]v=)(\d+\.\d+\.\d+)'),
        _cache_parameter,
    ),
    VersionTarget(
        "tests/test_api.py",
        re.compile(r'([?&]v=)(\d+\.\d+\.\d+)'),
        _cache_parameter,
    ),
)


def _read_versioned_files(root: Path) -> tuple[Version, dict[Path, str]]:
    contents: dict[Path, str] = {}
    detected: list[tuple[Path, str]] = []
    for target in VERSION_TARGETS:
        path = root / target.relative_path
        if not path.is_file():
            raise VersionError(f"Versionsdatei fehlt: {target.relative_path}")
        text = path.read_text(encoding="utf-8")
        matches = list(target.pattern.finditer(text))
        if not matches:
            raise VersionError(f"Keine Version in {target.relative_path} gefunden.")
        contents[path] = text
        detected.extend((path, match.group(2)) for match in matches)

    versions = {value for _path, value in detected}
    if len(versions) != 1:
        details = ", ".join(
            f"{path.relative_to(root)}={value}" for path, value in detected
        )
        raise VersionError(f"Versionsangaben sind nicht konsistent: {details}")
    return Version.parse(versions.pop()), contents


def _release_changelog(text: str, version: Version, notes: list[str]) -> str:
    heading = f"## {version}"
    if re.search(rf"(?m)^{re.escape(heading)}\s*$", text):
        raise VersionError(f"CHANGELOG.md enthält bereits den Abschnitt {heading}.")

    lines = text.splitlines(keepends=True)
    try:
        unreleased = next(
            index for index, line in enumerate(lines) if line.rstrip() == "## Unreleased"
        )
    except StopIteration as exc:
        raise VersionError("CHANGELOG.md enthält keinen Abschnitt '## Unreleased'.") from exc

    next_heading = next(
        (
            index
            for index in range(unreleased + 1, len(lines))
            if lines[index].startswith("## ")
        ),
        len(lines),
    )
    body = lines[unreleased + 1:next_heading]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    if notes:
        note_lines = [f"- {note.strip()}\n" for note in notes if note.strip()]
        body = note_lines + (["\n"] if note_lines and body else []) + body

    release = ["\n", f"{heading}\n", "\n"]
    if body:
        release.extend(body)
        if release[-1].strip():
            release.append("\n")
    return "".join(lines[:unreleased + 1] + release + lines[next_heading:])


def _atomic_write(path: Path, text: str) -> None:
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def bump_version(
    root: Path,
    requested: str,
    *,
    notes: list[str] | None = None,
    dry_run: bool = False,
) -> tuple[Version, Version, list[Path]]:
    current, contents = _read_versioned_files(root)
    if requested in {"major", "minor", "patch"}:
        new = current.bump(requested)
    else:
        new = Version.parse(requested)
    if new <= current:
        raise VersionError(f"Die neue Version {new} muss größer als {current} sein.")

    changed: dict[Path, str] = {}
    for target in VERSION_TARGETS:
        path = root / target.relative_path
        text = contents[path]

        def replace(match: re.Match[str]) -> str:
            if match.group(2) != str(current):
                raise VersionError(
                    f"Unerwartete Version {match.group(2)} in {target.relative_path}."
                )
            return target.replacement(match, str(new))

        changed[path] = target.pattern.sub(replace, text)

    changelog = root / "CHANGELOG.md"
    if not changelog.is_file():
        raise VersionError("CHANGELOG.md fehlt.")
    changed[changelog] = _release_changelog(
        changelog.read_text(encoding="utf-8"), new, notes or []
    )

    if not dry_run:
        for path, text in changed.items():
            _atomic_write(path, text)
    return current, new, list(changed)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Erhöht die Add-on-Version in Backend, config.yaml, Frontend-Cache, "
            "Tests und CHANGELOG.md."
        )
    )
    parser.add_argument(
        "version",
        help="Versionsschritt (patch, minor, major) oder Zielversion (z. B. 0.15.0)",
    )
    parser.add_argument(
        "--note",
        action="append",
        default=[],
        help="Changelog-Eintrag ohne '-'; kann mehrfach angegeben werden",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Änderungen nur anzeigen, keine Dateien schreiben",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        current, new, paths = bump_version(
            ROOT, args.version, notes=args.note, dry_run=args.dry_run
        )
    except VersionError as exc:
        print(f"Fehler: {exc}")
        return 2

    action = "Würde aktualisieren" if args.dry_run else "Aktualisiert"
    print(f"Version: {current} -> {new}")
    for path in paths:
        print(f"{action}: {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
