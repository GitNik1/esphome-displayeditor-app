"""Re-read the ESPHome config an imported project came from.

A designer project is a snapshot. ``entities``, the asset libraries and the
``lvgl:`` tree are read once, at import time, and never looked at again - so a
sensor added to the config afterwards (in the Device Builder, or by hand) stays
invisible to the editor, and a binding onto it makes
``validate_project_bindings`` reject the whole save.

This module answers the two questions that drift raises, without committing to
anything: what does the config say now that the project does not, and what
would adopting it cost. Nothing here writes. :func:`plan` describes,
:func:`merge` returns a new payload, and the ordinary project-save path stores
it - so a re-sync lands in the version history like any other write and stays
undoable.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Sequence
from typing import Any

import yaml

#: Adoptable groups, in the order the dialog shows them. Each one is
#: independent: the user ticks what to take over and leaves the rest alone.
RESYNC_GROUPS = ("entities", "resources", "layout")

#: Payload keys each group owns. A group replaces exactly these - anything not
#: listed here (``background``, ``glow_strokes``, ``bindings``,
#: ``export_sections``) is designer-owned and survives every re-sync.
GROUP_KEYS: dict[str, tuple[str, ...]] = {
    # reserved_ids rides along with the entities: both describe the part of the
    # config that lives *outside* the lvgl: block.
    "entities": ("entities", "reserved_ids"),
    "resources": ("colors", "fonts", "images", "styles", "default_font", "theme"),
    # The canvas is deliberately absent: the re-import is run at the project's
    # own canvas size, so the designer's chosen resolution is never overwritten
    # by whatever the config's display block happens to imply.
    "layout": (
        "widgets", "pages", "page_wrap", "top_layer", "bottom_layer", "msgboxes",
        "extra_lvgl", "display_id_placeholder",
    ),
}

#: Per list, so one wildly different config cannot inflate the response.
MAX_ITEMS_PER_LIST = 60


# --- source line numbers ----------------------------------------------------

def source_lines(text: str) -> tuple[dict[str, int], dict[str, int]]:
    """Map YAML paths and ``id:`` values to 1-based source line numbers.

    Composing rather than loading is deliberate: it stops at the node level, so
    ESPHome's custom tags (``!secret``, ``!lambda``) need no constructor and a
    plain SafeLoader is enough - and every node still carries its start mark.
    """
    try:
        root = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError:
        # A config that no longer parses is reported by the import itself; the
        # line index simply has nothing to offer.
        return {}, {}
    paths: dict[str, int] = {}
    ids: dict[str, int] = {}

    def walk(node: Any, path: str) -> None:
        if node is None:
            return
        line = node.start_mark.line + 1
        if path:
            paths.setdefault(path, line)
        if isinstance(node, yaml.MappingNode):
            for key_node, value_node in node.value:
                key = str(getattr(key_node, "value", ""))
                if key == "id" and isinstance(value_node, yaml.ScalarNode):
                    ids.setdefault(str(value_node.value), line)
                walk(value_node, f"{path}.{key}" if path else key)
        elif isinstance(node, yaml.SequenceNode):
            for index, item in enumerate(node.value):
                walk(item, f"{path}[{index}]")

    walk(root, "")
    return paths, ids


# --- payload helpers --------------------------------------------------------

def _entity_key(entity: Any) -> tuple[str, str] | None:
    if not isinstance(entity, dict):
        return None
    domain, identifier = entity.get("domain"), entity.get("id")
    if not domain or not identifier:
        return None
    return str(domain), str(identifier)


def _entity_label(entity: dict[str, Any]) -> str:
    return f"{entity.get('domain')}.{entity.get('id')}"


def _by_id(items: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in items or []:
        if isinstance(item, dict) and item.get("id"):
            result[str(item["id"])] = item
    return result


def _widget_dicts(nodes: Any) -> Iterable[dict[str, Any]]:
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        yield node
        yield from _widget_dicts(node.get("children"))


def _surface_widgets(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield from _widget_dicts(payload.get("widgets"))
    for page in payload.get("pages") or []:
        if isinstance(page, dict):
            yield from _widget_dicts(page.get("widgets"))
    for key in ("top_layer", "bottom_layer"):
        surface = payload.get(key)
        if isinstance(surface, dict):
            yield from _widget_dicts(surface.get("widgets"))
    for msgbox in payload.get("msgboxes") or []:
        if isinstance(msgbox, dict):
            yield from _widget_dicts(msgbox.get("widgets"))


def widget_ids(payload: dict[str, Any]) -> set[str]:
    """Every widget id the payload can bind to, across all surfaces."""
    return {str(node["id"]) for node in _surface_widgets(payload) if node.get("id")}


def _entity_keys(payload: dict[str, Any]) -> set[tuple[str, str]]:
    keys = (_entity_key(entity) for entity in payload.get("entities") or [])
    return {key for key in keys if key is not None}


def _binding_sides(binding: dict[str, Any]) -> tuple[dict, dict]:
    """Return ``(entity_side, widget_side)`` for a binding, either direction."""
    source = binding.get("source") if isinstance(binding.get("source"), dict) else {}
    target = binding.get("target") if isinstance(binding.get("target"), dict) else {}
    if binding.get("direction") in ("entity_to_widget", "bidirectional"):
        return source, target
    return target, source


def dangling_bindings(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Bindings the payload can no longer satisfy.

    Imported ``opaque_yaml``/``custom_yaml`` bindings are skipped for the same
    reason ``validate_project_bindings`` skips them: they carry raw YAML rather
    than an entity/widget pair, so neither side can go missing.
    """
    entities = _entity_keys(payload)
    widgets = widget_ids(payload)
    broken: list[dict[str, Any]] = []
    for index, binding in enumerate(payload.get("bindings") or []):
        if not isinstance(binding, dict):
            continue
        if binding.get("kind") in {"opaque_yaml", "custom_yaml"}:
            continue
        entity_side, widget_side = _binding_sides(binding)
        entity_key = _entity_key(entity_side)
        widget_id = widget_side.get("widget_id")
        missing: list[str] = []
        if entity_key is None or entity_key not in entities:
            missing.append(
                f"{entity_side.get('domain')}.{entity_side.get('id')}"
                if entity_side else "?"
            )
        if not widget_id or str(widget_id) not in widgets:
            missing.append(str(widget_id or "?"))
        if missing:
            broken.append({
                "id": str(binding.get("id", f"binding_{index}")),
                "missing": missing,
            })
    return broken


