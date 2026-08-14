import assert from "node:assert/strict";
import test from "node:test";

globalThis.Path2D ??= class Path2D {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  closePath() {}
};

import { bakeGlowStroke } from "../../frontend/glowline/bake.js";
import { freshGlowStroke, freshProject } from "../../frontend/project/model.js";

test("bakes static and bidirectional frames with deterministic ids", async () => {
  const project = freshProject();
  const stroke = freshGlowStroke("line_1");
  stroke.name = "Power Flow";
  stroke.points = [[10, 10], [100, 10]];
  stroke.flow.enabled = true;
  stroke.flow.bidirectional = true;
  stroke.flow.bake_frame_count = 2;
  const rendered = [];
  const uploaded = [];
  const result = await bakeGlowStroke({
    project,
    stroke,
    renderFrame: async (document, rect, options) => {
      rendered.push({ document, rect, options });
      return { frame: rendered.length };
    },
    uploadFrame: async (name, blob) => {
      uploaded.push({ name, blob });
      return `images/${name}`;
    },
    contentOrigin: () => ({ x: 0, y: 0 }),
  });
  assert.deepEqual(result, {
    baseName: "power_flow",
    forwardId: "power_flow_anim",
    reverseId: "power_flow_anim_rev",
  });
  assert.deepEqual(uploaded.map(({ name }) => name), [
    "power_flow_static.png",
    "power_flow_flow_00.png",
    "power_flow_flow_01.png",
    "power_flow_flow_rev_00.png",
    "power_flow_flow_rev_01.png",
  ]);
  assert.equal(rendered.length, 5);
  assert.equal(project.images.length, 5);
  assert.deepEqual(project.widgets.map(({ id }) => id), [
    "power_flow", "power_flow_anim", "power_flow_anim_rev",
  ]);
  assert.equal(rendered[3].document.strokes[0].flow.reversed, !stroke.flow.reversed);
  assert.equal(stroke.flow.reversed, false);
});

test("rebaking refreshes glow flow binding target ids after a line rename", async () => {
  const project = freshProject();
  const stroke = freshGlowStroke("line_1");
  stroke.name = "Solar Flow";
  stroke.points = [[0, 0], [40, 0]];
  stroke.flow.enabled = true;
  stroke.flow.bidirectional = true;
  stroke.flow.bake_frame_count = 1;
  project.bindings = [{
    id: "solar_flow",
    target: {
      glow_stroke_id: "line_1",
      widget_id: "old_anim",
      reverse_widget_id: "old_anim_rev",
      property: "flow_direction",
    },
  }];

  await bakeGlowStroke({
    project,
    stroke,
    renderFrame: async () => ({}),
    uploadFrame: async (name) => `images/${name}`,
    contentOrigin: () => ({ x: 0, y: 0 }),
  });

  assert.equal(project.bindings[0].target.widget_id, "solar_flow_anim");
  assert.equal(project.bindings[0].target.reverse_widget_id, "solar_flow_anim_rev");
});

test("rebaking disabled flow removes obsolete animations", async () => {
  const project = freshProject();
  const stroke = freshGlowStroke("line_1");
  stroke.points = [[0, 0], [20, 0]];
  project.widgets.push(
    { id: "line_1_anim", widget_type: "animimg", children: [] },
    { id: "line_1_anim_rev", widget_type: "animimg", children: [] },
  );
  const result = await bakeGlowStroke({
    project,
    stroke,
    renderFrame: async () => ({}),
    uploadFrame: async (name) => `images/${name}`,
    contentOrigin: () => ({ x: 0, y: 0 }),
  });
  assert.deepEqual(result, { baseName: "line_1", forwardId: null, reverseId: null });
  assert.deepEqual(project.widgets.map(({ id }) => id), ["line_1"]);
});

test("baked child widgets are positioned relative to their parent", async () => {
  const project = freshProject();
  const parent = { id: "panel", widget_type: "obj", children: [] };
  project.widgets.push(parent);
  const stroke = freshGlowStroke("line_1");
  stroke.parent_id = "panel";
  stroke.points = [[20, 30], [40, 30]];
  await bakeGlowStroke({
    project,
    stroke,
    renderFrame: async () => ({}),
    uploadFrame: async (name) => `images/${name}`,
    contentOrigin: () => ({ x: 10, y: 15 }),
  });
  assert.equal(parent.children.length, 1);
  assert.ok(parent.children[0].x < 20);
  assert.ok(parent.children[0].y < 30);
});
