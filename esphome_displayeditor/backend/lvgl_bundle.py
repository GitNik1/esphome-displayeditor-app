"""Bundle a Designer project's generated ``ui.yaml`` plus its locally
uploaded image/font assets into a single downloadable ZIP.

Add-on-only, same reasoning as ``lvgl_merge.py``/``page_support.py``:
nothing here touches the shared, desktop-compatible designer core. The
in-memory ``export_project()`` path already copies local assets into a
temporary ``assets/`` folder next to the generated file, but that folder is
deleted the moment the temporary directory context exits - the copies never
reach the browser. This module reads the same local assets a second way,
straight from where they already live (``images/``/``fonts/`` under the
config root, exactly as ``write_image_asset``/``write_font_asset`` place
them), and packages them at that same relative path inside the ZIP - so
extracting the ZIP directly into the config root reproduces exactly what is
already there, no path rewriting needed.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field

from .designer_core.model import Project
from .errors import ApiError
from .filesystem import FilesystemBackend


def _is_remote(path: str) -> bool:
    return path.startswith(("http://", "https://"))


def collect_local_asset_paths(project: Project) -> list[str]:
    """Relative paths of every locally-uploaded (not ``external``, not a
    remote URL) image/font this project references - the ones that need
    bundling. An imported/``external`` asset's path already belongs to,
    and is already correct relative to, the config it came from; bundling
    it here would be both redundant and read a file this add-on has no
    business copying around."""
    paths: list[str] = []
    for image in project.images:
        if image.external or not image.file_path or _is_remote(image.file_path):
            continue
        paths.append(image.file_path)
    if project.background.export_as_lvgl_image and project.background.path:
        if not _is_remote(project.background.path):
            paths.append(project.background.path)
    for font in project.fonts:
        if font.external or font.source_kind != "file" or not font.file_path:
            continue
        if _is_remote(font.file_path):
            continue
        paths.append(font.file_path)

    seen: set[str] = set()
    result: list[str] = []
    for path in paths:
        if path not in seen:
            seen.add(path)
            result.append(path)
    return result


@dataclass
class BundleResult:
    content: bytes
    missing_assets: list[str] = field(default_factory=list)


def build_project_zip(yaml_text: str, project: Project, filesystem: FilesystemBackend) -> BundleResult:
    buffer = io.BytesIO()
    missing: list[str] = []
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("ui.yaml", yaml_text)
        for path in collect_local_asset_paths(project):
            try:
                content, _content_type = filesystem.read_asset(path)
            except ApiError:
                missing.append(path)
                continue
            archive.writestr(path, content)
    return BundleResult(content=buffer.getvalue(), missing_assets=missing)
