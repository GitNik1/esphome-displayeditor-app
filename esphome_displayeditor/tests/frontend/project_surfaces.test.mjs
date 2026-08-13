import assert from "node:assert/strict";
import test from "node:test";

import { freshProject } from "../../frontend/project/model.js";
import {
  resolveActiveSurface,
  surfaceEntries,
  surfaceLayoutProject,
} from "../../frontend/project/surfaces.js";

const translate = (key, values = {}) => key === "surface.page"
  ? `Page ${values.n}: ${values.id}`
  : key === "surface.pageSkippedSuffix" ? " (skip)" : "Root";

test("surface entries follow LVGL paint order", () => {
  const project = freshProject();
  project.bottom_layer = { widgets: [] };
  project.pages = [{ id: "home", skip: true, widgets: [] }];
  project.top_layer = { widgets: [] };
  assert.deepEqual(surfaceEntries(project, translate).map(({ key, label }) => ({ key, label })), [
    { key: "bottom", label: "Bottom-Layer" },
    { key: "page:home", label: "Page 1: home (skip)" },
    { key: "top", label: "Top-Layer" },
  ]);
});

test("invalid active surfaces prefer the first page", () => {
  const project = freshProject();
  project.pages = [{ id: "home", widgets: [] }];
  const resolved = resolveActiveSurface(project, "missing", translate);
  assert.equal(resolved.key, "page:home");
  assert.equal(resolved.entry.surface, project.pages[0]);
});

test("surface layout projects merge local style and layout", () => {
  const project = freshProject();
  project.extra_lvgl = { global: true, bg_color: "old" };
  const surface = {
    widgets: [{ id: "title" }],
    style_tree: { bg_color: "new" },
    layout: { type: "FLEX" },
  };
  const layoutProject = surfaceLayoutProject(project, { kind: "page", surface });
  assert.equal(layoutProject.widgets, surface.widgets);
  assert.deepEqual(layoutProject.extra_lvgl, {
    global: true, bg_color: "new", layout: { type: "FLEX" },
  });
  assert.equal(surfaceLayoutProject(project, { kind: "root" }), project);
});

