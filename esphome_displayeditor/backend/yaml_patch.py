"""Structural, comment-preserving rewrite of one top-level YAML block.

``lvgl_merge`` used to replace a whole top-level block (``lvgl:``,
``font:``, ...) with a fresh dump. PyYAML's dumper knows nothing about
comments or the author's formatting, so every comment inside the block -
commented-out widgets included - was lost on save, even when nothing near it
had changed.

This module instead diffs the block's parsed value against the generated one
and edits only the line ranges of entries that actually differ:

* equal subtrees keep their original text byte for byte;
* a changed mapping/sequence written in block style is descended into;
* a changed leaf, or a flow-style collection, is re-dumped at its own column;
* removed entries lose exactly their own lines, new ones are inserted after
  their predecessor.

Sequence items are matched by their ``id`` (``- label: {id: x}`` or
``- id: x``), so reordering or deleting a widget does not shift every
following item into a "changed" state.

Comments between entries are never part of an entry's range, so they stay
where they were. Every result is re-parsed and compared with the generated
value; on any mismatch or unsupported construct the caller falls back to the
old whole-block replacement.
"""

from __future__ import annotations

from typing import Any

import yaml

from .designer_core.yamlexport import ESPHomeDumper
from .designer_core.yamlimport import TaggedScalar, _ImportLoader, load_lvgl_yaml


class _Unpatchable(Exception):
    """The source uses a construct the line-based patcher cannot edit safely."""


def _lambda_text(value: str) -> str:
    """Lambda code without trailing whitespace on its lines. That whitespace
    means nothing to C++, but it stops PyYAML from writing a ``|-`` block -
    an edited lambda would come back as one escaped double-quoted line."""
    return "\n".join(line.rstrip() for line in str(value).split("\n"))


def same_yaml_value(a: Any, b: Any) -> bool:
    """Deep equality that, unlike ``==``, tells ``!lambda x`` from ``x`` and
    ``True`` from ``1`` - and ignores trailing whitespace inside lambdas."""
    if isinstance(a, dict):
        return (isinstance(b, dict) and set(a) == set(b)
                and all(same_yaml_value(a[key], b[key]) for key in a))
    if isinstance(a, list):
        return (isinstance(b, list) and len(a) == len(b)
                and all(same_yaml_value(x, y) for x, y in zip(a, b)))
    if isinstance(a, TaggedScalar) or isinstance(b, TaggedScalar):
        if not (isinstance(a, TaggedScalar) and isinstance(b, TaggedScalar)) or a.tag != b.tag:
            return False
        if a.tag == "!lambda":
            return _lambda_text(a) == _lambda_text(b)
        return str(a) == str(b)
    return type(a) is type(b) and a == b


class _IndentedSequenceDumper(ESPHomeDumper):
    """Writes ``key:\n  - item`` instead of PyYAML's ``key:\n- item``, the
    style ESPHome's own documentation (and most hand-written configs) use."""

    def increase_indentation(self, flow=False, indentless=False):
        return super().increase_indentation(flow, False)


def _dumpable(value: Any) -> Any:
    if isinstance(value, TaggedScalar) and value.tag == "!lambda" and "\n" in value:
        return TaggedScalar(_lambda_text(value), value.tag)
    if isinstance(value, dict):
        return {key: _dumpable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dumpable(item) for item in value]
    return value


def _dump(value: Any, indented_sequences: bool = False) -> list[str]:
    dumper = _IndentedSequenceDumper if indented_sequences else ESPHomeDumper
    text = yaml.dump(_dumpable(value), Dumper=dumper, sort_keys=False,
                     default_flow_style=False, allow_unicode=True, width=100)
    return text.splitlines(keepends=True)


def _uses_indented_sequences(node: yaml.Node) -> bool:
    """Whether the source indents block sequences below their key - the
    first such sequence decides, so new fragments match the file."""
    pending = [node]
    while pending:
        current = pending.pop(0)
        if isinstance(current, yaml.MappingNode):
            for key_node, value_node in current.value:
                if (isinstance(value_node, yaml.SequenceNode) and _is_block(value_node)
                        and value_node.value):
                    item_column = value_node.value[0].start_mark.column - 2
                    return item_column > key_node.start_mark.column
                pending.append(value_node)
        elif isinstance(current, yaml.SequenceNode):
            pending.extend(current.value)
    return False


def _identity(value: Any) -> tuple[str, str] | None:
    """What makes a sequence item "the same item" across an edit: its id."""
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("id"), str):
        return "", value["id"]
    if len(value) == 1:
        (kind, body), = value.items()
        if isinstance(body, dict) and isinstance(body.get("id"), str):
            return str(kind), body["id"]
    return None


