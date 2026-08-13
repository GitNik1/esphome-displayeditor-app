import assert from "node:assert/strict";
import test from "node:test";

import {
  colorReferenceLocations,
  normalizeLibraryHex,
  projectIdIsUsed,
} from "../../frontend/project/colors.js";
import { freshProject } from "../../frontend/project/model.js";

test("library colors normalize short and long RGB values", () => {
  assert.equal(normalizeLibraryHex("#abc"), "AABBCC");
  assert.equal(normalizeLibraryHex("0x00ffaa"), "00FFAA");
  assert.equal(normalizeLibraryHex("red"), null);
});

test("color references are found and optionally replaced outside the library", () => {
  const project = freshProject();
  project.colors = [{ id: "accent", hex: "00FF00" }];
  project.widgets = [{
    id: "button",
    style_tree: { bg_color: "accent", states: { pressed: { border_color: "accent" } } },
    properties: { text: "accent" },
  }];
  assert.deepEqual(colorReferenceLocations(project, "accent"), [
    "widgets.0.style_tree.bg_color",
    "widgets.0.style_tree.states.pressed.border_color",
  ]);
  colorReferenceLocations(project, "accent", "00FF00");
  assert.equal(project.widgets[0].style_tree.bg_color, "00FF00");
  assert.equal(project.widgets[0].properties.text, "accent");
  assert.equal(project.colors[0].id, "accent");
});

test("project ids share one namespace across widgets and libraries", () => {
  const project = freshProject();
  project.widgets = [{ id: "widget" }];
  project.pages = [{ id: "page", widgets: [] }];
  project.fonts = [{ id: "font" }];
  project.reserved_ids = ["hardware"];
  project.colors = [{ id: "accent" }];
  for (const id of ["widget", "page", "font", "hardware", "accent"]) {
    assert.equal(projectIdIsUsed(project, id), true);
  }
  assert.equal(projectIdIsUsed(project, "accent", "accent"), false);
  assert.equal(projectIdIsUsed(project, "free"), false);
});

