import assert from "node:assert/strict";
import test from "node:test";

import { buildImportPayload, summarizeImport } from "../../frontend/project/import.js";

test("import payload selects configuration or pasted content and clamps canvas", () => {
  assert.deepEqual(buildImportPayload({ configuration: "panel.yaml", content: "ignored" }, 0, 9000), {
    configuration: "panel.yaml",
    canvas: { width: 1, height: 4096 },
  });
  assert.deepEqual(buildImportPayload({ configuration: null, content: "lvgl: {}" }, 480, 320), {
    content: "lvgl: {}",
    canvas: { width: 480, height: 320 },
  });
});

test("import summaries separate information from warnings", () => {
  const translate = (key, values = {}) => `${key}:${JSON.stringify(values)}`;
  const summary = summarizeImport({
    widget_types: { label: 2, button: 1 },
    widget_count: 3,
    canvas: { width: 480, height: 320, source: "display_dimensions" },
    images: 1,
    fonts: 0,
    styles: 2,
    unsupported_types: ["calendar"],
    preserved_keys: ["on_idle"],
    issues: { A: 1, B: 2 },
  }, translate);
  assert.equal(summary.lines.length, 3);
  assert.match(summary.lines[0], /2× label, 1× button/);
  assert.equal(summary.warnings.length, 3);
  assert.equal(summary.warnings[2].severe, true);
});

