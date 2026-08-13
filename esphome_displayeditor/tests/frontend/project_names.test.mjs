import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProjectName } from "../../frontend/project/names.js";

test("project names replace unsafe characters and source extensions", () => {
  assert.equal(normalizeProjectName(" Küchen panel.yaml "), "K-chen-panel.lvgldesign");
  assert.equal(normalizeProjectName("display.LVGLDESIGN"), "display.lvgldesign");
});

test("project names cannot become hidden or empty", () => {
  assert.equal(normalizeProjectName("...."), "display.lvgldesign");
  assert.equal(normalizeProjectName(""), "display.lvgldesign");
});

test("project names stay inside the backend filename limit", () => {
  const normalized = normalizeProjectName("x".repeat(500));
  assert.equal(normalized.length, 127);
  assert.match(normalized, /^x+\.lvgldesign$/);
});

