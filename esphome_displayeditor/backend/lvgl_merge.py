"""Splice generated color:/font:/image:/lvgl: blocks into an existing
ESPHome YAML file's text.

Add-on-only, same reasoning as ``page_support.py``/``msgbox_support.py``:
nothing here changes the shared, desktop-compatible designer core. Unlike a
full ``export_project()`` run (which writes a brand-new, self-contained
file), this only ever touches the *line range* of each top-level key it
means to replace - every other line (``esphome:``, ``wifi:``, comments,
formatting) stays byte-identical, because it is never re-parsed or
re-dumped. That is deliberately safer than a full YAML round-trip for an
existing file: PyYAML's dumper does not preserve comments or the source's
own formatting, so re-serializing the whole document would silently change
parts a human never asked to touch. Device bindings are the deliberate
exception: only the bound entity's top-level domain is semantically re-dumped
so its trigger can retain existing actions and receive the generated LVGL
action. The merge result is always presented as a draft/diff before publish.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import yaml

from .designer_core.idgen import IdRegistry
from .designer_core.model import Project
from .designer_core.yamlexport import (
    ESPHomeDumper,
    ExportIssue,
    build_color_block,
    build_font_block,
    build_lvgl_tree,
)
from .designer_core.yamlimport import TaggedScalar, load_lvgl_yaml
from .entity_bindings import compile_bindings

#: The four top-level keys a Designer project can contribute, in the order
#: they are considered - matches yamlexport.export_project()'s own order.
MERGE_KEYS = ("color", "font", "image", "lvgl")


def _represent_tagged_scalar(dumper, value):
    return dumper.represent_scalar(
        value.tag or "tag:yaml.org,2002:str",
        str(value),
        style="|" if "\n" in str(value) else None,
    )


ESPHomeDumper.add_representer(TaggedScalar, _represent_tagged_scalar)


def _materialize_lambdas(value: Any) -> Any:
    if isinstance(value, list):
        return [_materialize_lambdas(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {"__esphome_lambda__"}:
            return TaggedScalar(str(value["__esphome_lambda__"]), "!lambda")
        return {key: _materialize_lambdas(item) for key, item in value.items()}
    return value


class MergeError(Exception):
    """Raised when the existing file's structure can't be safely edited."""


@dataclass
class MergeResult:
    content: str
    replaced_keys: list[str] = field(default_factory=list)
    appended_keys: list[str] = field(default_factory=list)
    issues: list[ExportIssue] = field(default_factory=list)


def _image_block_for_merge(project: Project) -> list[dict[str, Any]] | None:
    """Same shape as ``yamlexport.build_image_block()``, but never copies a
    file anywhere: every image this app knows about is already sitting
    where its ``file:`` path says, either because it came from the config
    being merged into (an imported/``external`` path, already correct
    relative to that file) or because it was uploaded through the
    Designer's own asset endpoint, which already writes it straight into
    the config root's ``images/`` folder - copying it again into a fresh
    ``assets/`` folder next to some other file would just create a stale
    duplicate for no benefit in this merge-into-an-existing-file flow.
    """
    entries = []
    for img in project.images:
        entry: dict[str, Any] = {
            "platform": "file",
            "id": img.id,
            "file": img.file_path or "",
        }
        if img.resize:
            entry["resize"] = img.resize
        if img.dither:
            entry["dither"] = img.dither
        if img.transparency and img.transparency != "opaque":
            entry["transparency"] = img.transparency
        if img.img_type:
            entry["type"] = img.img_type
        entry.update({k: v for k, v in img.extra.items() if k not in entry})
        entries.append(entry)
    if project.background.export_as_lvgl_image and project.background.path:
        entries.append(
            {
                "platform": "file",
                "id": project.background.image_id,
                "file": project.background.path,
                "resize": f"{project.canvas_width}x{project.canvas_height}",
            }
        )
    return entries or None


def _build_merge_doc(project: Project) -> tuple[dict[str, Any], list[ExportIssue]]:
    issues: list[ExportIssue] = []
    registry = IdRegistry()
    for w in project.all_widgets():
        registry.claim(w.id, f"widget '{w.id}'")
    for s in project.styles:
        registry.claim(s.id, f"style '{s.id}'")
    for f in project.fonts:
        registry.claim(f.id, f"font '{f.id}'")
    for i in project.images:
        registry.claim(i.id, f"image '{i.id}'")
    for c in project.colors:
        registry.claim(c.id, f"color '{c.id}'")
    # The reference-image background gets its own synthetic image: entry
    # below (via _image_block_for_merge()) when exported - without this its
    # id could silently collide with a real image's id, emitting the same
    # id twice in the merged image: block. designer.validate() already
    # claims this too and is called before this function in every current
    # caller, but claiming it here as well keeps this function correct on
    # its own, the same way it already re-claims every other id rather than
    # trusting an earlier validation pass.
    if project.background.export_as_lvgl_image and project.background.path:
        registry.claim(project.background.image_id, "background image")
    issues.extend(ExportIssue("A", msg) for msg in registry.collisions())

    doc: dict[str, Any] = {}
    color_block = build_color_block(project)
    if color_block:
        doc["color"] = color_block
    font_block = build_font_block(project)
    if font_block:
        doc["font"] = font_block
    image_block = _image_block_for_merge(project)
    if image_block:
        doc["image"] = image_block
    doc["lvgl"] = build_lvgl_tree(project, registry, issues)
    return doc, issues


def _dump_block(key: str, value: Any) -> str:
    return yaml.dump(
        {key: value},
        Dumper=ESPHomeDumper,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=100,
    )


def build_project_yaml_for_bundle(project: Project) -> tuple[str, list[ExportIssue]]:
    """A standalone ``color:``/``font:``/``image:``/``lvgl:`` YAML document
    for this project, built the same asset-copy-free way as a merge - unlike
    ``yamlexport.export_project()``, this never touches the filesystem, so
    it can't fail just because an asset's path (already correct relative to
    the config root) doesn't happen to resolve relative to this process's
    own working directory. Used by ``lvgl_bundle.py`` for the ZIP download,
    which bundles the actual asset bytes itself, straight from where the
    Designer's own upload endpoint already put them.
    """
    compiled = compile_bindings(project)
    doc, issues = _build_merge_doc(compiled.project)
    issues.extend(
        ExportIssue("A" if issue.severity == "error" else "B", issue.message)
        for issue in compiled.issues
    )
    if compiled.entity_actions:
        issues.append(
            ExportIssue(
                "B",
                "Entity-to-widget bindings require merging into the source ESPHome configuration.",
            )
        )
    parts = [_dump_block(key, doc[key]) for key in MERGE_KEYS if key in doc]
    return "\n".join(parts), issues


def _find_top_level_block(lines: list[str], key: str) -> tuple[int, int] | None:
    """Return the [start, end) line-index range of an existing top-level
    ``key:`` block, or None if it isn't present. A line belongs to the
    block if it is blank, starts with whitespace (indented under the key),
    or starts with ``-`` (a block-sequence item at column 0 - PyYAML dumps
    a top-level list value, e.g. ``color:``/``font:``/``image:``, with its
    items starting at column 0, not indented under the key); the first
    line back at column 0 that is neither - or end of file - ends it.

    Getting this wrong previously mistook a sequence item's own ``-`` for
    the start of a new top-level key, so the "block" for a list-valued key
    was measured as just its own ``key:`` line. On a *replace* (the key
    already existed), that line-range replacement then only ever
    overwrote the ``key:`` line itself, leaving every one of its old
    entries in place right after the freshly-inserted new ones - so
    merging the same project into the same file twice in a row silently
    duplicated every entry in ``color:``/``font:``/``image:`` (never
    ``lvgl:``, since its own list values - e.g. ``widgets:`` - are always
    nested *under* another key and therefore genuinely indented).
    """
    start = None
    for index, line in enumerate(lines):
        if line.rstrip("\r\n") == f"{key}:":
            if start is not None:
                raise MergeError(f"Found '{key}:' more than once at the top level.")
            start = index
    if start is None:
        return None
    end = start + 1
    while end < len(lines) and (
        lines[end] in ("\n", "\r\n") or lines[end].startswith((" ", "\t", "-"))
    ):
        end += 1
    return start, end


def merge_project_into_yaml(project: Project, existing_content: str) -> MergeResult:
    """Merge a Designer project's color/font/image/lvgl blocks into an
    existing ESPHome YAML file's text, replacing only the matching
    top-level keys' own line ranges (or appending a key that isn't present
    yet) and leaving everything else in ``existing_content`` untouched.

    Never *removes* a top-level key: if the project has nothing for
    ``color``/``font``/``image`` (e.g. no colours defined), any existing
    block under that key in the target file is left exactly as it is - a
    merge only ever adds or updates, consistent with never surprising a
    human by deleting something they did not touch in the Designer.
    """
    compiled = compile_bindings(project)
    issues = [
        ExportIssue("A" if issue.severity == "error" else "B", issue.message)
        for issue in compiled.issues
    ]
    generated_doc, export_issues = _build_merge_doc(compiled.project)
    issues.extend(export_issues)
    lines = existing_content.splitlines(keepends=True)
    if lines and not lines[-1].endswith(("\n", "\r\n")):
        lines[-1] += "\n"

    replaced: list[str] = []
    to_append: list[str] = []
    appended: list[str] = []
    for key in MERGE_KEYS:
        if key not in generated_doc:
            continue
        block_text = _dump_block(key, _materialize_lambdas(generated_doc[key]))
        found = _find_top_level_block(lines, key)
        if found is None:
            to_append.append(block_text)
            appended.append(key)
            continue
        start, end = found
        lines[start:end] = block_text.splitlines(keepends=True)
        replaced.append(key)

    result_text = "".join(lines)
    if to_append:
        if not result_text.endswith("\n"):
            result_text += "\n"
        result_text += "\n" + "\n".join(to_append)
    if compiled.entity_actions:
        result_text, changed_domains = _merge_entity_binding_actions(
            result_text,
            compiled.entity_actions,
        )
        for domain in changed_domains:
            if domain not in replaced:
                replaced.append(domain)
    return MergeResult(
        content=result_text,
        replaced_keys=replaced,
        appended_keys=appended,
        issues=issues,
    )


def _find_entity(value: Any, entity_id: str) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if value.get("id") == entity_id:
            return value
        for child in value.values():
            found = _find_entity(child, entity_id)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_entity(child, entity_id)
            if found is not None:
                return found
    return None


def _action_target(action: dict[str, Any]) -> tuple[str, str] | None:
    if len(action) == 1:
        name, payload = next(iter(action.items()))
        if str(name).startswith("lvgl."):
            if isinstance(payload, str):
                return str(name), payload
            if isinstance(payload, dict) and isinstance(payload.get("id"), str):
                return str(name), payload["id"]
    # Conditional visibility/threshold bindings wrap the actual update in an
    # ``if`` action. Find that nested LVGL target so changing a condition or
    # transformation replaces the old generated action instead of adding a
    # second one on the next merge.
    for value in action.values():
        if isinstance(value, dict):
            nested = _action_target(value)
            if nested:
                return nested
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    nested = _action_target(item)
                    if nested:
                        return nested
    return None


def _merge_entity_binding_actions(
    content: str, actions: list[dict[str, Any]]
) -> tuple[str, list[str]]:
    """Semantically update only domains that receive generated bindings.

    Existing component entries and user actions are retained. A previously
    generated LVGL action with the same action name and target id is replaced,
    making repeated merges idempotent.
    """
    document = load_lvgl_yaml(content)
    changed: set[str] = set()
    for compiled in actions:
        domain, entity_id, trigger = (
            compiled["domain"],
            compiled["entity_id"],
            compiled["trigger"],
        )
        entity = _find_entity(document.get(domain), entity_id)
        if entity is None:
            raise MergeError(
                f"Binding source '{domain}.{entity_id}' no longer exists in the target YAML."
            )
        raw_trigger = entity.get(trigger)
        if raw_trigger is None:
            trigger_body: dict[str, Any] = {"then": []}
            entity[trigger] = trigger_body
        elif isinstance(raw_trigger, dict):
            trigger_body = raw_trigger
            trigger_body.setdefault("then", [])
        elif isinstance(raw_trigger, list):
            # ESPHome accepts an action list as shorthand. Normalising it to
            # the explicit automation form preserves every action and gives
            # the binding compiler one deterministic insertion point.
            trigger_body = {"then": raw_trigger}
            entity[trigger] = trigger_body
        else:
            raise MergeError(
                f"Cannot safely extend {domain}.{entity_id}.{trigger}; expected a mapping."
            )
        then = trigger_body.get("then")
        if not isinstance(then, list):
            then = [] if then is None else [then]
            trigger_body["then"] = then
        new_action = _materialize_lambdas(compiled["action"])
        target = _action_target(new_action)
        if target:
            then[:] = [
                item
                for item in then
                if not (isinstance(item, dict) and _action_target(item) == target)
            ]
        if new_action not in then:
            then.append(new_action)
        changed.add(domain)

    lines = content.splitlines(keepends=True)
    for domain in sorted(changed):
        found = _find_top_level_block(lines, domain)
        if found is None:
            raise MergeError(f"Binding domain '{domain}:' disappeared during merge.")
        start, end = found
        block = _dump_block(domain, document[domain])
        lines[start:end] = block.splitlines(keepends=True)
    return "".join(lines), sorted(changed)