def _is_block(node: yaml.Node) -> bool:
    return isinstance(node, (yaml.MappingNode, yaml.SequenceNode)) and not node.flow_style


class _Patcher:
    def __init__(self, lines: list[str], indented_sequences: bool) -> None:
        self.lines = lines
        self.indented_sequences = indented_sequences
        self.newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
        #: (start, end, new_lines, order) - replaces lines[start:end];
        #: start == end is a pure insertion before line ``start``.
        self.edits: list[tuple[int, int, list[str], int]] = []

    # --- geometry -----------------------------------------------------------

    def last_line(self, node: yaml.Node) -> int:
        """Index of the last line carrying the node's own content - trailing
        blank lines and comments belong to whatever follows."""
        if _is_block(node):
            last = node.value[-1]
            return self.last_line(last[1] if isinstance(node, yaml.MappingNode) else last)
        start, end = node.start_mark, node.end_mark
        line = end.line if end.column > 0 or end.line == start.line else end.line - 1
        while line > start.line and not self.lines[line].strip():
            line -= 1
        return line

    def item_column(self, node: yaml.Node) -> int:
        """Column of the ``-`` introducing a block-sequence item."""
        line = self.lines[node.start_mark.line]
        head = line[:node.start_mark.column].rstrip()
        if not head.endswith("-") or head[:-1].strip():
            raise _Unpatchable("sequence item does not start its own line")
        return len(head) - 1

    # --- edits --------------------------------------------------------------

    def _indent(self, fragment: list[str], line: int, column: int) -> list[str]:
        """Place a dumped fragment at ``column``, keeping whatever precedes
        that column on the first line (the ``- `` of an enclosing item)."""
        prefix = self.lines[line][:column] if line < len(self.lines) else ""
        out = []
        for index, text in enumerate(fragment):
            text = text.rstrip("\r\n")
            lead = prefix if index == 0 else " " * column
            out.append((lead + text if text else "") + self.newline)
        return out

    def replace(self, start: int, last: int, column: int, fragment: list[str]) -> None:
        self.edits.append((start, last + 1, self._indent(fragment, start, column),
                           len(self.edits)))

    def delete(self, start: int, last: int, column: int) -> None:
        if self.lines[start][:column].strip():
            # Deleting the first key of a `- key:` item would take the dash
            # with it.
            raise _Unpatchable("cannot delete an entry sharing its line")
        self.edits.append((start, last + 1, [], len(self.edits)))

    def dump(self, value: Any) -> list[str]:
        return _dump(value, self.indented_sequences)

    def at_column(self, fragment: list[str], column: int) -> list[str]:
        return [(" " * column + text.rstrip("\r\n") if text.strip() else "") + self.newline
                for text in fragment]

    def insert(self, before: int, column: int, fragment: list[str]) -> None:
        self.edits.append((before, before, self.at_column(fragment, column), len(self.edits)))

    def apply(self) -> list[str]:
        # Inserts sort before a replacement starting on the same line.
        ordered = sorted(self.edits, key=lambda e: (e[0], e[1] != e[0], e[3]))
        out: list[str] = []
        position = 0
        for start, end, new, _order in ordered:
            if start < position:
                raise _Unpatchable("overlapping edits")
            out.extend(self.lines[position:start])
            out.extend(new)
            position = end
        out.extend(self.lines[position:])
        return out

    # --- diff ---------------------------------------------------------------

    def mapping(self, node: yaml.MappingNode, old: dict, new: dict, raw: dict) -> None:
        if len(old) != len(node.value):
            raise _Unpatchable("duplicate or merged keys")
        entries = list(zip(old, node.value))
        column = entries[0][1][0].start_mark.column
        for key, (key_node, value_node) in entries:
            start = key_node.start_mark.line
            last = self.last_line(value_node)
            if key not in new:
                self.delete(start, last, key_node.start_mark.column)
            elif not same_yaml_value(old[key], new[key]):
                if not self.descend(value_node, old[key], new[key], raw[key],
                                    nested_below=start):
                    self.replace(start, last, key_node.start_mark.column,
                                 self.dump({key: raw[key]}))
        added = [key for key in new if key not in old]
        if added:
            after = self.last_line(entries[-1][1][1]) + 1
            self.insert(after, column, self.dump({key: raw[key] for key in added}))

    def sequence(self, node: yaml.SequenceNode, old: list, new: list, raw: list) -> bool:
        used: set[int] = set()
        matches: list[int | None] = []
        old_ids = [_identity(item) for item in old]
        for index, item in enumerate(new):
            ident = _identity(item)
            found = None
            if ident is not None:
                found = next((i for i, oid in enumerate(old_ids)
                              if oid == ident and i not in used), None)
            elif index < len(old) and index not in used and old_ids[index] is None:
                found = index
            matches.append(found)
            if found is not None:
                used.add(found)
        items = node.value
        column = self.item_column(items[0])
        kept = [m for m in matches if m is not None]
        if kept != sorted(kept):
            self.reorder(items, old, new, raw, matches, column)
            return True
        for index, item_node in enumerate(items):
            if index not in used:
                self.delete(item_node.start_mark.line, self.last_line(item_node),
                            self.item_column(item_node))

        previous_end: int | None = None
        pending: list[Any] = []

        def flush(before: int) -> None:
            if pending:
                self.insert(before, column, self.dump(list(pending)))
                pending.clear()

        for new_index, old_index in enumerate(matches):
            if old_index is None:
                pending.append(raw[new_index])
                continue
            item_node = items[old_index]
            start = item_node.start_mark.line
            flush(previous_end if previous_end is not None else start)
            last = self.last_line(item_node)
            if not same_yaml_value(old[old_index], new[new_index]):
                if not self.descend(item_node, old[old_index], new[new_index],
                                    raw[new_index], nested_below=None):
                    self.replace(start, last, self.item_column(item_node),
                                 self.dump([raw[new_index]]))
            previous_end = last + 1
        flush(previous_end if previous_end is not None
              else self.last_line(items[-1]) + 1)
        return True

    def reorder(self, items: list[yaml.Node], old: list, new: list, raw: list,
                matches: list[int | None], column: int) -> None:
        """Rebuild a reordered sequence from its items' original text.

        Each item moves together with the comments and blank lines that
        follow it up to the next item; only items whose content changed (or
        that are new) are re-dumped.
        """
        starts = [item.start_mark.line for item in items]
        for item in items:
            self.item_column(item)
        region_end = self.last_line(items[-1]) + 1
        chunks = [self.lines[starts[i]:starts[i + 1]] for i in range(len(items) - 1)]
        chunks.append(self.lines[starts[-1]:region_end])
        out: list[str] = []
        for new_index, old_index in enumerate(matches):
            if old_index is not None and same_yaml_value(old[old_index], new[new_index]):
                out.extend(chunks[old_index])
            else:
                out.extend(self.at_column(self.dump([raw[new_index]]), column))
        self.edits.append((starts[0], region_end, out, len(self.edits)))

    def descend(self, node: yaml.Node, old: Any, new: Any, raw: Any, *,
                nested_below: int | None) -> bool:
        """Patch inside ``node`` if it is a block collection of the same kind;
        False means the caller must rewrite the entry as a whole."""
        if not _is_block(node) or not node.value:
            return False
        if nested_below is not None and node.start_mark.line <= nested_below:
            return False
        if isinstance(node, yaml.MappingNode) and isinstance(old, dict) and isinstance(new, dict):
            if not new:
                return False
            self.mapping(node, old, new, raw)
            return True
        if isinstance(node, yaml.SequenceNode) and isinstance(old, list) and isinstance(new, list):
            if not new:
                return False
            return self.sequence(node, old, new, raw)
        return False


def patch_top_level_block(lines: list[str], key: str, value: Any) -> list[str] | None:
    """Rewrite the top-level block ``lines`` (its ``key:`` line plus body) so
    it holds ``value``, keeping every unchanged line and every comment.

    Returns None when that cannot be done safely; the caller then replaces
    the block wholesale.
    """
    text = "".join(lines)
    try:
        root = yaml.compose(text, Loader=_ImportLoader)
        old = load_lvgl_yaml(text).get(key)
        target = load_lvgl_yaml("".join(_dump({key: value}))).get(key)
    except Exception:  # any doubt means falling back
        return None
    if not isinstance(root, yaml.MappingNode) or len(root.value) != 1:
        return None
    if same_yaml_value(old, target):
        return list(lines)

    value_node = root.value[0][1]
    patcher = _Patcher(list(lines), _uses_indented_sequences(value_node))
    try:
        if not patcher.descend(value_node, old, target, value, nested_below=0):
            return None
        patched = patcher.apply()
        check = load_lvgl_yaml("".join(patched))
    except Exception:  # _Unpatchable, or a bug: fall back
        return None
    if set(check) != {key} or not same_yaml_value(check[key], target):
        return None
    return patched
