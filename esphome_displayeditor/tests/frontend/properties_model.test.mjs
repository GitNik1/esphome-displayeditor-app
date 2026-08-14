import assert from "node:assert/strict";
import test from "node:test";

import { parseListValue, propertyInputValue, propertyTarget, propertyValueClears } from "../../frontend/properties/model.js";

test("property targets create layout, grid and state style branches", () => {
  const widget = { properties: {}, style_tree: {} };
  assert.equal(propertyTarget(widget, { category: "content" }, false), widget.properties);
  assert.equal(propertyTarget(widget, { category: "layout" }, true), widget.layout);
  assert.equal(propertyTarget(widget, { category: "grid_cell" }, true), widget.grid_cell);
  const stateStyle = propertyTarget(widget, { category: "style", part: "indicator" }, true, "style", "pressed");
  assert.equal(stateStyle, widget.style_tree.states.pressed.indicator);
});

test("property lists retain ESPHome grid expressions and parse pixels", () => {
  assert.deepEqual(parseListValue({ kind: "grid_track_list" }, "40, FR(1), -2"), [40, "FR(1)", -2]);
  assert.deepEqual(parseListValue({ kind: "text_list" }, " a, ,b "), ["a", "b"]);
});

test("property controls convert booleans, numbers and empty values", () => {
  assert.equal(propertyInputValue({ kind: "bool" }, { checked: true }), true);
  assert.equal(propertyInputValue({ kind: "int" }, { value: "12" }), 12);
  assert.equal(propertyInputValue({ kind: "float" }, { value: "" }), null);
  assert.equal(propertyValueClears([]), true);
  assert.equal(propertyValueClears(false), false);
});

test("property controls parse structured JSON values", () => {
  assert.deepEqual(propertyInputValue({ kind: "json" }, { value: '[{"range_from":0}]' }), [{ range_from: 0 }]);
  assert.throws(() => propertyInputValue({ kind: "json" }, { value: "[invalid" }), SyntaxError);
});
