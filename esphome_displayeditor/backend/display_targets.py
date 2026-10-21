"""Which display the merged ``lvgl:`` block draws on, and what stands in its way.

Two things go wrong when a Designer project is merged into a configuration
that was not built for LVGL:

* ``lvgl: displays:`` names an id the configuration never defined - a new
  project's placeholder is ``my_display`` - or the display has no id at all.
  The id is therefore resolved against the target file, and ``displays:`` is
  left out when the display has none (LVGL then uses the only display).
* The display draws by itself. ESPHome rejects ``lambda:``, ``pages:``,
  ``auto_clear_enabled: true`` and ``show_test_card: true`` on a display LVGL
  uses. Those keys are reported, and only after the user confirmed are they
  commented out in place - the drawing code stays in the file for reference
  and can be deleted by hand later.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

import yaml

from .designer_core.model import Project
from .designer_core.yamlexport import ExportIssue
from .designer_core.yamlimport import _ImportLoader
from .yaml_patch import _dump, _Patcher

#: Display keys ESPHome's LVGL component refuses ("has_writer").
_WRITER_KEYS = ("lambda", "pages", "auto_clear_enabled", "show_test_card")

COMMENT_MARKER = (
    "# LVGL-Designer: auskommentiert, weil jetzt LVGL dieses Display zeichnet"
    " - kann manuell geloescht werden."
)


@dataclass
class DisplayConflict:
    display_id: str
    keys: list[str]
    #: (first line index, last line index, key column) per key, 0-based.
    ranges: list[tuple[int, int, int]] = field(default_factory=list)
    #: The display's mapping node in the content the conflict was found in.
    node: yaml.MappingNode | None = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        return {"display_id": self.display_id, "keys": list(self.keys),
                "line": self.ranges[0][0] + 1 if self.ranges else None}


def _root(content: str) -> yaml.MappingNode | None:
    try:
        root = yaml.compose(content, Loader=_ImportLoader)
    except yaml.YAMLError:
        return None
    return root if isinstance(root, yaml.MappingNode) else None


def _display_value(root: yaml.MappingNode | None) -> yaml.Node | None:
    for key, value in (root.value if root else []):
        if isinstance(key, yaml.ScalarNode) and key.value == "display":
            return value
    return None


def _display_nodes(content: str) -> list[yaml.MappingNode]:
    value = _display_value(_root(content))
    if value is None:
        return []
    items = value.value if isinstance(value, yaml.SequenceNode) else [value]
    return [item for item in items if isinstance(item, yaml.MappingNode)]


def display_source_note(content: str) -> str | None:
    """A display this file does not fully contain - from ``packages:``, an
    ``!include`` or a ``<<:`` merge - cannot be checked here; ESPHome would
    still refuse a lambda in it next to LVGL."""
    root = _root(content)
    value = _display_value(root)
    has_packages = any(isinstance(k, yaml.ScalarNode) and k.value == "packages"
                       for k, _ in (root.value if root else []))
    items = [] if value is None else (value.value if isinstance(value, yaml.SequenceNode) else [value])
    external = value is not None and (
        any(not isinstance(item, yaml.MappingNode) for item in items)
        or any(isinstance(k, yaml.ScalarNode) and k.value == "<<"
               for item in items if isinstance(item, yaml.MappingNode) for k, _ in item.value)
    )
    if external or (value is None and has_packages):
        return ("The display is (partly) defined outside this file (packages:, !include or <<:). "
                "If it has lambda:, pages:, auto_clear_enabled: true or show_test_card: true, "
                "remove them there - ESPHome refuses them next to LVGL.")
    return None


def _scalar(node: yaml.MappingNode, name: str) -> str | None:
    for key, value in node.value:
        if isinstance(key, yaml.ScalarNode) and key.value == name and isinstance(value, yaml.ScalarNode):
            return value.value
    return None


def _stated_lvgl_displays(content: str) -> list[str]:
    """``lvgl: displays:`` as the target file already states it."""
    for key, value in (_root(content) or yaml.MappingNode("", [])).value:
        if isinstance(key, yaml.ScalarNode) and key.value == "lvgl" and isinstance(value, yaml.MappingNode):
            for sub_key, sub_value in value.value:
                if isinstance(sub_key, yaml.ScalarNode) and sub_key.value == "displays":
                    items = sub_value.value if isinstance(sub_value, yaml.SequenceNode) else [sub_value]
                    return [i.value for i in items if isinstance(i, yaml.ScalarNode)]
    return []


def resolve_display_placeholder(project: Project, content: str) -> tuple[Project, list[ExportIssue]]:
    """A copy of ``project`` whose display placeholder names a display of
    ``content`` - or is empty when the display has no id."""
    displays = _display_nodes(content)
    ids = [i for i in (_scalar(d, "id") for d in displays) if i]
    wanted = project.display_id_placeholder
    if not wanted or wanted in ids or wanted in _stated_lvgl_displays(content):
        return project, []
    # Shallow: bindings/entities ride along as plain attributes, not fields.
    resolved = copy.copy(project)
    issues: list[ExportIssue] = []
    if not displays:
        # The display lives in packages:/!include (or nowhere): its id is
        # unknown here. Leaving displays: out lets LVGL take the only
        # display, instead of naming one that may not exist.
        resolved.display_id_placeholder = ""
        issues.append(ExportIssue(
            "B", f"No display is defined in this file; lvgl: displays: was left out instead "
                 f"of naming '{wanted}'. Add it if the configuration has several displays."))
    elif len(displays) == 1:
        resolved.display_id_placeholder = ids[0] if ids else ""
    elif ids:
        resolved.display_id_placeholder = ids[0]
        issues.append(ExportIssue(
            "B", f"The configuration has {len(displays)} displays; LVGL was assigned to "
                 f"'{ids[0]}'. Change lvgl: displays: if another one is meant."))
    else:
        resolved.display_id_placeholder = ""
    return resolved, issues


def _last_line(lines: list[str], node: yaml.Node) -> int:
    return _Patcher(lines, False).last_line(node)


def find_display_conflicts(content: str, display_id: str) -> list[DisplayConflict]:
    """Writer keys on the display(s) LVGL will draw on: the one with
    ``display_id``, or every display when no id is set."""
    lines = content.splitlines(keepends=True)
    conflicts = []
    for node in _display_nodes(content):
        node_id = _scalar(node, "id") or ""
        if display_id and node_id != display_id:
            continue
        found = DisplayConflict(display_id=node_id, keys=[], node=node)
        for key, value in node.value:
            name = key.value if isinstance(key, yaml.ScalarNode) else None
            if name not in _WRITER_KEYS:
                continue
            if name in {"auto_clear_enabled", "show_test_card"} and not (
                isinstance(value, yaml.ScalarNode) and value.value.lower() in {"true", "yes", "on"}
            ):
                continue
            found.keys.append(name)
            found.ranges.append((key.start_mark.line, _last_line(lines, value), key.start_mark.column))
        if found.keys:
            conflicts.append(found)
    return conflicts


class DisplayCommentError(Exception):
    """A writer key cannot be commented out without breaking the YAML."""


#: What may precede a block mapping's first key on its line: a list dash.
_DASH = re.compile(r"\s*-\s+")


def _commented(lines: list[str], start: int, end: int, column: int) -> list[str]:
    return [
        f"{' ' * column}# {lines[index][column:]}" if lines[index].strip() else lines[index]
        for index in range(start, end + 1)
    ]


def _block_edits(lines: list[str], conflict: DisplayConflict,
                 newline: str) -> list[tuple[int, int, list[str]]]:
    node = conflict.node
    if node is not None and len(node.value) == len(conflict.keys):
        raise DisplayCommentError(
            f"Display '{conflict.display_id or 'display'}' consists of nothing but "
            f"{', '.join(conflict.keys)}; it has no platform to keep.")
    edits = []
    for index, (start, end, column) in enumerate(conflict.ranges):
        prefix = lines[start][:column]
        body = _commented(lines, start, end, column)
        if index:
            edits.append((start, end, body))
        elif not prefix.strip():
            edits.append((start, end, [" " * column + COMMENT_MARKER + newline, *body]))
        elif _DASH.fullmatch(prefix):
            # `- lambda: ...` opens the list entry. The dash stays, carrying
            # the marker; `- # comment` followed by the indented keys is the
            # same entry to YAML (and to ESPHome's loader).
            edits.append((start, end, [prefix + COMMENT_MARKER + newline, *body]))
        else:
            raise DisplayCommentError(
                f"'{conflict.keys[index]}' of display '{conflict.display_id}' shares its line "
                "with other YAML and cannot be commented out on its own.")
    return edits


def _flow_edit(lines: list[str], conflict: DisplayConflict,
               newline: str) -> tuple[int, int, list[str]]:
    """``- {platform: x, lambda: ...}``: one line cannot be half commented,
    so this one entry is rewritten in block style with the drawing keys as
    comments above the rest."""
    node = conflict.node
    assert node is not None
    start, end = node.start_mark.line, node.end_mark.line
    prefix = lines[start][:node.start_mark.column]
    tail = lines[end][node.end_mark.column:].strip()
    if tail and not tail.startswith("#"):
        raise DisplayCommentError(
            f"Display '{conflict.display_id or 'display'}' sits in a flow list; "
            "write it in block style and save again.")
    loader = _ImportLoader("")
    data = loader.construct_document(node)
    remaining = {key: value for key, value in data.items() if key not in conflict.keys}
    if not remaining:
        raise DisplayCommentError(
            f"Display '{conflict.display_id or 'display'}' consists of nothing but "
            f"{', '.join(conflict.keys)}; it has no platform to keep.")
    commented = [f"# {line.rstrip()}" for key in conflict.keys
                 for line in _dump({key: data[key]}, indented_sequences=True)]
    body = [line.rstrip() for line in _dump(remaining, indented_sequences=True)]
    if _DASH.fullmatch(prefix):
        indent = len(prefix)
        out = [prefix + COMMENT_MARKER]
    elif prefix.strip().endswith(":"):
        indent = len(prefix) - len(prefix.lstrip()) + 2
        out = [prefix.rstrip(), " " * indent + COMMENT_MARKER]
    else:
        raise DisplayCommentError(
            f"Display '{conflict.display_id or 'display'}' sits in a flow list; "
            "write it in block style and save again.")
    out += [" " * indent + line for line in [*commented, *body]]
    if tail:
        out[-1] += f"  {tail}"
    return start, end, [line + newline for line in out]


def comment_out_display_conflicts(content: str, conflicts: list[DisplayConflict]) -> str:
    """Comment out every conflicting key with its whole value, under one
    marker line per display."""
    lines = content.splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
    edits: list[tuple[int, int, list[str]]] = []
    for conflict in conflicts:
        if conflict.node is not None and conflict.node.flow_style:
            edits.append(_flow_edit(lines, conflict, newline))
        else:
            edits.extend(_block_edits(lines, conflict, newline))
    for start, end, replacement in sorted(edits, reverse=True):
        lines[start:end + 1] = replacement
    return "".join(lines)
