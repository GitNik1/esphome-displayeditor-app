import assert from "node:assert/strict";
import test from "node:test";
import {
  alignBoxes, alignmentSnap, canvasAlignmentBox, distributeBoxes, dragPosition,
  nearestGaps, resizeDimensions, translatePoints,
} from "../../frontend/canvas/interactions.js";

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

test("alignment snap finds the closest edge match within threshold", () => {
  const box = { left: 22, top: 50, width: 40, height: 20 };
  const others = [{ left: 20, top: 100, width: 60, height: 30 }];
  assert.deepEqual(alignmentSnap(box, others, 4), { dx: -2, dy: 0, guideX: 20, guideY: null });
});

test("alignment snap matches a center line when edges do not line up", () => {
  const box = { left: 100, top: 0, width: 20, height: 10 };
  const others = [{ left: 0, top: 200, width: 220, height: 10 }];
  assert.deepEqual(alignmentSnap(box, others, 4), { dx: 0, dy: 0, guideX: 110, guideY: null });
});

test("alignment snap returns no guide when nothing is within threshold", () => {
  const box = { left: 500, top: 500, width: 10, height: 10 };
  const others = [{ left: 0, top: 0, width: 10, height: 10 }];
  assert.deepEqual(alignmentSnap(box, others, 4), { dx: 0, dy: 0, guideX: null, guideY: null });
  assert.deepEqual(box, { left: 500, top: 500, width: 10, height: 10 });
});

test("alignment snap can restrict which of the box's own edges may move, for a resize anchored at top-left", () => {
  const box = { left: 10, top: 5, width: 30, height: 20 };
  const others = [{ left: 5, top: 0, width: 8, height: 5 }];
  assert.deepEqual(alignmentSnap(box, others, 4), { dx: -1, dy: 0, guideX: 9, guideY: 5 });
  assert.deepEqual(
    alignmentSnap(box, others, 4, { xEdges: ["right"], yEdges: ["bottom"] }),
    { dx: 0, dy: 0, guideX: null, guideY: null },
  );
});

test("the canvas itself is just another alignment box", () => {
  assert.deepEqual(canvasAlignmentBox(480, 320), { left: 0, top: 0, width: 480, height: 320 });
});

test("align boxes to the extreme edge or the overall center, across an axis", () => {
  const boxes = [
    { left: 10, top: 0, width: 20, height: 5 },
    { left: 50, top: 100, width: 10, height: 5 },
  ];
  assert.deepEqual(alignBoxes(boxes, "left"), [{ left: 10, top: 0 }, { left: 10, top: 100 }]);
  assert.deepEqual(alignBoxes(boxes, "centerX"), [{ left: 25, top: 0 }, { left: 30, top: 100 }]);
  assert.deepEqual(alignBoxes(boxes, "bottom"), [{ left: 10, top: 100 }, { left: 50, top: 100 }]);
});

test("distribute evens out the gaps between three or more boxes, ends fixed", () => {
  const boxes = [
    { left: 0, top: 0, width: 10, height: 5 },
    { left: 15, top: 0, width: 10, height: 5 },
    { left: 50, top: 0, width: 10, height: 5 },
  ];
  assert.deepEqual(distributeBoxes(boxes, "horizontal"), [{ left: 0, top: 0 }, { left: 25, top: 0 }, { left: 50, top: 0 }]);
});

test("distribute is a no-op below three boxes", () => {
  const boxes = [{ left: 1, top: 2, width: 3, height: 4 }, { left: 9, top: 8, width: 1, height: 1 }];
  assert.deepEqual(distributeBoxes(boxes, "horizontal"), [{ left: 1, top: 2 }, { left: 9, top: 8 }]);
});

test("nearest gaps only count neighbours that actually sit beside/above/below the box", () => {
  const box = { left: 100, top: 100, width: 20, height: 20 };
  const others = [
    { left: 130, top: 100, width: 10, height: 20 },
    { left: 0, top: 100, width: 50, height: 20 },
    { left: 100, top: 130, width: 20, height: 10 },
    { left: 100, top: 0, width: 20, height: 50 },
  ];
  assert.deepEqual(nearestGaps(box, others), {
    left: { gap: 50, from: 50, to: 100 },
    right: { gap: 10, from: 120, to: 130 },
    top: { gap: 50, from: 50, to: 100 },
    bottom: { gap: 10, from: 120, to: 130 },
  });
});

test("an optional grid size rounds drag and resize results, off by default", () => {
  assert.deepEqual(dragPosition({ clientX: 0, clientY: 0, x: 20, y: 20 }, { clientX: 11, clientY: 13 }, 1, { width: 200, height: 200, itemWidth: 10, itemHeight: 10 }, 8), { x: 32, y: 32 });
  assert.deepEqual(dragPosition({ clientX: 0, clientY: 0, x: 20, y: 20 }, { clientX: 11, clientY: 13 }, 1, { width: 200, height: 200, itemWidth: 10, itemHeight: 10 }), { x: 31, y: 33 });
  assert.deepEqual(resizeDimensions({ clientX: 0, clientY: 0, width: 10, height: 10 }, { clientX: 13, clientY: 19 }, 1, { gridSize: 8 }), { width: 24, height: 32 });
});
