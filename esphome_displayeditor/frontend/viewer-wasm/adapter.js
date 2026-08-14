// @ts-check

import { allWidgetItems, surfaceProject, viewerSurfaces } from "../viewer/surfaces.js";
import { viewerImageSource } from "../viewer/assets.js";
import { meterLineGeometry, meterScales, meterTickGeometry, meterTickStyle, meterValueAngle } from "../viewer/meter.js";
import { effectiveViewerPartStyle, effectiveViewerStyle, resolveViewerColor, viewerOpacity } from "../viewer/style.js";

export const WASM_SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "image", "animimg",
  "checkbox", "arc", "bar", "dropdown", "roller", "textarea", "keyboard", "tileview",
  "tabview", "led", "spinner", "qrcode", "spinbox", "meter",
]);

const TYPE = {
  obj: 0, container: 0, label: 1, button: 2, switch: 3, slider: 4, checkbox: 5,
  arc: 6, bar: 7, dropdown: 8, roller: 9, textarea: 10, keyboard: 11,
  tileview: 12, tabview: 13, led: 14, spinner: 15, qrcode: 16, spinbox: 17,
  image: 18, animimg: 19, meter: 20,
};
const PART = { main: 0, indicator: 1, knob: 2, selected: 3, items: 4, cursor: 5 };
const PARTS = ["main", "indicator", "knob", "selected", "items", "cursor"];
const STYLE_STATES = { default: 0, checked: 1, pressed: 2, focused: 3, disabled: 4 };
const KEYBOARD_MODE = { TEXT_LOWER: 0, TEXT_UPPER: 1, TEXT_SPECIAL: 2, NUMBER: 3 };
const TAB_POSITION = { TOP: 0x01, BOTTOM: 0x02, LEFT: 0x04, RIGHT: 0x08 };
const TILE_DIRECTION = { LEFT: 0x04, RIGHT: 0x08, TOP: 0x01, BOTTOM: 0x02, HOR: 0x0c, VER: 0x03, ALL: 0x0f };
const LABEL_LONG_MODE = { WRAP: 0, DOT: 1, SCROLL: 2, SCROLL_CIRCULAR: 3, CLIP: 4 };
const SLIDER_MODE = { NORMAL: 0, SYMMETRICAL: 1, RANGE: 2 };
const ARC_MODE = { NORMAL: 0, SYMMETRICAL: 1, REVERSE: 2 };

/** @typedef {{startupMs: number, wasmBytes: number, manifest: any, objects?: number,
 * memoryBytes?: number, averageFrameMs?: number, unsupported?: string[], supportedObjects?: number,
 * assetWarnings?: string[]}} WasmMetrics */

/** @param {unknown} value @param {number} fallback */
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** @param {unknown} value @param {number} fallback */
function durationMs(value, fallback = 1000) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/^([\d.]+)\s*(ms|s)?$/);
  if (!match) return fallback;
  const result = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  return Number.isFinite(result) ? Math.max(1, Math.round(result)) : fallback;
}

/** @param {any} project @param {unknown} value @param {string} fallback */
export function wasmColor(project, value, fallback) {
  const resolved = resolveViewerColor(project, value) || fallback;
  const match = String(resolved).match(/^#?([0-9a-f]{6})$/i);
  return match ? Number.parseInt(match[1], 16) : Number.parseInt(fallback.replace("#", ""), 16);
}

/** @param {any} project @param {any} style @param {string} fallback */
function nativeStyle(project, style, fallback = "#303841") {
  const opacity = viewerOpacity(style?.bg_opa);
  return {
    background: wasmColor(project, style?.bg_color, fallback),
    foreground: wasmColor(project, style?.text_color, "#f4f7fb"),
    border: wasmColor(project, style?.border_color, "#64748b"),
    borderWidth: Math.max(0, Math.round(number(style?.border_width, 0))),
    radius: Math.max(0, Math.round(number(style?.radius, 6))),
    opacity: Math.max(0, Math.min(255, Math.round((opacity ?? 1) * 255))),
    lineColor: wasmColor(project, style?.arc_color ?? style?.line_color ?? style?.bg_color, "#20c7b7"),
    lineWidth: Math.max(0, Math.round(number(style?.arc_width ?? style?.line_width, 0))),
  };
}

/** @param {any} module @param {string} value @param {(pointer: number) => any} callback */
function withCString(module, value, callback) {
  const bytes = new TextEncoder().encode(`${value}\0`);
  const pointer = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, pointer);
    return callback(pointer);
  } finally { module._free(pointer); }
}

