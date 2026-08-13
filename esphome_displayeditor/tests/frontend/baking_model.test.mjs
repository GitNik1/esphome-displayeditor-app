import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureImageEntry,
  newAnimimgWidget,
  newImageWidget,
  slugifyStrokeName,
  strokeBaseName,
  strokeRenderBounds,
  removeBakedWidget,
  upsertBakedWidget,
} from "../../frontend/glowline/baking-model.js";
import { freshProject } from "../../frontend/project/model.js";

globalThis.Path2D ??= class Path2D {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  closePath() {}
};

test("stroke names produce stable ESPHome ids", () => {
  assert.equal(slugifyStrokeName("  Küchen-Fluß 1 ", "fallback"), "kuechen_fluss_1");
  assert.equal(slugifyStrokeName("---", "line_4"), "line_4");
  assert.equal(strokeBaseName({ id: "line_2", name: "Solar → Haus" }), "solar_haus");
});

test("stroke bounds include glow margin and remain inside the canvas", () => {
  const bounds = strokeRenderBounds({
    points: [[5, 5], [95, 5]],
    mode: "polyline",
    closed: false,
    corner_radius: 0,
    width: 6,
    glow: { enabled: true, radius: 10 },
  }, { width: 100, height: 50 });
  assert.deepEqual(bounds, { left: 0, top: 0, right: 100, bottom: 20 });
});

test("empty strokes use the complete canvas", () => {
  assert.deepEqual(strokeRenderBounds({
    points: [], width: 5, glow: { enabled: false },
  }, { width: 480, height: 320 }), { left: 0, top: 0, right: 480, bottom: 320 });
});

test("baked image widgets preserve transparent RGB565 defaults", () => {
  const widget = newImageWidget("flow", { left: 1.4, top: 2.6, right: 31.2, bottom: 42.8 }, "flow_image");
  assert.equal(widget.widget_type, "image");
  assert.deepEqual(widget.properties, { src: "flow_image", angle: 0, zoom: 1 });
  assert.deepEqual([widget.x, widget.y, widget.width, widget.height], [1, 3, 30, 40]);
});

test("animated widgets replace image properties with frame settings", () => {
  const widget = newAnimimgWidget("flow_anim", { left: 0, top: 0, right: 20, bottom: 10 }, ["a", "b"], 600);
  assert.equal(widget.widget_type, "animimg");
  assert.deepEqual(widget.properties, {
    src: ["a", "b"], duration: 600, repeat_count: "forever", auto_start: true,
  });
});

test("image entries are idempotent and retain transparent RGB565 settings", () => {
  const project = freshProject();
  const first = ensureImageEntry(project, "img_flow", "images/old.png");
  const second = ensureImageEntry(project, "img_flow", "images/new.png");
  assert.equal(first, second);
  assert.equal(project.images.length, 1);
  assert.equal(second.file_path, "images/new.png");
  assert.equal(second.transparency, "alpha_channel");
  assert.equal(second.img_type, "RGB565");
});

test("baked widget upserts preserve children and reject unsafe ids", () => {
  const project = freshProject();
  const original = newImageWidget("flow", { left: 0, top: 0, right: 10, bottom: 10 }, "old");
  original.children = [{ id: "child" }];
  project.widgets.push(original);
  const updated = newImageWidget("flow", { left: 5, top: 5, right: 25, bottom: 15 }, "new");
  assert.equal(upsertBakedWidget(project, "flow", updated, null), original);
  assert.deepEqual(original.children, [{ id: "child" }]);
  assert.equal(original.properties.src, "new");

  assert.throws(() => upsertBakedWidget(
    project,
    "flow",
    newAnimimgWidget("flow", { left: 0, top: 0, right: 1, bottom: 1 }, [], 100),
    null,
  ), /collision/);
  project.reserved_ids = ["reserved"];
  assert.throws(() => upsertBakedWidget(
    project,
    "reserved",
    newImageWidget("reserved", { left: 0, top: 0, right: 1, bottom: 1 }, "image"),
    null,
  ), /Reserved/);
});

test("obsolete baked widgets are removed from their actual container", () => {
  const project = freshProject();
  const container = { id: "container", widget_type: "obj", children: [{ id: "flow_anim" }] };
  project.widgets.push(container);
  assert.equal(removeBakedWidget(project, "flow_anim", container), true);
  assert.deepEqual(container.children, []);
  assert.equal(removeBakedWidget(project, "missing", container), false);
});
