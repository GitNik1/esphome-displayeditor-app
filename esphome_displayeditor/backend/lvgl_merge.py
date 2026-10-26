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

import re
from dataclasses import dataclass, field
from typing import Any

import yaml

from .designer_core.idgen import IdRegistry
from .designer_core.model import Project
from .addon_widgets import prepare_addon_widget_export
from .designer_core.yamlexport import (
    ESPHomeDumper,
    ExportIssue,
    build_color_block,
    build_font_block,
    build_lvgl_tree,
)
from .designer_core.yamlimport import LvglImportError, TaggedScalar, load_lvgl_yaml
from .entity_bindings import compile_bindings
from .display_targets import (
    DisplayCommentError,
    comment_out_display_conflicts,
    display_source_note,
    find_display_conflicts,
    resolve_display_placeholder,
)
from .yaml_patch import (
    TopLevelSpan,
    YamlStructureError,
    patch_top_level_block,
    same_yaml_value,
    top_level_spans,
)
from .yaml_strict import load_yaml_strict

#: The four top-level keys a Designer project can contribute, in the order
#: they are considered - matches yamlexport.export_project()'s own order.
MERGE_KEYS = ("color", "font", "image", "lvgl")

#: lvgl: keys the generator always states, with ESPHome's own default.
_LVGL_DEFAULTS = {"color_depth": 16, "page_wrap": True}


def _without_restated_defaults(value: Any, existing: Any) -> Any:
    """Drop what the existing ``lvgl:`` left to ESPHome's defaults and the
    generated block merely restates - otherwise an unchanged save would add
    ``color_depth: 16``, ``page_wrap: true`` and an empty ``widgets:``."""
    if not isinstance(value, dict) or not isinstance(existing, dict):
        return value
    value = dict(value)
    for key, default in _LVGL_DEFAULTS.items():
        if key not in existing and value.get(key) == default:
            value.pop(key)
    if "widgets" not in existing and value.get("widgets") == [] and "pages" in value:
        value.pop("widgets")
    return value


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
        if set(value) == {"__esphome_tag__", "value"}:
            return TaggedScalar(str(value["value"]), str(value["__esphome_tag__"]))
        return {key: _materialize_lambdas(item) for key, item in value.items()}
    return value


class MergeError(Exception):
    """Raised when the existing file's structure can't be safely edited."""


class DisplayTakeoverRequired(MergeError):
    """The target display draws by itself (``lambda:``, ``pages:``, ...),
    which ESPHome refuses next to LVGL. The user has to agree before those
    keys are commented out; ``conflicts`` names them."""

    def __init__(self, conflicts: list[dict[str, Any]]) -> None:
        names = ", ".join(
            f"'{c['display_id'] or 'display'}' ({', '.join(c['keys'])})" for c in conflicts)
        super().__init__(
            f"Display {names} draws by itself, which LVGL cannot share. Confirm to comment "
            "these keys out - the code stays in the file and can be deleted by hand.")
        self.conflicts = conflicts


@dataclass
class MergeResult:
    content: str
    replaced_keys: list[str] = field(default_factory=list)
    appended_keys: list[str] = field(default_factory=list)
    issues: list[ExportIssue] = field(default_factory=list)
    #: Displays whose drawing keys were commented out for LVGL.
    display_takeover: list[dict[str, Any]] = field(default_factory=list)


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
    project = prepare_addon_widget_export(project)
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


def _refuse_reference(lines: list[str], key: str) -> None:
    """``key: !include x``, ``key: *anchor`` and ``key: &anchor ...`` keep
    the block's content in another file or share it; writing here would
    replace the reference. Checked on the text first, so even an undefined
    alias - which the YAML composer cannot get past - is reported as what it is.
    """
    # `lvgl:` may carry trailing blanks or a comment, or its whole value
    # inline (`lvgl: {...}`).
    pattern = re.compile(rf"^{re.escape(key)}:(?:[ \t]+(?P<value>[^#\s][^\r\n]*?))?[ \t]*(?:#[^\r\n]*)?\r?\n?$")
    for line in lines:
        match = pattern.match(line.lstrip("﻿"))
        value = (match.group("value") or "") if match else ""
        if value.startswith(("!", "*", "&", "<<")):
            raise MergeError(
                f"'{key}: {value}' comes from another file or anchor; merge into that "
                "file instead - writing here would replace the reference.")


def _top_level_spans(content: str) -> dict[str, TopLevelSpan]:
    try:
        return top_level_spans(content)
    except YamlStructureError as exc:
        raise MergeError(str(exc)) from exc


def _editable_span(content: str, spans: dict[str, TopLevelSpan], key: str) -> TopLevelSpan | None:
    span = spans.get(key)
    if span is None:
        return None
    value = span.value_node
    if (value.start_mark.index < span.key_node.end_mark.index
            or content[value.start_mark.index:value.start_mark.index + 1] in ("!", "&", "*")):
        raise MergeError(
            f"'{key}:' comes from another file or anchor; merge into that file "
            "instead - writing here would replace the reference.")
    return span


