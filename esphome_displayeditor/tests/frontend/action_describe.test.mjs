import assert from "node:assert/strict";
import test from "node:test";

import { describeFlowAction, describeWidgetAction } from "../../frontend/actions/describe.js";

const translate = (key, values = {}) => `${key}${values.name ? `:${values.name}` : ""}|`;

test("describes conditional widget actions and preserves targets", () => {
  const result = describeWidgetAction({ if: {
    condition: { lambda: "return !x;" },
    then: [{ "lvgl.widget.hide": ["panel", "menu"] }],
  } }, translate);
  assert.equal(result.text, "action.desc.whenUnchecked|action.desc.hide|: panel, menu");
  assert.deepEqual(result.targetIds, ["panel", "menu"]);
  assert.equal(result.supported, true);
});

test("update descriptions require an id and at least one field", () => {
  assert.equal(describeWidgetAction({ "lvgl.label.update": { id: "title" } }, translate).supported, false);
  const result = describeWidgetAction({ "lvgl.label.update": { id: "title", text: "Ready" } }, translate);
  assert.equal(result.supported, true);
  assert.deepEqual(result.targetIds, ["title"]);
  assert.match(result.text, /text/);
});

test("flow descriptions collect nested animation targets", () => {
  const action = { if: {
    condition: { lambda: "return abs((int)x) <= 2;" },
    then: [{ "lvgl.widget.hide": "forward" }, { "lvgl.widget.hide": "reverse" }],
    else: [{ if: {
      condition: { lambda: "return x > 0;" },
      then: [{ "lvgl.animimg.start": "forward" }],
      else: [{ "lvgl.animimg.start": "reverse" }],
    } }],
  } };
  const result = describeFlowAction(action, translate);
  assert.deepEqual(result.targetIds, ["forward", "reverse"]);
  assert.equal(result.skipMissingCheck, true);
});

test("unknown actions remain visible as YAML-only actions", () => {
  const result = describeWidgetAction({ "custom.action": { id: "target" } }, translate);
  assert.equal(result.text, "action.desc.yamlOnly:custom.action|");
  assert.equal(result.supported, false);
  assert.deepEqual(result.targetIds, ["target"]);
});

