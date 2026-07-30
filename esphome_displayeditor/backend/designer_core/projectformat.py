"""Save/load the .lvgldesign project file (plain JSON, versioned).

A plain text format on purpose: ESPHome workflows are file-based (YAML plus
separate image/font files), so a project referencing external resource
files by path fits better than glowline-editor's embedded-binary .glraw
container - there would be several heterogeneous resources to embed here,
not one background image.
"""

from __future__ import annotations

import json

from .model import PROJECT_FORMAT, PROJECT_FORMAT_VERSION, Project


class ProjectFormatError(Exception):
    pass


def save_project(path: str, project: Project) -> None:
    data = project.to_dict()
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def load_project(path: str) -> Project:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    fmt = data.get("format")
    if fmt != PROJECT_FORMAT:
        raise ProjectFormatError(f"Not an ESPHome LVGL Designer project file: {path}")
    version = int(data.get("format_version", 1))
    if version > PROJECT_FORMAT_VERSION:
        raise ProjectFormatError(
            f"This project was saved by a newer version of the tool "
            f"(format {version}, this build supports up to {PROJECT_FORMAT_VERSION}).")
    return Project.from_dict(data)