/** @param {any} module @param {string} first @param {string} second @param {(a: number, b: number) => any} callback */
function withTwoStrings(module, first, second, callback) {
  return withCString(module, first, (a) => withCString(module, second, (b) => callback(a, b)));
}

/** @param {any} widget */
function widgetText(widget) {
  return String(widget.properties?.text ?? widget.text ?? "");
}

/** @param {any} project @param {any} widget */
function stateStyles(project, widget) {
  /** @type {Record<string, Record<string, any>>} */ const styles = {};
  Object.keys(STYLE_STATES).forEach((state) => {
    styles[state] = {};
    const active = state === "default" ? [] : [state];
    PARTS.forEach((part) => {
      const value = part === "main"
        ? effectiveViewerStyle(project, widget, active)
        : effectiveViewerPartStyle(project, widget, part, active);
      styles[state][part] = nativeStyle(project, value, widget.widget_type === "label" ? "#000000" : "#303841");
    });
  });
  return styles;
}

/** Create a deterministic projection using the same surfaces and layout engine as HTML. */
export function projectWasmScene(/** @type {any} */ project, runtime = { activePageId: "", activeTiles: {}, activeTabs: {} }) {
  /** @type {any[]} */ const entries = [];
  const unsupported = new Set();
  viewerSurfaces(project, runtime.activePageId).forEach(({ kind, surface }) => {
    const scoped = surfaceProject(project, surface);
    allWidgetItems(scoped, runtime.activeTiles, runtime.activeTabs).forEach(({ widget, box, hidden }) => {
      if (hidden) return;
      if (!WASM_SUPPORTED_WIDGETS.has(widget.widget_type)) {
        unsupported.add(widget.widget_type || "unknown");
        return;
      }
      const styles = stateStyles(project, widget);
      entries.push({
        id: String(widget.id || ""), type: widget.widget_type, widget,
        text: widgetText(widget), checked: Boolean(widget.properties?.state_checked), runtime,
        layer: kind, x: Math.round(number(box.left)), y: Math.round(number(box.top)),
        width: Math.max(1, Math.round(number(box.width, 100))),
        height: Math.max(1, Math.round(number(box.height, 40))), styles,
      });
    });
  });
  (project.msgboxes || []).filter((/** @type {any} */ msgbox) => msgbox.hidden === false).forEach((/** @type {any} */ msgbox) => {
    const width = Math.max(180, Math.round(number(msgbox.width, project.canvas?.width * 0.7)));
    const height = Math.max(120, Math.round(number(msgbox.height, project.canvas?.height * 0.5)));
    const x = Math.round((number(project.canvas?.width, 480) - width) / 2);
    const y = Math.round((number(project.canvas?.height, 480) - height) / 2);
    const panel = { id: msgbox.id, widget_type: "obj", properties: {}, style_tree: msgbox.style_tree || {}, extra: {} };
    entries.push({ id: msgbox.id, type: "obj", widget: panel, layer: "msgbox", x, y, width, height, text: "", checked: false, styles: stateStyles(project, panel) });
    const title = { id: `${msgbox.id}__title`, widget_type: "label", properties: { text: msgbox.title || "" }, style_tree: msgbox.title_style || {}, extra: {} };
    entries.push({ id: title.id, type: "label", widget: title, layer: "msgbox", x: x + 14, y: y + 10, width: width - 28, height: 28, text: widgetText(title), checked: false, styles: stateStyles(project, title) });
    if (msgbox.body?.text) {
      const body = { id: `${msgbox.id}__body`, widget_type: "label", properties: { text: msgbox.body.text }, style_tree: msgbox.body.style_tree || {}, extra: {} };
      entries.push({ id: body.id, type: "label", widget: body, layer: "msgbox", x: x + 14, y: y + 46, width: width - 28, height: height - 100, text: widgetText(body), checked: false, styles: stateStyles(project, body) });
    }
    const buttons = msgbox.buttons || [];
    const buttonWidth = Math.max(64, Math.floor((width - 28 - Math.max(0, buttons.length - 1) * 8) / Math.max(1, buttons.length)));
    buttons.forEach((/** @type {any} */ button, /** @type {number} */ index) => entries.push({
      id: button.id, type: "button", widget: button, layer: "msgbox",
      x: x + 14 + index * (buttonWidth + 8), y: y + height - 48, width: buttonWidth, height: 34,
      text: widgetText(button), checked: Boolean(button.properties?.state_checked), styles: stateStyles(project, button),
    }));
  });
  return { entries, unsupported: [...unsupported].sort() };
}

