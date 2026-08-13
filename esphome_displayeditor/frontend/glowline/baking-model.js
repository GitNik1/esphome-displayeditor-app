// @ts-check

import { boundingBox } from "./geometry.js";
import { strokePath } from "./renderer.js";
import { projectWidgetEntries } from "../project/model.js";

/** @typedef {{left: number, top: number, right: number, bottom: number}} Rect */
/** @typedef {{width: number, height: number}} CanvasSize */
/** @typedef {Record<string, any> & {id: string, widget_type: string,
 * children: any[], properties: Record<string, any>}} BakedWidget */
/** @typedef {Record<string, any> & {widgets: any[], images?: any[], reserved_ids?: string[]}} BakeProject */
/** @typedef {{reserved?: (id: string) => string, collision?: (id: string) => string}} BakeMessages */

/** @param {unknown} text @param {string} fallback */
export function slugifyStrokeName(text, fallback) {
  let slug = String(text || "").trim().toLowerCase()
    .replace(/[äöüß]/g, (character) => /** @type {Record<string, string>} */ ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[character])
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = fallback;
  return slug;
}

/** @param {{id: string, name?: string}} stroke */
export function strokeBaseName(stroke) {
  return slugifyStrokeName(stroke.name, stroke.id);
}

/** @param {any} stroke @param {CanvasSize} canvas @returns {Rect} */
export function strokeRenderBounds(stroke, canvas) {
  const { measure } = strokePath(stroke);
  const box = boundingBox(measure);
  if (!box) return { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
  const margin = stroke.width / 2 + (stroke.glow.enabled ? stroke.glow.radius : 0) + 2;
  return {
    left: Math.max(0, box.left - margin),
    top: Math.max(0, box.top - margin),
    right: Math.min(canvas.width, box.right + margin),
    bottom: Math.min(canvas.height, box.bottom + margin),
  };
}

/** @param {string} id @param {Rect} rect @param {string} src @returns {BakedWidget} */
export function newImageWidget(id, rect, src) {
  return {
    id,
    widget_type: "image",
    name: "",
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.right - rect.left),
    height: Math.round(rect.bottom - rect.top),
    align: "TOP_LEFT",
    align_to: "",
    hidden: false,
    locked: false,
    properties: { src, angle: 0, zoom: 1 },
    style_mode: "inline",
    style_refs: [],
    style_tree: {},
    events: {},
    children: [],
    tab_title: "",
    tile_row: 0,
    tile_col: 0,
    tile_dir: "ALL",
    layout: {},
    grid_cell: {},
    extra: {},
    source: "editor",
    synthetic_id: false,
  };
}

/** @param {string} id @param {Rect} rect @param {string[]} frameIds
 * @param {number} durationMs @returns {BakedWidget} */
export function newAnimimgWidget(id, rect, frameIds, durationMs) {
  const widget = newImageWidget(id, rect, "");
  widget.widget_type = "animimg";
  widget.properties = {
    src: frameIds,
    duration: durationMs,
    repeat_count: "forever",
    auto_start: true,
  };
  return widget;
}

/** @param {BakeProject} project @param {string} id @param {string} filePath */
export function ensureImageEntry(project, id, filePath) {
  if (!Array.isArray(project.images)) project.images = [];
  let entry = project.images.find((/** @type {any} */ image) => image.id === id);
  if (!entry) {
    entry = {
      id,
      file_path: filePath,
      resize: "",
      dither: "",
      transparency: "alpha_channel",
      img_type: "RGB565",
      external: true,
      extra: {},
    };
    project.images.push(entry);
  } else {
    Object.assign(entry, {
      file_path: filePath,
      external: true,
      transparency: "alpha_channel",
      img_type: "RGB565",
    });
  }
  return entry;
}

/** @param {BakeProject} project @param {string} widgetId @param {BakedWidget} freshWidget
 * @param {any | null} target @param {BakeMessages} [messages] */
export function upsertBakedWidget(project, widgetId, freshWidget, target, messages = {}) {
  if ((project.reserved_ids || []).includes(widgetId)) {
    throw new Error(messages.reserved?.(widgetId) || `Reserved widget id: ${widgetId}`);
  }
  const existing = projectWidgetEntries(project).find((item) => item.id === widgetId);
  if (existing) {
    if (existing.widget_type !== freshWidget.widget_type) {
      throw new Error(messages.collision?.(widgetId) || `Widget id collision: ${widgetId}`);
    }
    Object.assign(existing, freshWidget, { id: widgetId, children: existing.children });
    return existing;
  }
  if (target) target.children.push(freshWidget);
  else project.widgets.push(freshWidget);
  return freshWidget;
}

/** @param {BakeProject} project @param {string} widgetId @param {any | null} target */
export function removeBakedWidget(project, widgetId, target) {
  const list = target ? target.children : project.widgets;
  const index = (list || []).findIndex((/** @type {any} */ item) => item.id === widgetId);
  if (index >= 0) list.splice(index, 1);
  return index >= 0;
}
