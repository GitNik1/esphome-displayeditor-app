import assert from "node:assert/strict";
import test from "node:test";

import {
  WASM_SUPPORTED_WIDGETS,
  projectWasmScene,
  wasmColor,
} from "../../frontend/viewer-wasm/adapter.js";

test("WASM scene uses shared layout and reports unsupported widgets", () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 40 }) }) }) };
  const project = {
    canvas: { width: 320, height: 240 }, extra_lvgl: {}, theme: {}, styles: [], colors: [],
    widgets: [
      { id: "title", widget_type: "label", x: 12, y: 10, width: 100, height: 20, properties: { text: "Status" }, children: [] },
      { id: "toggle", widget_type: "switch", x: 20, y: 50, width: 50, height: 24, properties: { state_checked: true }, children: [] },
      { id: "meter", widget_type: "meter", x: 100, y: 40, width: 80, height: 80, properties: {}, children: [] },
    ], pages: [], top_layer: null, bottom_layer: null,
  };
  const scene = projectWasmScene(project);
  assert.deepEqual(scene.unsupported, []);
  assert.equal(scene.entries.length, 3);
  assert.equal(scene.entries[0].text, "Status");
  assert.equal(scene.entries[0].x, 12);
  assert.equal(scene.entries[1].checked, true);
});

test("WASM color adapter resolves project colors and rejects CSS expressions", () => {
  const project = { colors: [{ id: "accent", hex: "12ABEF" }] };
  assert.equal(wasmColor(project, "accent", "#000000"), 0x12abef);
  assert.equal(wasmColor(project, "url(javascript:bad)", "#102030"), 0x102030);
  assert.equal(WASM_SUPPORTED_WIDGETS.has("slider"), true);
  assert.equal(WASM_SUPPORTED_WIDGETS.has("image"), true);
});

test("WASM renderer covers every real widget modeled by the HTML viewer", () => {
  assert.deepEqual([...WASM_SUPPORTED_WIDGETS].sort(), [
    "animimg", "arc", "bar", "button", "checkbox", "container", "dropdown", "image",
    "keyboard", "label", "led", "meter", "obj", "qrcode", "roller", "slider",
    "spinbox", "spinner", "switch", "tabview", "textarea", "tileview",
  ]);
});
