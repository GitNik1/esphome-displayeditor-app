from __future__ import annotations

from pathlib import Path

import pytest

from tools.bump_version import VersionError, bump_version


def _repository(root: Path, *, inconsistent: bool = False) -> None:
    config_version = "1.2.2" if inconsistent else "1.2.3"
    files = {
        "backend/version.py": 'APP_VERSION = "1.2.3"\n',
        "config.yaml": f'version: "{config_version}"\n',
        "frontend/index.html": (
            '<link href="styles.css?v=1.2.3">\n'
            '<script src="app.js?v=1.2.3"></script>\n'
        ),
        "tests/test_api.py": (
            "assert 'styles.css?v=1.2.3' in response.text\n"
            "assert 'app.js?v=1.2.3' in response.text\n"
        ),
        "clients/claude-desktop/manifest.json": (
            '{\n  "manifest_version": "0.4",\n  "version": "1.2.3"\n}\n'
        ),
        "CHANGELOG.md": (
            "# Changelog\n\n"
            "## Unreleased\n\n"
            "- Bereits vorbereitete Änderung.\n\n"
            "## 1.2.3\n\n"
            "- Vorherige Version.\n"
        ),
    }
    for relative_path, text in files.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def test_minor_bump_updates_every_version_and_releases_changelog(tmp_path: Path) -> None:
    _repository(tmp_path)

    current, new, changed = bump_version(
        tmp_path, "minor", notes=["Zusätzliche Änderung."]
    )

    assert str(current) == "1.2.3"
    assert str(new) == "1.3.0"
    assert len(changed) == 6
    for relative_path in (
        "backend/version.py",
        "config.yaml",
        "frontend/index.html",
        "tests/test_api.py",
        "clients/claude-desktop/manifest.json",
    ):
        text = (tmp_path / relative_path).read_text(encoding="utf-8")
        assert "1.3.0" in text
        assert "1.2.3" not in text
    changelog = (tmp_path / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "## Unreleased\n\n## 1.3.0\n" in changelog
    assert changelog.index("Zusätzliche Änderung.") < changelog.index("## 1.2.3")
    assert changelog.index("Bereits vorbereitete Änderung.") < changelog.index("## 1.2.3")


def test_dry_run_calculates_patch_without_writing(tmp_path: Path) -> None:
    _repository(tmp_path)
    before = (tmp_path / "config.yaml").read_text(encoding="utf-8")

    current, new, _changed = bump_version(tmp_path, "patch", dry_run=True)

    assert str(current) == "1.2.3"
    assert str(new) == "1.2.4"
    assert (tmp_path / "config.yaml").read_text(encoding="utf-8") == before


def test_inconsistent_repository_is_rejected_before_writing(tmp_path: Path) -> None:
    _repository(tmp_path, inconsistent=True)
    before = (tmp_path / "backend/version.py").read_text(encoding="utf-8")

    with pytest.raises(VersionError, match="nicht konsistent"):
        bump_version(tmp_path, "major")

    assert (tmp_path / "backend/version.py").read_text(encoding="utf-8") == before
