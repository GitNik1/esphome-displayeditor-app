// @ts-check

import { widgetBoxStyle } from "./geometry.js";

/** @typedef {{left: number, top: number, width: number, height: number}} Box */
/** @param {Map<object, Box>} boxes @param {Map<object, HTMLElement>} nodes */
export function applyWidgetLayout(boxes, nodes) {
  boxes.forEach((box, widget) => {
    const node = nodes.get(widget);
    if (node) Object.assign(node.style, widgetBoxStyle(box));
  });
}

/** @param {Pick<Document, "createElement">} document */
export function createCanvasLayers(document) {
  const back = document.createElement("canvas");
  back.id = "glow-canvas-back";
  back.className = "glow-canvas";
  const front = document.createElement("canvas");
  front.id = "glow-canvas-front";
  front.className = "glow-canvas";
  const handles = document.createElement("div");
  handles.id = "glow-handles";
  handles.className = "glow-handles";
  // renderCanvas() rebuilds the whole #canvas subtree from scratch on every
  // call via replaceChildren() - anything not recreated here and re-appended
  // there (like the resize/glow layers above) is permanently gone after the
  // very first render, which is exactly what happened to these three before
  // they were added to this factory.
  const alignGuideX = document.createElement("div");
  alignGuideX.id = "align-guide-x";
  alignGuideX.className = "align-guide align-guide-x hidden";
  const alignGuideY = document.createElement("div");
  alignGuideY.id = "align-guide-y";
  alignGuideY.className = "align-guide align-guide-y hidden";
  const marquee = document.createElement("div");
  marquee.id = "marquee-select";
  marquee.className = "marquee-select hidden";
  // One small "12px"-style readout per side, shown next to the nearest
  // neighbour even when nothing is close enough to actually snap.
  /** @type {Record<string, any>} */
  const gapLabels = {};
  ["left", "right", "top", "bottom"].forEach((side) => {
    const label = document.createElement("span");
    label.id = `gap-label-${side}`;
    label.className = `gap-label gap-label-${side} hidden`;
    gapLabels[side] = label;
  });
  return { back, front, handles, alignGuideX, alignGuideY, marquee, gapLabels };
}

/** @param {HTMLElement} canvas
 * @param {{canvas: {width: number, height: number}}} project
 * @param {string} mode @param {string} lineTool */
export function configureCanvas(canvas, project, mode, lineTool) {
  canvas.style.width = `${project.canvas.width}px`;
  canvas.style.height = `${project.canvas.height}px`;
  canvas.classList.toggle("lines-mode", mode === "lines");
  canvas.classList.toggle("tool-select", lineTool === "select");
}