def _find_top_level_block(lines: list[str], key: str) -> tuple[int, int] | None:
    """The [start, end) line range of the top-level ``key:`` block, or None.

    Taken from the YAML structure (``yaml_patch.top_level_spans``), not from
    indentation: a column-0 comment inside the block - a commented-out
    property - used to end it early, so a merge rewrote only its first part
    and left the rest behind as a second copy.
    """
    _refuse_reference(lines, key)
    content = "".join(lines)
    span = _editable_span(content, _top_level_spans(content), key)
    return None if span is None else (span.start, span.end)


def _dump_lines(key: str, value: Any, newline: str) -> list[str]:
    """A whole-block rewrite in the file's own line endings."""
    return [line.removesuffix("\n") + newline
            for line in _dump_block(key, value).splitlines(keepends=True)]


def _normalized(key: str, value: Any) -> Any:
    """``value`` as it reads back once written - what a merged block must load as."""
    return load_lvgl_yaml(_dump_block(key, value))[key]


def _load_target(content: str) -> dict[str, Any]:
    """The configuration a merge builds on, loaded strictly: a repeated key
    is refused here, with its line, instead of surfacing as an unverifiable
    merge result (ESPHome and publishing refuse such a file as well)."""
    try:
        document = load_yaml_strict(content)
    except LvglImportError as exc:
        raise MergeError(f"The configuration cannot be merged into: {exc}") from exc
    return document if isinstance(document, dict) else {}


def _comes_out_as(content: str, expected: dict[str, Any]) -> bool:
    """Whether the merged text loads - strictly - as exactly ``expected``.

    The per-block patch check cannot see a block's surroundings; this whole-
    document check is what catches a block whose old text survived next to
    the new one."""
    try:
        document = load_yaml_strict(content)
    except LvglImportError:
        return False
    document = document if isinstance(document, dict) else {}
    return set(document) == set(expected) and all(
        same_yaml_value(document[key], expected[key]) for key in expected)


def choose_merge_base(draft: str | None, active: str) -> tuple[str, list[ExportIssue]]:
    """The text a draft merge builds on: the saved draft, unless it no longer
    loads strictly - a draft left broken (by the old line-based block
    detection, or by hand) would otherwise block every later merge."""
    if draft is None:
        return active, []
    try:
        load_yaml_strict(draft)
    except LvglImportError:
        return active, [ExportIssue(
            "B", "The saved draft was not valid YAML (for example a repeated key); "
                 "it was replaced by a merge into the active configuration.")]
    return draft, []


def merge_project_into_yaml(
    project: Project,
    existing_content: str,
    *,
    display_takeover: str = "ask",
) -> MergeResult:
    """Merge a Designer project's color/font/image/lvgl blocks into an
    existing ESPHome YAML file's text, replacing only the matching
    top-level keys' own line ranges (or appending a key that isn't present
    yet) and leaving everything else in ``existing_content`` untouched.

    Never *removes* a top-level key: if the project has nothing for
    ``color``/``font``/``image`` (e.g. no colours defined), any existing
    block under that key in the target file is left exactly as it is - a
    merge only ever adds or updates, consistent with never surprising a
    human by deleting something they did not touch in the Designer.

    The ``lvgl: displays:`` entry is resolved against the target file (see
    ``display_targets.py``). A display that draws by itself raises
    DisplayTakeoverRequired unless ``display_takeover="comment"``, which
    comments its drawing keys out instead - the caller passes that only
    after the user agreed, or for a read-only preview.
    """
    project, display_issues = resolve_display_placeholder(project, existing_content)
    conflicts = find_display_conflicts(existing_content, project.display_id_placeholder)
    if note := display_source_note(existing_content):
        display_issues.append(ExportIssue("B", note))
    if conflicts:
        if display_takeover != "comment":
            raise DisplayTakeoverRequired([c.to_dict() for c in conflicts])
        try:
            existing_content = comment_out_display_conflicts(existing_content, conflicts)
        except DisplayCommentError as exc:
            raise MergeError(str(exc)) from exc
        display_issues.extend(
            ExportIssue("B", f"Display '{c.display_id or 'display'}': "
                             f"{', '.join(c.keys)} commented out for LVGL.")
            for c in conflicts
        )
    compiled = compile_bindings(project)
    issues = [
        ExportIssue("A" if issue.severity == "error" else "B", issue.message)
        for issue in compiled.issues
    ]
    generated_doc, export_issues = _build_merge_doc(compiled.project)
    issues.extend(display_issues)
    issues.extend(export_issues)
    existing_lines = existing_content.splitlines(keepends=True)
    for key in MERGE_KEYS:
        if key in generated_doc:
            _refuse_reference(existing_lines, key)
    existing_doc = _load_target(existing_content)
    blocks: dict[str, Any] = {}
    for key in MERGE_KEYS:
        if key not in generated_doc:
            continue
        value = _materialize_lambdas(generated_doc[key])
        if key == "lvgl":
            value = _without_restated_defaults(value, existing_doc.get("lvgl"))
        blocks[key] = value

    # Edit only what changed, so comments and the author's formatting inside
    # a block survive. Whatever the patcher produced is then checked as a
    # whole document; if it does not load as intended, the merge is redone
    # with every touched block rewritten as a whole - and refused if even
    # that does not come out right, rather than saving a broken draft.
    for patch in (True, False):
        spliced = _splice_blocks(existing_content, existing_doc, blocks,
                                 compiled.entity_actions, patch=patch)
        if _comes_out_as(spliced.content, spliced.expected):
            break
    else:
        raise MergeError(
            "The merged configuration did not come out as intended, so nothing was "
            "written. Please report this together with the configuration.")
    issues.extend(
        ExportIssue("C", f"'{key}:' was rewritten as a whole; comments inside it were not kept.")
        for key in spliced.rewritten)
    return MergeResult(
        content=spliced.content,
        replaced_keys=spliced.replaced,
        appended_keys=spliced.appended,
        issues=issues,
        display_takeover=[c.to_dict() for c in conflicts],
    )


