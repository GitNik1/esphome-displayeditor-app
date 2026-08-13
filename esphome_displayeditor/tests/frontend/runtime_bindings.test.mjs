import assert from "node:assert/strict";
import test from "node:test";

import { freshProject } from "../../frontend/project/model.js";
import {
  assignRuntimeBinding,
  bindingIsOrphan,
  canPasteRuntimeBinding,
  cleanRuntimeBindings,
  findRuntimeBinding,
  removeRuntimeBinding,
  runtimeStateFor,
  runtimeTargets,
} from "../../frontend/runtime/bindings.js";

const translate = (key, values = {}) => `${key}:${values.type || ""}`;

test("runtime targets follow widget value semantics", () => {
  assert.deepEqual(runtimeTargets({ widget_type: "label" }, translate), [
    { value: "text", label: "binding.target.text:" },
  ]);
  assert.deepEqual(runtimeTargets({ widget_type: "arc" }, translate), [
    { value: "value", label: "binding.target.value:Arc" },
  ]);
  assert.equal(runtimeTargets({ widget_type: "button" }, translate).length, 0);
});

test("orphan detection validates both widget and target", () => {
  const project = freshProject();
  project.widgets = [{ id: "level", widget_type: "slider" }];
  assert.equal(bindingIsOrphan(project, { widget_id: "level", target: "value" }), false);
  assert.equal(bindingIsOrphan(project, { widget_id: "level", target: "text" }), true);
  assert.equal(bindingIsOrphan(project, { widget_id: "missing", target: "value" }), true);
});

test("runtime state lookup tolerates missing devices", () => {
  const state = { entity_id: "sensor:1", state: 42 };
  assert.equal(runtimeStateFor({ states: [state] }, "sensor:1"), state);
  assert.equal(runtimeStateFor(undefined, "sensor:1"), null);
});

test("binding assignment replaces matching targets for multiple widgets", () => {
  const existing = [
    { widget_id: "one", target: "text", entity_id: "old" },
    { widget_id: "one", target: "value", entity_id: "keep" },
  ];
  const next = assignRuntimeBinding(existing, ["one", "two"], {
    widget_id: "source",
    target: "text",
    entity_id: "new",
  });
  assert.deepEqual(next, [
    { widget_id: "one", target: "value", entity_id: "keep" },
    { widget_id: "one", target: "text", entity_id: "new" },
    { widget_id: "two", target: "text", entity_id: "new" },
  ]);
  assert.equal(findRuntimeBinding(next, "two", "text").entity_id, "new");
  assert.deepEqual(removeRuntimeBinding(next, "one", "text"), [next[0], next[2]]);
});

test("binding cleanup and paste compatibility share target validation", () => {
  const project = freshProject();
  const widget = { id: "title", widget_type: "label" };
  project.widgets.push(widget);
  const valid = { widget_id: "title", target: "text" };
  const invalid = { widget_id: "title", target: "value" };
  assert.deepEqual(cleanRuntimeBindings(project, [valid, invalid]), [valid]);
  assert.equal(canPasteRuntimeBinding(widget, valid), true);
  assert.equal(canPasteRuntimeBinding(widget, invalid), false);
});
