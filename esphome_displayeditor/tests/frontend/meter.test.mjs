import assert from "node:assert/strict";
import test from "node:test";

import {
  meterLength,
  meterLineGeometry,
  meterScales,
  meterTickGeometry,
  meterTickStyle,
  meterValueAngle,
} from "../../frontend/viewer/meter.js";
import { applyViewerUpdate } from "../../frontend/viewer/action-updates.js";

const translate = (key, params = {}) => `${key}${params.id ? `:${params.id}` : ""}`;

test("meter geometry maps values, ticks and percentage lengths", () => {
  const scale = {
    range_from: -10, range_to: 40, rotation: 150, angle_range: 240,
    ticks: { count: 6, length: 4, major: { stride: 5, length: "20%" } },
  };
  assert.equal(meterValueAngle(scale, -10), 150);
  assert.equal(meterValueAngle(scale, 40), 390);
  assert.equal(meterLength("50%", 40), 20);
  const ticks = meterTickGeometry(scale, 40);
  assert.equal(ticks.length, 6);
  assert.equal(ticks[0].isMajor, true);
  assert.equal(ticks[1].value, 0);
  assert.equal(ticks[5].inner, 32);
  assert.deepEqual(meterLineGeometry(scale, { value: 15, length: "80%", radial_offset: 2 }, 40), {
    angle: 270, start: 2, end: 34,
  });
});

test("meter scales and tick-style gradients retain every scale", () => {
  const second = { range_from: 0, range_to: 60 };
  assert.deepEqual(meterScales([{ range_from: -10 }, second]), [{ range_from: -10 }, second]);
  assert.deepEqual(meterScales(second), [second]);
  const scale = {
    range_from: 0, range_to: 100,
    indicators: [{ tick_style: { start_value: 20, end_value: 60, local: true, color_start: "blue", color_end: "red" } }],
  };
  assert.equal(meterTickStyle(scale, 10), null);
  assert.equal(meterTickStyle(scale, 40).fraction, 0.5);
});

test("viewer applies safe indicator updates by indicator id", () => {
  const indicator = { id: "needle", value: 0 };
  const project = {
    widgets: [{ id: "meter", widget_type: "meter", properties: { scales: [{ indicators: [{ line: indicator }] }] }, children: [] }],
  };
  const result = applyViewerUpdate(project, "lvgl.indicator.update", { id: "needle", value: 42, opa: "70%" }, translate);
  assert.equal(result.handled, true);
  assert.equal(result.changed, true);
  assert.equal(indicator.value, 42);
  assert.equal(indicator.opa, "70%");
  const rejected = applyViewerUpdate(project, "lvgl.indicator.update", { id: "needle", color: "red" }, translate);
  assert.equal(rejected.warning, true);
  assert.equal(indicator.color, undefined);
  const dynamic = applyViewerUpdate(project, "lvgl.indicator.update", {
    id: "needle", value: { __esphome_lambda__: "return int(x);" },
  }, translate, { x: 73.8 });
  assert.equal(dynamic.changed, true);
  assert.equal(indicator.value, 73);
});
