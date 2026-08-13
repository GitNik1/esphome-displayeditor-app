import assert from "node:assert/strict";
import test from "node:test";

import { pointFromClient, snapAngle, widgetBoxStyle } from "../../frontend/canvas/geometry.js";

test("client coordinates are converted through canvas zoom", () => {
  assert.deepEqual(pointFromClient(30, 50, { left: 10, top: 20 }, 2), [10, 15]);
});

test("angles snap around their origin while keeping distance", () => {
  const point = snapAngle([0, 0], [10, 2], Math.PI / 4);
  assert.ok(Math.abs(point[1]) < 1e-10);
  assert.ok(Math.abs(Math.hypot(...point) - Math.hypot(10, 2)) < 1e-10);
  const same = [0, 0];
  assert.equal(snapAngle([0, 0], same, Math.PI / 2), same);
});

test("widget box styles prevent zero-sized DOM nodes", () => {
  assert.deepEqual(widgetBoxStyle({ left: 2, top: 3, width: 0, height: -2 }), { left: "2px", top: "3px", width: "1px", height: "1px" });
});
