// @ts-check

import {
  findViewerWidget,
  findViewerIndicator,
  isViewerSafeLiteral,
  isViewerSafeStringList,
  viewerUpdatePayloads,
} from "./action-model.js";

const RUNTIME_STYLE_KEYS = new Set([
  "bg_color", "text_color", "border_color", "opa", "bg_opa", "border_width", "radius",
]);

/** @type {Record<string, Set<string>>} */
const UPDATE_KEYS = {
  "lvgl.widget.update": new Set(["hidden", "text", "value", "state_checked", ...RUNTIME_STYLE_KEYS]),
  "lvgl.label.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
  "lvgl.button.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
  "lvgl.image.update": new Set(["src", ...RUNTIME_STYLE_KEYS]),
  "lvgl.slider.update": new Set(["value", ...RUNTIME_STYLE_KEYS]),
  "lvgl.bar.update": new Set(["value", "start_value", "min_value", "max_value", "mode", "animated", ...RUNTIME_STYLE_KEYS]),
  "lvgl.arc.update": new Set(["value", "min_value", "max_value", "mode", "start_angle", "end_angle", "rotation", "adjustable", "change_rate", ...RUNTIME_STYLE_KEYS]),
  "lvgl.switch.update": new Set(["state_checked", ...RUNTIME_STYLE_KEYS]),
  "lvgl.dropdown.update": new Set(["selected_index", "options", ...RUNTIME_STYLE_KEYS]),
  "lvgl.roller.update": new Set(["selected_index", "options", ...RUNTIME_STYLE_KEYS]),
  "lvgl.textarea.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
  "lvgl.keyboard.update": new Set(["mode", "textarea", ...RUNTIME_STYLE_KEYS]),
  "lvgl.led.update": new Set(["color", "brightness", ...RUNTIME_STYLE_KEYS]),
  "lvgl.spinner.update": new Set(["arc_color", "arc_width", "arc_length", "arc_rounded", "spin_time"]),
  "lvgl.qrcode.update": new Set(["text", "size", "dark_color", "light_color", ...RUNTIME_STYLE_KEYS]),
  "lvgl.spinbox.update": new Set(["value"]),
  "lvgl.animimg.update": new Set(["duration", "repeat_count", ...RUNTIME_STYLE_KEYS]),
};

/** @type {Record<string, string>} */
const UPDATE_WIDGET_TYPES = {
  "lvgl.label.update": "label", "lvgl.button.update": "button", "lvgl.image.update": "image",
  "lvgl.slider.update": "slider", "lvgl.bar.update": "bar", "lvgl.arc.update": "arc",
  "lvgl.switch.update": "switch", "lvgl.dropdown.update": "dropdown", "lvgl.roller.update": "roller",
  "lvgl.textarea.update": "textarea", "lvgl.keyboard.update": "keyboard", "lvgl.led.update": "led",
  "lvgl.spinner.update": "spinner", "lvgl.qrcode.update": "qrcode", "lvgl.spinbox.update": "spinbox",
  "lvgl.animimg.update": "animimg",
};

const NUMERIC_KEYS = new Set(["value", "start_value", "min_value", "max_value", "start_angle", "end_angle", "rotation", "change_rate", "selected_index", "size", "arc_width", "arc_length"]);
const BOOLEAN_KEYS = new Set(["hidden", "state_checked", "animated", "adjustable", "arc_rounded"]);
const LIST_KEYS = new Set(["options"]);

/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {{handled: boolean, changed: boolean, warning?: boolean, message: string}} ActionResult */

/** @param {any} project @param {string} name @param {any} payload @param {Translate} translate
 * @param {any} [context]
 * @returns {ActionResult | null} */
