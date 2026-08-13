import assert from "node:assert/strict";
import test from "node:test";

import { buildWidgetAction, wrapValueCondition } from "../../frontend/actions/build.js";

test("builds simple target actions", () => {
  assert.deepEqual(buildWidgetAction({ type: "show", targetId: "panel" }), {
    "lvgl.widget.show": "panel",
  });
  assert.deepEqual(buildWidgetAction({ type: "page_show", targetId: "home" }), {
    "lvgl.page.show": "home",
  });
  assert.deepEqual(buildWidgetAction({ type: "animimg_stop", targetId: "flow" }), {
    "lvgl.animimg.stop": "flow",
  });
});

test("uses widget-specific update actions and normalized fields", () => {
  assert.deepEqual(buildWidgetAction({
    type: "update",
    targetId: "title",
    targetWidget: { widget_type: "label" },
    fields: { text: " Ready ", bg_color: "#00aaff", opa: "80%" },
  }), {
    "lvgl.label.update": {
      id: "title", text: "Ready", bg_color: "0x00AAFF", opa: "80%",
    },
  });
});

test("ignores fields unsupported by the target widget", () => {
  assert.throws(() => buildWidgetAction({
    type: "update",
    targetId: "slider",
    targetWidget: { widget_type: "slider" },
    fields: { text: "ignored", imageSource: "ignored" },
  }), /missing_update_fields/);
});

test("wraps boolean value conditions", () => {
  const action = { "lvgl.widget.show": "panel" };
  assert.equal(wrapValueCondition(action, "always"), action);
  assert.deepEqual(wrapValueCondition(action, "unchecked"), {
    if: { condition: { lambda: "return !x;" }, then: [action] },
  });
  assert.throws(() => wrapValueCondition(action, "numeric"), /invalid_value_condition/);
});

