import assert from "node:assert/strict";
import test from "node:test";
import { dragPosition, resizeDimensions, translatePoints } from "../../frontend/canvas/interactions.js";

test("drag positions account for zoom and canvas bounds", () => {
  assert.deepEqual(dragPosition({ clientX: 10, clientY: 10, x: 20, y: 30 }, { clientX: 50, clientY: -10 }, 2, { width: 100, height: 80, itemWidth: 30, itemHeight: 20 }), { x: 40, y: 20 });
  assert.deepEqual(dragPosition({ clientX: 0, clientY: 0, x: 0, y: 0 }, { clientX: 999, clientY: 999 }, 1, { width: 100, height: 80, itemWidth: 30, itemHeight: 20 }), { x: 70, y: 60 });
});

test("resize dimensions clamp and point translation stays immutable", () => {
  assert.deepEqual(resizeDimensions({ clientX: 0, clientY: 0, width: 10, height: 10 }, { clientX: -20, clientY: 5000 }, 1), { width: 8, height: 4096 });
  const points = [[1, 2], [3, 4]];
  assert.deepEqual(translatePoints(points, 5, -1), [[6, 1], [8, 3]]);
  assert.deepEqual(points, [[1, 2], [3, 4]]);
});