@dataclass
class _Spliced:
    content: str
    #: What the merged document must load as, key by key.
    expected: dict[str, Any]
    replaced: list[str] = field(default_factory=list)
    appended: list[str] = field(default_factory=list)
    #: Blocks written as a whole instead of patched.
    rewritten: list[str] = field(default_factory=list)


def _splice_blocks(
    content: str,
    existing_doc: dict[str, Any],
    blocks: dict[str, Any],
    entity_actions: list[dict[str, Any]],
    *,
    patch: bool,
) -> _Spliced:
    lines = content.splitlines(keepends=True)
    if lines and not lines[-1].endswith(("\n", "\r\n")):
        lines[-1] += "\n"
    newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
    spans = _top_level_spans(content)
    result = _Spliced(content="", expected=dict(existing_doc))
    edits: list[tuple[int, int, list[str]]] = []
    to_append: list[str] = []
    for key, value in blocks.items():
        result.expected[key] = _normalized(key, value)
        span = _editable_span(content, spans, key)
        if span is None:
            to_append.append(_dump_block(key, value))
            result.appended.append(key)
            continue
        new_lines = patch_top_level_block(lines[span.start:span.end], key, value) if patch else None
        if new_lines is None:
            new_lines = _dump_lines(key, value, newline)
            result.rewritten.append(key)
        edits.append((span.start, span.end, new_lines))
        result.replaced.append(key)
    # Bottom up, so every span still points at the lines it was measured on.
    for start, end, new_lines in sorted(edits, key=lambda edit: edit[0], reverse=True):
        lines[start:end] = new_lines

    text = "".join(lines)
    if to_append:
        if not text.endswith("\n"):
            text += "\n"
        appended_text = "\n" + "\n".join(to_append)
        if newline == "\r\n":
            appended_text = appended_text.replace("\n", "\r\n")  # keep the file's line endings
        text += appended_text
    if entity_actions:
        text, domains, rewritten = _merge_entity_binding_actions(text, entity_actions, patch=patch)
        for domain, value in domains.items():
            result.expected[domain] = _normalized(domain, value)
            if domain not in result.replaced:
                result.replaced.append(domain)
        result.rewritten.extend(rewritten)
    # Line handling needs a final newline; a file that had none gets none
    # back, so an unchanged file stays byte for byte the same.
    if content and not content.endswith("\n") and not to_append:
        text = text.removesuffix("\n").removesuffix("\r")
    result.content = text
    return result


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
    content: str, actions: list[dict[str, Any]], *, patch: bool = True
) -> tuple[str, dict[str, Any], list[str]]:
    """Semantically update only domains that receive generated bindings.

    Existing component entries and user actions are retained. A previously
    generated LVGL action with the same action name and target id is replaced,
    making repeated merges idempotent. Returns the new text, the new value of
    every changed domain and the domains that had to be rewritten as a whole.
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
            if compiled.get("opaque") and compiled.get("deleted"):
                continue
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
        if compiled.get("opaque"):
            then[:] = [item for item in then if item != new_action]
            if not compiled.get("deleted"):
                then.append(new_action)
            changed.add(domain)
            continue
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
    newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
    spans = _top_level_spans(content)
    edits: list[tuple[int, int, list[str]]] = []
    rewritten: list[str] = []
    for domain in sorted(changed):
        _refuse_reference(lines, domain)
        span = _editable_span(content, spans, domain)
        if span is None:
            raise MergeError(f"Binding domain '{domain}:' disappeared during merge.")
        # Like lvgl:/font:, only the bound entity's lines change; the rest of
        # the domain keeps its comments and formatting. A block the patcher
        # cannot handle safely is re-dumped as before.
        block = lines[span.start:span.end]
        patched = patch_top_level_block(block, domain, document[domain]) if patch else None
        if patched is None:
            patched = _dump_lines(domain, document[domain], newline)
            rewritten.append(domain)
        edits.append((span.start, span.end, patched))
    for start, end, patched in sorted(edits, key=lambda edit: edit[0], reverse=True):
        lines[start:end] = patched
    return "".join(lines), {domain: document[domain] for domain in sorted(changed)}, rewritten
