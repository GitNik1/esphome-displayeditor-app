import assert from "node:assert/strict";
import test from "node:test";

import { buildFlowAction } from "../../frontend/actions/flow.js";

test("single-direction flow hides below threshold and changes speed", () => {
  const action = buildFlowAction({
    forwardId: "solar_anim",
    offThreshold: 5,
    fastThreshold: 1000,
    normalDuration: 900,
    fastDuration: 300,
  });
  assert.equal(action.if.condition.lambda, "return abs((int)x) <= 5;");
  assert.deepEqual(action.if.then, [{ "lvgl.widget.hide": "solar_anim" }]);
  assert.equal(action.if.else[0]["lvgl.widget.show"], "solar_anim");
  assert.equal(action.if.else[2].if.then[0]["lvgl.animimg.update"].duration, "300ms");
  assert.equal(action.if.else[2].if.else[0]["lvgl.animimg.update"].duration, "900ms");
});

test("bidirectional flow selects animation by value sign", () => {
  const action = buildFlowAction({
    forwardId: "grid_anim",
    reverseId: "grid_anim_rev",
    offThreshold: 2,
    fastThreshold: 500,
    normalDuration: 800,
    fastDuration: 200,
  });
  assert.deepEqual(action.if.then, [
    { "lvgl.widget.hide": "grid_anim" },
    { "lvgl.widget.hide": "grid_anim_rev" },
  ]);
  const direction = action.if.else[0].if;
  assert.equal(direction.condition.lambda, "return x > 0;");
  assert.equal(direction.then[1]["lvgl.widget.show"], "grid_anim");
  assert.equal(direction.else[1]["lvgl.widget.show"], "grid_anim_rev");
});

test("flow values are clamped and invalid thresholds rejected", () => {
  assert.throws(() => buildFlowAction({
    forwardId: "flow",
    offThreshold: -10,
    fastThreshold: 0,
    normalDuration: 0,
    fastDuration: 0,
  }), /invalid_thresholds/);
  assert.throws(() => buildFlowAction({
    forwardId: "",
    offThreshold: 0,
    fastThreshold: 1,
  }), /missing_forward_target/);
});