/** @param {CanvasRenderingContext2D} context @param {number} angle @param {number} radius */
function meterPoint(context, angle, radius) {
  const radians = (angle - 90) * Math.PI / 180;
  const center = 50;
  return { x: center + Math.cos(radians) * radius, y: center + Math.sin(radians) * radius };
}

/** Render LVGL-9 meter/scale semantics into an RGBA asset consumed by lv_image. */
function meterRgba(/** @type {any} */ project, /** @type {any} */ widget,
  /** @type {number} */ width, /** @type {number} */ height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.save(); context.scale(width / 100, height / 100);
  meterScales(widget.properties?.scales).forEach((scale) => {
    const drawTicks = () => meterTickGeometry(scale).forEach((tick) => {
      const style = meterTickStyle(scale, tick.value);
      const color = resolveViewerColor(project, style?.color_start ?? (tick.isMajor ? scale.ticks?.major?.color : scale.ticks?.color)) || "#808080";
      const start = meterPoint(context, tick.angle, tick.inner);
      const end = meterPoint(context, tick.angle, tick.outer);
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y);
      context.strokeStyle = color; context.lineWidth = style?.width ?? tick.width; context.stroke();
    });
    if (scale.draw_ticks_on_top === false) drawTicks();
    (scale.indicators || []).forEach((/** @type {any} */ entry) => {
      if (entry.arc) {
        const config = entry.arc;
        const start = meterValueAngle(scale, config.start_value ?? scale.range_from ?? 0);
        const end = meterValueAngle(scale, config.end_value ?? scale.range_to ?? 100);
        context.beginPath(); context.arc(50, 50, 40 + number(config.padding ?? config.r_mod), (start - 90) * Math.PI / 180, (end - 90) * Math.PI / 180);
        context.strokeStyle = resolveViewerColor(project, config.color) || "#20c7b7";
        context.lineWidth = number(config.width, 4); context.lineCap = config.rounded ? "round" : "butt"; context.stroke();
      } else if (entry.line) {
        const config = entry.line; const geometry = meterLineGeometry(scale, config);
        const start = meterPoint(context, geometry.angle, geometry.start);
        const end = meterPoint(context, geometry.angle, geometry.end);
        context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y);
        context.strokeStyle = resolveViewerColor(project, config.color) || "#ffffff";
        context.lineWidth = number(config.width, 4); context.lineCap = config.rounded ? "round" : "butt"; context.stroke();
      }
    });
    if (scale.draw_ticks_on_top !== false) drawTicks();
  });
  context.restore();
  return context.getImageData(0, 0, width, height);
}

