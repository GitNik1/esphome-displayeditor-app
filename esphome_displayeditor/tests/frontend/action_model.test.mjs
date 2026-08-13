import assert from "node:assert/strict";
import test from "node:test";

import {
  actionIdsForEditor,
  actionObjectEntry,
  generatedActionCondition,
  normalizeActionColor,
  widgetSupportsValueCondition,
} from "../../frontend/actions/model.js";

test("action entries accept exactly one mapping key", () => {
  assert.deepEqual(actionObjectEntry({ "lvgl.widget.show": "panel" }), ["lvgl.widget.show", "panel"]);
  assert.equal(actionObjectEntry({}), null);
  assert.equal(actionObjectEntry({ one: 1, two: 2 }), null);
  assert.equal(actionObjectEntry([]), null);
});

test("action ids support scalar, list and object payloads", () => {
  assert.deepEqual(actionIdsForEditor("one"), ["one"]);
  assert.deepEqual(actionIdsForEditor(["one", { id: ["two", "three"] }]), ["one", "two", "three"]);
  assert.deepEqual(actionIdsForEditor({ text: "no id" }), []);
});

test("generated checked conditions are recognized structurally", () => {
  const branch = { "lvgl.widget.show": "panel" };
  assert.deepEqual(generatedActionCondition({ if: {
    condition: { lambda: " return x; " },
    then: [branch],
  } }), { condition: "checked", action: branch });
  assert.equal(generatedActionCondition({ if: {
    condition: { lambda: "return x > 5;" },
    then: [branch],
  } }), null);
});

test("value conditions are limited to boolean widgets", () => {
  assert.equal(widgetSupportsValueCondition({ widget_type: "switch" }), true);
  assert.equal(widgetSupportsValueCondition({ widget_type: "checkbox" }), true);
  assert.equal(widgetSupportsValueCondition({ widget_type: "button", properties: { checkable: true } }), true);
  assert.equal(widgetSupportsValueCondition({ widget_type: "button", properties: {} }), false);
  assert.equal(widgetSupportsValueCondition({ widget_type: "slider" }), false);
});

test("action colors normalize valid RGB hex without damaging expressions", () => {
  assert.equal(normalizeActionColor(" #a1b2c3 "), "0xA1B2C3");
  assert.equal(normalizeActionColor("0x00ffAA"), "0x00FFAA");
  assert.equal(normalizeActionColor("id(theme_color)"), "id(theme_color)");
});