export function applyViewerUpdate(project, name, payload, translate, context = {}) {
  if (name === "lvgl.indicator.update") {
    let changed = false;
    const notes = [];
    const updates = viewerUpdatePayloads(payload);
    updates.forEach((update) => {
      if (!isViewerSafeLiteral(update.id)) {
        notes.push(translate("viewer.event.missingId"));
        return;
      }
      const indicator = findViewerIndicator(project, update.id);
      if (!indicator) {
        notes.push(translate("viewer.event.updateNotFound", { id: update.id }));
        return;
      }
      Object.entries(update).forEach(([key, value]) => {
        if (key === "id") return;
        if (key === "value" && value && typeof value === "object"
            && value.__esphome_lambda__ === "return int(x);") {
          value = Math.trunc(Number(context.x));
        }
        if (!["value", "start_value", "end_value", "opa"].includes(key) || !isViewerSafeLiteral(value)) {
          notes.push(translate("viewer.event.notAllowed", { ref: `${update.id}.${key}` }));
          return;
        }
        if (["value", "start_value", "end_value"].includes(key) && !Number.isFinite(Number(value))) {
          notes.push(translate("viewer.event.expectedNumeric", { ref: `${update.id}.${key}` }));
          return;
        }
        indicator[key] = ["value", "start_value", "end_value"].includes(key) ? Number(value) : value;
        changed = true;
      });
    });
    if (!updates.length) notes.push(translate("viewer.event.noValidUpdateData"));
    return {
      handled: true, changed, warning: Boolean(notes.length),
      message: `${name}${notes.length ? ` (${notes.join("; ")})` : ""}`,
    };
  }
  const allowedKeys = UPDATE_KEYS[name];
  if (!allowedKeys) return null;
  let changed = false;
  /** @type {string[]} */
  const notes = [];
  const updates = viewerUpdatePayloads(payload);
  updates.forEach((update) => {
    if (!isViewerSafeLiteral(update.id)) {
      notes.push(translate("viewer.event.missingId"));
      return;
    }
    const widget = findViewerWidget(project, update.id);
    if (!widget) {
      notes.push(translate("viewer.event.updateNotFound", { id: update.id }));
      return;
    }
    const expectedType = UPDATE_WIDGET_TYPES[name];
    if (expectedType && widget.widget_type !== expectedType) {
      notes.push(translate("viewer.event.notWidgetType", { id: update.id, type: expectedType }));
      return;
    }
    Object.entries(update).forEach(([key, value]) => {
      if (key === "id") return;
      const isList = LIST_KEYS.has(key);
      if (!allowedKeys.has(key) || (isList ? !isViewerSafeStringList(value) : !isViewerSafeLiteral(value))) {
        notes.push(translate("viewer.event.notAllowed", { ref: `${widget.id}.${key}` }));
        return;
      }
      if (BOOLEAN_KEYS.has(key) && typeof value !== "boolean") {
        notes.push(translate("viewer.event.expectedBoolean", { ref: `${widget.id}.${key}` }));
        return;
      }
      if (NUMERIC_KEYS.has(key) && !Number.isFinite(Number(value))) {
        notes.push(translate("viewer.event.expectedNumeric", { ref: `${widget.id}.${key}` }));
        return;
      }
      if (key === "hidden") widget.hidden = value;
      else if (RUNTIME_STYLE_KEYS.has(key)) {
        widget.style_tree ||= {};
        widget.style_tree[key] = value;
      } else {
        widget.properties ||= {};
        if (BOOLEAN_KEYS.has(key)) widget.properties[key] = value;
        else if (NUMERIC_KEYS.has(key)) widget.properties[key] = Number(value);
        else if (isList && Array.isArray(value)) widget.properties[key] = value.map(String);
        else widget.properties[key] = String(value ?? "");
      }
      changed = true;
    });
  });
  if (!updates.length) notes.push(translate("viewer.event.noValidUpdateData"));
  const detail = notes.length ? ` (${notes.join("; ")})` : "";
  return { handled: true, changed, warning: Boolean(notes.length), message: `${name}${detail}` };
}