# --- the plan ---------------------------------------------------------------

def _capped(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    if len(items) <= MAX_ITEMS_PER_LIST:
        return items, 0
    return items[:MAX_ITEMS_PER_LIST], len(items) - MAX_ITEMS_PER_LIST


def _diff_maps(before: dict[Any, Any], after: dict[Any, Any], label,
               line) -> list[dict[str, Any]]:
    """Added/removed/changed entries for two id-keyed maps, in a stable order.

    A removed entry has no line: it exists in the project, not in the file.
    """
    changes: list[dict[str, Any]] = []
    for key in sorted(after.keys() - before.keys()):
        changes.append({"kind": "added", "label": label(after[key], key),
                        "line": line(key)})
    for key in sorted(before.keys() - after.keys()):
        changes.append({"kind": "removed", "label": label(before[key], key),
                        "line": None})
    for key in sorted(before.keys() & after.keys()):
        if before[key] != after[key]:
            changes.append({"kind": "changed", "label": label(after[key], key),
                            "line": line(key)})
    return changes


def _entity_changes(stored: dict, imported: dict, ids: dict[str, int]) -> list[dict]:
    def keyed(payload: dict) -> dict[tuple[str, str], dict]:
        pairs = ((_entity_key(entity), entity)
                 for entity in payload.get("entities") or [])
        return {key: entity for key, entity in pairs if key is not None}

    return _diff_maps(keyed(stored), keyed(imported),
                      lambda entity, _key: _entity_label(entity),
                      lambda key: ids.get(key[1]))


def _list_changes(stored: dict, imported: dict, key: str, noun: str,
                  ids: dict[str, int]) -> list[dict]:
    return _diff_maps(_by_id(stored.get(key)), _by_id(imported.get(key)),
                      lambda _item, identifier: f"{noun} {identifier}",
                      ids.get)


def _scalar_change(stored: dict, imported: dict, key: str, label: str,
                   paths: dict[str, int], path: str = "") -> list[dict]:
    if stored.get(key) == imported.get(key):
        return []
    return [{"kind": "changed", "label": label, "line": paths.get(path)}]


def _widget_changes(stored: dict, imported: dict, ids: dict[str, int]) -> list[dict]:
    def keyed(payload: dict) -> dict[str, dict]:
        return {str(node["id"]): node
                for node in _surface_widgets(payload) if node.get("id")}

    return _diff_maps(
        keyed(stored), keyed(imported),
        lambda node, identifier: f"{node.get('widget_type', 'widget')} {identifier}",
        ids.get,
    )


def _group_plan(key: str, stored: dict, imported: dict, paths: dict[str, int],
                ids: dict[str, int]) -> dict[str, Any]:
    """Everything the dialog shows for one tick box.

    The broken bindings are computed for this group *alone*, which lets the
    dialog react to the ticks without asking the server again: a binding can
    only break because its entity or its widget disappeared, and each of those
    belongs to exactly one group, so the union over the ticked groups is exact.
    """
    if key == "entities":
        changes = _entity_changes(stored, imported, ids)
    elif key == "resources":
        changes = [
            *_list_changes(stored, imported, "colors", "color", ids),
            *_list_changes(stored, imported, "fonts", "font", ids),
            *_list_changes(stored, imported, "images", "image", ids),
            *_list_changes(stored, imported, "styles", "style", ids),
            *_scalar_change(stored, imported, "default_font", "default_font",
                            paths, "lvgl.default_font"),
            *_scalar_change(stored, imported, "theme", "theme", paths, "lvgl.theme"),
        ]
    else:
        changes = [
            *_widget_changes(stored, imported, ids),
            *_list_changes(stored, imported, "pages", "page", ids),
            *_list_changes(stored, imported, "msgboxes", "msgbox", ids),
        ]
    # A removal is the only change that can destroy work, so it doubles as the
    # group's loss list - the dialog needs no second computation to warn.
    losses = [change for change in changes if change["kind"] == "removed"]
    items, truncated = _capped(changes)
    loss_items, loss_truncated = _capped(losses)
    bindings = merge(stored, imported, [key])[1] if losses else []
    return {
        "key": key,
        "changed": len(changes),
        "removes": len(losses),
        "changes": items,
        "changes_truncated": truncated,
        "losses": loss_items,
        "losses_truncated": loss_truncated,
        "binding_losses": _capped(bindings)[0],
    }


def plan(*, stored: dict[str, Any], imported: dict[str, Any],
         issues: Sequence[dict[str, Any]], text: str) -> dict[str, Any]:
    """Describe the drift between a stored project and its source config."""
    paths, ids = source_lines(text)
    groups = [_group_plan(key, stored, imported, paths, ids) for key in RESYNC_GROUPS]
    unsupported = [
        {
            "severity": issue.get("severity", "B"),
            "message": issue.get("message", ""),
            "path": issue.get("path", ""),
            "line": paths.get(issue.get("path", "")),
        }
        for issue in issues
        if issue.get("severity") in ("A", "B", "error")
    ]
    unsupported_items, unsupported_truncated = _capped(unsupported)
    # The worst case - every group ticked - stated once, so a caller that does
    # not track the tick boxes still has the honest upper bound.
    seen: set[str] = set()
    binding_losses = [
        item
        for group in groups
        for item in group["binding_losses"]
        if item["id"] not in seen and not seen.add(item["id"])
    ]
    return {
        "changed": any(group["changed"] for group in groups),
        "groups": groups,
        "unsupported": unsupported_items,
        "unsupported_truncated": unsupported_truncated,
        "binding_losses": binding_losses,
    }


# --- applying ---------------------------------------------------------------

def merge(stored: dict[str, Any], imported: dict[str, Any],
          groups: Sequence[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Fold the chosen groups of a fresh import into a stored project.

    Returns the merged payload and the bindings that had to go with it: a
    binding whose entity or widget the re-sync removes fails validation, which
    would turn the whole save into a 422 rather than a partial adoption.
    """
    merged = copy.deepcopy(stored)
    for group in groups:
        for key in GROUP_KEYS[group]:
            if key in imported:
                merged[key] = copy.deepcopy(imported[key])
            else:
                merged.pop(key, None)
    merged["import_source"] = dict(
        imported.get("import_source") or stored.get("import_source") or {}
    )
    dropped = dangling_bindings(merged)
    if dropped:
        dropped_ids = {item["id"] for item in dropped}
        merged["bindings"] = [
            binding
            for index, binding in enumerate(merged.get("bindings") or [])
            if str(binding.get("id", f"binding_{index}")) not in dropped_ids
        ]
    return merged, dropped
