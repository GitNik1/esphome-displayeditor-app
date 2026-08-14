// @ts-check

import { LvglWasmRenderer } from "./adapter.js";

const pixel = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%232563eb'/%3E%3Ccircle cx='16' cy='16' r='10' fill='%23f8fafc'/%3E%3C/svg%3E";
/** @param {string} id @param {string} type @param {number} x @param {number} y
 * @param {number} width @param {number} height @param {Record<string, any>} [properties]
 * @param {Record<string, any>} [extra] */
const widget = (id, type, x, y, width, height, properties = {}, extra = {}) => ({
  id, widget_type: type, x, y, width, height, properties, style_tree: {}, children: [], ...extra,
});
const project = {
  canvas: { width: 800, height: 600 }, colors: [], styles: [], theme: {}, extra_lvgl: { bg_color: "101820" },
  pages: [], top_layer: null, bottom_layer: null,
  widgets: [
    widget("panel", "obj", 8, 8, 784, 584),
    widget("title", "label", 20, 18, 210, 28, { text: "Complete LVGL 9 Viewer" }),
    widget("action", "button", 20, 58, 120, 42, { text: "Touch", checkable: true }),
    widget("enabled", "switch", 160, 65, 54, 28, { state_checked: true }),
    widget("check", "checkbox", 235, 65, 130, 28, { text: "Enabled", state_checked: true }),
    widget("level", "slider", 390, 68, 170, 22, { min_value: 0, max_value: 100, value: 68 }),
    widget("load", "bar", 590, 68, 170, 22, { min_value: 0, max_value: 100, value: 45 }),
    widget("dial", "arc", 20, 125, 100, 100, { min_value: 0, max_value: 100, value: 62, start_angle: 135, end_angle: 45, adjustable: true }),
    widget("choices", "dropdown", 145, 130, 135, 40, { options: ["Alpha", "Beta", "Gamma"], selected_index: 1 }),
    widget("wheel", "roller", 300, 120, 120, 100, { options: ["One", "Two", "Three"], selected_index: 1, visible_row_count: 3 }),
    widget("input", "textarea", 445, 125, 155, 55, { text: "Hello", placeholder_text: "Text" }),
    widget("keys", "keyboard", 615, 115, 165, 115, { textarea: "input", mode: "TEXT_LOWER" }),
    widget("status", "led", 25, 255, 42, 42, { color: "00FF66", brightness: "80%" }),
    widget("busy", "spinner", 90, 250, 55, 55, { arc_color: "20C7B7", arc_length: 200, spin_time: "1s" }),
    widget("qr", "qrcode", 170, 245, 80, 80, { text: "ESPHome", size: 80, dark_color: "000000", light_color: "FFFFFF" }),
    widget("number", "spinbox", 275, 255, 120, 42, { value: 12.5, range_from: 0, range_to: 100, digits: 4, decimal_places: 1 }),
    widget("picture", "image", 420, 245, 70, 70, { src: pixel }),
    widget("animation", "animimg", 515, 245, 70, 70, { src: [pixel, pixel], auto_start: true, duration: 500 }),
    widget("meter", "meter", 610, 245, 140, 140, { scales: [{ range_from: 0, range_to: 100, angle_range: 240, rotation: 150, ticks: { count: 11, width: 2, length: 8, color: "94A3B8", major: { stride: 5, width: 3, length: 12, color: "FFFFFF" } }, indicators: [{ line: { value: 65, width: 4, color: "EF4444" } }, { arc: { start_value: 20, end_value: 80, width: 4, color: "22C55E" } }] }] }),
    widget("tiles", "tileview", 20, 355, 220, 210, {}, { children: [{ id: "tile_a", widget_type: "tile", tile_col: 0, tile_row: 0, tile_dir: "ALL", children: [widget("tile_label", "label", 15, 15, 100, 24, { text: "Tile A" })] }] }),
    widget("tabs", "tabview", 270, 355, 300, 210, { position: "TOP", size: "15%" }, { children: [{ id: "tab_a", widget_type: "tab", tab_title: "First", children: [widget("tab_label", "label", 20, 55, 120, 24, { text: "Tab content" })] }, { id: "tab_b", widget_type: "tab", tab_title: "Second", children: [] }] }),
  ],
};

const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("#display"));
const output = document.querySelector("#metrics");
/** @type {any[]} */ const events = [];
const renderer = new LvglWasmRenderer(canvas, { onEvent: (event) => events.push(event) });
try {
  const metrics = await renderer.render(project, { activePageId: "", activeTiles: {}, activeTabs: {} });
  if (output) output.textContent = JSON.stringify(metrics, null, 2);
  /** @type {any} */ (window).__lvglWasmAcceptance = { ready: true, metrics, renderer, events };
} catch (error) {
  if (output) output.textContent = String(error instanceof Error ? error.stack : error);
  /** @type {any} */ (window).__lvglWasmAcceptance = { ready: false, error: String(error) };
}