/** @param {string} source @param {number} width @param {number} height */
async function loadImageData(source, width, height) {
  const response = await fetch(source, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("image_canvas_unavailable");
  context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  return context.getImageData(0, 0, width, height);
}

export class LvglWasmRenderer {
  /** @param {HTMLCanvasElement} canvas @param {{onEvent?: (event: any) => void}} [options] */
  constructor(canvas, { onEvent = () => {} } = {}) {
    this.canvas = canvas; this.onEvent = onEvent; this.module = null; this.context = null;
    this.image = null; this.frame = null; this.bound = false; this.handleEntries = new Map();
    /** @type {number[]} */ this.assetTimers = []; this.generation = 0;
    /** @type {WasmMetrics | null} */ this.metrics = null;
  }

  async load() {
    if (this.module) return this.module;
    const started = performance.now();
    const generatedModulePath = "./lvgl-wasm.js";
    const [factoryModule, manifestResponse, wasmResponse] = await Promise.all([
      import(generatedModulePath), fetch(new URL("./build-manifest.json", import.meta.url), { cache: "no-cache" }),
      fetch(new URL("./lvgl-wasm.wasm", import.meta.url), { cache: "no-cache" }),
    ]);
    if (!manifestResponse.ok || !wasmResponse.ok) throw new Error("lvgl_wasm_artifact_missing");
    const manifest = await manifestResponse.json(); const wasmBinary = await wasmResponse.arrayBuffer();
    if (globalThis.crypto?.subtle && manifest.sha256) {
      const digest = await crypto.subtle.digest("SHA-256", wasmBinary);
      const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (actual !== manifest.sha256) throw new Error("lvgl_wasm_integrity_mismatch");
    }
    this.module = await factoryModule.default({
      wasmBinary,
      lvglFlush: (/** @type {number} */ pointer, /** @type {number} */ x1, /** @type {number} */ y1,
        /** @type {number} */ x2, /** @type {number} */ y2) => this.flush(pointer, x1, y1, x2, y2),
      lvglEvent: (/** @type {number} */ handle, /** @type {number} */ kind,
        /** @type {number} */ value, /** @type {string} */ text) => {
        const entry = this.handleEntries.get(handle);
        if (entry) this.onEvent({ id: entry.id, type: entry.type, kind, value, text });
      },
    });
    this.metrics = { startupMs: performance.now() - started, wasmBytes: wasmBinary.byteLength, manifest };
    return this.module;
  }

  flush(/** @type {number} */ pointer, /** @type {number} */ x1, /** @type {number} */ y1,
    /** @type {number} */ x2, /** @type {number} */ y2) {
    if (!this.module || !this.context || !this.image) return;
    const width = x2 - x1 + 1; const height = y2 - y1 + 1;
    const source = new Uint16Array(this.module.HEAPU8.buffer, pointer, width * height); const target = this.image.data;
    for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
      const color = source[row * width + column]; const offset = ((y1 + row) * this.canvas.width + x1 + column) * 4;
      target[offset] = Math.round(((color >> 11) & 0x1f) * 255 / 31);
      target[offset + 1] = Math.round(((color >> 5) & 0x3f) * 255 / 63);
      target[offset + 2] = Math.round((color & 0x1f) * 255 / 31); target[offset + 3] = 255;
    }
    this.context.putImageData(this.image, 0, 0, x1, y1, width, height);
  }

  bindPointer() {
    if (this.bound) return;
    const send = (/** @type {PointerEvent} */ event, /** @type {boolean} */ pressed) => {
      if (!this.module) return; const rect = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(this.canvas.width - 1, Math.round((event.clientX - rect.left) * this.canvas.width / rect.width)));
      const y = Math.max(0, Math.min(this.canvas.height - 1, Math.round((event.clientY - rect.top) * this.canvas.height / rect.height)));
      this.module._lvgl_bridge_pointer(x, y, pressed ? 1 : 0);
      this.module._lvgl_bridge_frame();
    };
    this.canvas.addEventListener("pointerdown", (event) => { this.canvas.setPointerCapture(event.pointerId); send(event, true); });
    this.canvas.addEventListener("pointermove", (event) => { if (event.buttons) send(event, true); });
    this.canvas.addEventListener("pointerup", (event) => send(event, false));
    this.canvas.addEventListener("pointercancel", (event) => send(event, false)); this.bound = true;
  }

  /** @param {any} module @param {number} handle @param {any} entry */
  configure(module, handle, entry) {
    const widget = entry.widget; const props = widget.properties || {}; const type = entry.type;
    const minimum = Math.round(number(props.min_value ?? props.range_from, 0));
    const maximum = Math.round(number(props.max_value ?? props.range_to, 100));
    const value = Math.round(number(props.value ?? props.selected_index, 0));
    if (type === "label") {
      withTwoStrings(module, widgetText(widget), "", (a, b) => module._lvgl_bridge_set_text(handle, a, b));
      const longMode = /** @type {Record<string, number>} */ (LABEL_LONG_MODE)[String(props.long_mode || "WRAP").toUpperCase()] || 0;
      module._lvgl_bridge_configure(handle, 0, 0, 0, props.recolor ? 1 : 0, longMode);
    }
    else if (type === "button") {
      module._lvgl_bridge_configure(handle, 0, 1, props.state_checked ? 1 : 0, 0, props.checkable ? 1 : 0);
      if (widgetText(widget)) withCString(module, widgetText(widget), (text) => module._lvgl_bridge_add_label(handle, text));
    } else if (type === "switch" || type === "checkbox") {
      module._lvgl_bridge_configure(handle, 0, 1, props.state_checked ? 1 : 0, 0, 0);
      if (type === "checkbox") withTwoStrings(module, widgetText(widget), "", (a, b) => module._lvgl_bridge_set_text(handle, a, b));
    } else if (type === "slider") {
      const mode = /** @type {Record<string, number>} */ (SLIDER_MODE)[String(props.mode || "NORMAL").toUpperCase()] || 0;
      module._lvgl_bridge_configure(handle, minimum, maximum, value, 0, mode);
    }
    else if (type === "arc") {
      const angles = (Math.round(number(props.end_angle, 45)) << 16) | (Math.round(number(props.start_angle, 135)) & 0xffff);
      const mode = /** @type {Record<string, number>} */ (ARC_MODE)[String(props.mode || "NORMAL").toUpperCase()] || 0;
      module._lvgl_bridge_configure(handle, minimum, maximum, value, angles, Math.round(number(props.rotation, 0)) | (mode << 16));
    } else if (type === "bar") {
      const mode = /** @type {Record<string, number>} */ (SLIDER_MODE)[String(props.mode || "NORMAL").toUpperCase()] || 0;
      module._lvgl_bridge_configure(handle, minimum, maximum, value, Math.round(number(props.start_value)), (mode << 8) | (mode === 2 ? 1 : 0));
    }
    else if (type === "dropdown" || type === "roller") {
      const options = Array.isArray(props.options) ? props.options.map(String).join("\n") : String(props.options || "");
      withTwoStrings(module, options, type === "roller" ? String(props.mode || "NORMAL") : String(props.symbol || ""), (a, b) => module._lvgl_bridge_set_text(handle, a, b));
      module._lvgl_bridge_configure(handle, 0, 0, value, Math.round(number(props.visible_row_count, 3)), 0);
    } else if (type === "textarea") {
      withTwoStrings(module, String(props.text || ""), String(props.placeholder_text || ""), (a, b) => module._lvgl_bridge_set_text(handle, a, b));
      module._lvgl_bridge_configure(handle, 0, Math.round(number(props.max_length)), 0, 0, (props.one_line ? 1 : 0) | (props.password_mode ? 2 : 0));
    } else if (type === "led") {
      const opacity = viewerOpacity(props.brightness) ?? 1;
      module._lvgl_bridge_configure(handle, 0, 255, Math.round(opacity * 255), wasmColor(entry.project, props.color, "#ff0000"), 0);
    } else if (type === "spinner") module._lvgl_bridge_configure(handle, 0, 0, durationMs(props.spin_time, 2000), Math.round(number(props.arc_length, 200)), 0);
    else if (type === "qrcode") {
      module._lvgl_bridge_configure(handle, 0, 0, Math.round(number(props.size, entry.width)), wasmColor(entry.project, props.dark_color, "#000000"), wasmColor(entry.project, props.light_color, "#ffffff"));
      withTwoStrings(module, widgetText(widget), "", (a, b) => module._lvgl_bridge_set_text(handle, a, b));
    } else if (type === "spinbox") {
      const decimals = Math.max(0, Math.min(6, Math.round(number(props.decimal_places)))); const factor = 10 ** decimals;
      module._lvgl_bridge_configure(handle, Math.round(number(props.range_from) * factor), Math.round(number(props.range_to, 100) * factor), Math.round(number(props.value) * factor), Math.round(number(props.digits, 4)), decimals);
    } else if (type === "tabview" || type === "tileview") {
      (widget.children || []).forEach((/** @type {any} */ child) => withCString(module, String(child.tab_title || child.id || ""), (title) => {
        const direction = /** @type {Record<string, number>} */ (TILE_DIRECTION)[String(child.tile_dir || "ALL").toUpperCase()] || TILE_DIRECTION.ALL;
        module._lvgl_bridge_add_page(handle, title, Math.round(number(child.tile_col)), Math.round(number(child.tile_row)), direction);
      }));
      if (type === "tabview") {
        const position = /** @type {Record<string, number>} */ (TAB_POSITION)[String(props.position || "TOP").toUpperCase()] || TAB_POSITION.TOP;
        const rawSize = String(props.size || "10%"); const size = rawSize.endsWith("%") ? Math.round(entry.height * number(rawSize.slice(0, -1), 10) / 100) : Math.round(number(rawSize, 32));
        module._lvgl_bridge_link(handle, -1, position, size);
        const activeId = entry.runtime?.activeTabs?.[entry.id]; const index = Math.max(0, (widget.children || []).findIndex((/** @type {any} */ child) => child.id === activeId));
        module._lvgl_bridge_select_page(handle, index, 0, 0);
      } else {
        const activeId = entry.runtime?.activeTiles?.[entry.id]; const active = (widget.children || []).find((/** @type {any} */ child) => child.id === activeId) || widget.children?.[0];
        if (active) module._lvgl_bridge_select_page(handle, 0, Math.round(number(active.tile_col)), Math.round(number(active.tile_row)));
      }
    } else if (type === "image" || type === "animimg") {
      module._lvgl_bridge_configure(handle, 0, 0, 0, Math.round(number(props.angle)), Math.round(number(props.zoom, 1) * 256));
    }
  }

  /** @param {any} module @param {number} handle @param {ImageData} image */
  uploadImage(module, handle, image) {
    const pointer = module._malloc(image.data.length);
    try { module.HEAPU8.set(image.data, pointer); return Boolean(module._lvgl_bridge_set_image_rgba(handle, image.width, image.height, pointer)); }
    finally { module._free(pointer); }
  }

  /** @param {any} project @param {any} runtime */
  async render(project, runtime) {
    this.stop(); const generation = ++this.generation; const module = await this.load();
    const width = Math.max(1, Math.round(number(project.canvas?.width, 480))); const height = Math.max(1, Math.round(number(project.canvas?.height, 480)));
    this.canvas.width = width; this.canvas.height = height; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.context = this.canvas.getContext("2d", { alpha: false }); if (!this.context) throw new Error("lvgl_wasm_canvas_unavailable");
    this.image = this.context.createImageData(width, height); if (!module._lvgl_bridge_init(width, height)) throw new Error("lvgl_wasm_init_failed");
    module._lvgl_bridge_reset(wasmColor(project, project.extra_lvgl?.bg_color, "#000000"));
    const scene = projectWasmScene(project, runtime); const handles = new Map();
    /** @type {string[]} */ const assetWarnings = [];
    scene.entries.forEach((entry) => {
      entry.project = project;
      const handle = module._lvgl_bridge_create(/** @type {Record<string, number>} */ (TYPE)[entry.type], -1, entry.x, entry.y, entry.width, entry.height);
      if (handle < 0) return; handles.set(entry.id, handle); this.handleEntries.set(handle, entry);
      Object.entries(entry.styles).forEach(([state, parts]) => PARTS.forEach((part) => {
        const style = parts[part];
        module._lvgl_bridge_set_style(handle, /** @type {Record<string, number>} */ (PART)[part], /** @type {Record<string, number>} */ (STYLE_STATES)[state], style.background, style.foreground, style.border, style.borderWidth, style.radius, style.opacity, style.lineColor, style.lineWidth);
      }));
      module._lvgl_bridge_set_state(handle, entry.widget.properties?.disabled || entry.widget.extra?.disabled ? 1 : 0, entry.widget.properties?.state_checked ? 1 : 0);
      this.configure(module, handle, entry);
    });
    scene.entries.forEach((entry) => {
      if (entry.type !== "keyboard") return; const handle = handles.get(entry.id); const target = handles.get(String(entry.widget.properties?.textarea || ""));
      const mode = /** @type {Record<string, number>} */ (KEYBOARD_MODE)[String(entry.widget.properties?.mode || "TEXT_LOWER")] || 0;
      if (handle !== undefined) module._lvgl_bridge_link(handle, target ?? -1, mode, 0);
    });
    for (const entry of scene.entries) {
      if (generation !== this.generation) break;
      const handle = handles.get(entry.id); if (handle === undefined) continue;
      if (entry.type === "meter") {
        const data = meterRgba(project, entry.widget, entry.width, entry.height); if (data) this.uploadImage(module, handle, data);
      } else if (entry.type === "image" || entry.type === "animimg") {
        const raw = entry.widget.properties?.src; const frames = entry.type === "animimg" && Array.isArray(raw) ? raw : [raw];
        const sources = /** @type {string[]} */ (frames.map((source) => viewerImageSource(project, source)
          || (/^(?:https?:|data:)/i.test(String(source || "")) ? String(source) : null)).filter((source) => typeof source === "string"));
        if (!sources.length) { assetWarnings.push(`${entry.id}: image source unavailable`); continue; }
        let index = 0;
        const show = async () => {
          try { this.uploadImage(module, handle, await loadImageData(sources[index], entry.width, entry.height)); }
          catch (error) { assetWarnings.push(`${entry.id}: ${error instanceof Error ? error.message : error}`); }
          index = (index + 1) % sources.length;
        };
        await show();
        if (sources.length > 1 && entry.widget.properties?.auto_start) this.assetTimers.push(window.setInterval(show, Math.max(50, durationMs(entry.widget.properties?.duration) / sources.length)));
      }
    }
    this.bindPointer(); let frames = 0; let totalFrameMs = 0;
    const tick = () => { const before = performance.now(); module._lvgl_bridge_frame(); totalFrameMs += performance.now() - before; frames += 1;
      if (this.metrics) { this.metrics.objects = module._lvgl_bridge_object_count(); this.metrics.memoryBytes = module.HEAPU8.buffer.byteLength; this.metrics.averageFrameMs = totalFrameMs / frames; this.metrics.unsupported = scene.unsupported; this.metrics.assetWarnings = assetWarnings; }
      this.frame = requestAnimationFrame(tick); };
    tick();
    return { ...this.metrics, unsupported: scene.unsupported, supportedObjects: scene.entries.length, assetWarnings };
  }

  stop() {
    this.generation += 1; if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null;
    this.assetTimers.forEach((timer) => clearInterval(timer)); this.assetTimers = []; this.handleEntries.clear();
  }
}
