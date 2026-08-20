import assert from "node:assert/strict";
import test from "node:test";
import { applyWidgetLayout, configureCanvas, createCanvasLayers } from "../../frontend/canvas/view.js";

function element(tag) { return { tag, style: {}, className: "", classList: { values: {}, toggle(name, value) { this.values[name] = value; } } }; }

test("canvas view creates stable layer identities", () => {
  const layers = createCanvasLayers({ createElement: element });
  assert.deepEqual(
    [layers.back.id, layers.front.id, layers.handles.id, layers.alignGuideX.id, layers.alignGuideY.id, layers.marquee.id],
    ["glow-canvas-back", "glow-canvas-front", "glow-handles", "align-guide-x", "align-guide-y", "marquee-select"],
  );
  assert.deepEqual(
    Object.keys(layers.gapLabels).sort(),
    ["bottom", "left", "right", "top"],
  );
  assert.equal(layers.gapLabels.left.id, "gap-label-left");
});

test("canvas view configures dimensions, modes and widget boxes", () => {
  const canvas = element("div");
  configureCanvas(canvas, { canvas: { width: 320, height: 240 } }, "lines", "select");
  assert.equal(canvas.style.width, "320px");
  assert.equal(canvas.classList.values["lines-mode"], true);
  const widget = {};
  const node = element("div");
  applyWidgetLayout(new Map([[widget, { left: 1, top: 2, width: 3, height: 4 }]]), new Map([[widget, node]]));
  assert.equal(node.style.left, "1px");
});
