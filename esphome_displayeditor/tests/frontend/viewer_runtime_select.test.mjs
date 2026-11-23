import assert from "node:assert/strict";
import test from "node:test";

import { applyRuntimeBinding, entityMatchesRuntimeTarget, runtimeSelectedIndex } from "../../frontend/viewer/runtime.js";

test("a select entity's option text becomes the dropdown index", () => {
  const options = ["Aus", "Eco", "Komfort"];
  assert.equal(runtimeSelectedIndex("Eco", options), 1);
  assert.equal(runtimeSelectedIndex("komfort", options), 2);
  assert.equal(runtimeSelectedIndex("2", options), 2);
  assert.equal(runtimeSelectedIndex("7", options), null);
  assert.equal(runtimeSelectedIndex("Turbo", options), null);
  assert.equal(runtimeSelectedIndex("", options), null);
  // Numeric option labels are matched as labels first.
  assert.equal(runtimeSelectedIndex("10", ["5", "10"]), 1);
});

test("a dropdown binding applies the option the state names", () => {
  const widget = { id: "mode", widget_type: "dropdown", properties: { options: ["Aus", "Eco"], selected_index: 0 } };
  const project = { widgets: [widget] };
  const source = { widgets: [structuredClone(widget)] };
  const binding = { widget_id: "mode", target: "selected_index", device_id: "d", entity_id: "select:mode" };

  assert.equal(applyRuntimeBinding(project, source, binding, { state: "Eco", available: true }), true);
  assert.equal(widget.properties.selected_index, 1);
  assert.equal(applyRuntimeBinding(project, source, binding, { state: "Turbo", available: true }), false);
  assert.equal(widget.properties.selected_index, 1);
});

test("select entities are offered for a selected-index target", () => {
  assert.equal(entityMatchesRuntimeTarget({ type: "select" }, "selected_index"), true);
  assert.equal(entityMatchesRuntimeTarget({ type: "select" }, "value"), false);
});
