// @ts-check

import { viewerWidgetRoots } from "./surfaces.js";

/** @param {any} project @param {unknown} id @returns {any | null} */
export function findViewerWidget(project, id) {
  /** @type {any | null} */
  let found = null;
  /** @param {any[]} widgets */
  const visit = (widgets) => {
    for (const widget of widgets || []) {
      if (String(widget.id || "") === String(id)) {
        found = widget;
        return;
      }
      visit(widget.children || []);
      if (found) return;
    }
  };
  visit(viewerWidgetRoots(project));
  if (found) return found;
  return (project.msgboxes || []).find((/** @type {any} */ msgbox) => (
    String(msgbox.id || "") === String(id)
  )) || null;
}

/** @param {any} project @param {unknown} id @returns {any | null} */
export function findViewerIndicator(project, id) {
  /** @type {any | null} */
  let found = null;
  /** @param {any[]} widgets */
  const visit = (widgets) => {
    for (const widget of widgets || []) {
      if (widget.widget_type === "meter") {
        for (const scale of widget.properties?.scales || []) {
          for (const entry of scale?.indicators || []) {
            const config = entry && typeof entry === "object" ? Object.values(entry)[0] : null;
            if (config && typeof config === "object" && String(config.id || "") === String(id)) {
              found = config;
              return;
            }
          }
        }
      }
      visit(widget.children || []);
      if (found) return;
    }
  };
  visit(viewerWidgetRoots(project));
  return found;
}

/** @param {any} payload @returns {string[]} */
export function viewerActionIds(payload) {
  if (["string", "number"].includes(typeof payload)) return [String(payload)];
  if (Array.isArray(payload)) return payload.flatMap(viewerActionIds);
  if (payload && typeof payload === "object") return viewerActionIds(payload.id);
  return [];
}

/** @param {any} payload */
export function viewerPageActionId(payload) {
  return viewerActionIds(payload)[0] || "";
}

/** @param {any} project @param {any} runtime @param {number} direction */
export function navigateViewerPage(project, runtime, direction) {
  const pages = project.pages || [];
  if (!pages.length) return null;
  const current = Math.max(0, pages.findIndex((/** @type {any} */ page) => page.id === runtime.activePageId));
  for (let distance = 1; distance <= pages.length; distance += 1) {
    let candidate = current + (distance * direction);
    if (project.page_wrap !== false) candidate = ((candidate % pages.length) + pages.length) % pages.length;
    else if (candidate < 0 || candidate >= pages.length) return null;
    if (!pages[candidate].skip) return pages[candidate];
  }
  return null;
}

/** @param {any} payload @returns {Record<string, any>[]} */
export function viewerUpdatePayloads(payload) {
  return (Array.isArray(payload) ? payload : [payload])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

/** @param {unknown} value */
export function isViewerSafeLiteral(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** @param {unknown} value */
export function isViewerSafeStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const ABS_COMPARE_RE = /^returnabs\(\(int\)x\)([<>]=?)(-?\d+(?:\.\d+)?);$/;
const VALUE_COMPARE_RE = /^returnx([<>]=?)(-?\d+(?:\.\d+)?);$/;

/** @param {string} operator @param {number} value @param {number} threshold */
function compare(operator, value, threshold) {
  if (operator === "<=") return value <= threshold;
  if (operator === "<") return value < threshold;
  if (operator === ">=") return value >= threshold;
  return value > threshold;
}

/** @param {any} condition @param {any} context */
export function viewerConditionValue(condition, context) {
  const expression = String(condition?.lambda || "").replace(/\s+/g, "").toLowerCase();
  if (expression === "returnx;") return { supported: true, value: Boolean(context.x) };
  if (expression === "return!x;") return { supported: true, value: !Boolean(context.x) };
  const x = Number(context.x);
  if (Number.isFinite(x)) {
    const absolute = expression.match(ABS_COMPARE_RE);
    if (absolute) return { supported: true, value: compare(absolute[1], Math.abs(x), Number(absolute[2])) };
    const plain = expression.match(VALUE_COMPARE_RE);
    if (plain) return { supported: true, value: compare(plain[1], x, Number(plain[2])) };
  }
  return { supported: false, value: false };
}
