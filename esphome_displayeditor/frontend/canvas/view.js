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
  return { back, front, handles };
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
