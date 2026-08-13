import assert from "node:assert/strict";
import test from "node:test";

import { freshProject } from "../../frontend/project/model.js";
import {
  cloneWidgetSubtree,
  findParentContainerId,
  findWidgetLocation,
  removeWidget,
  replaceActionTargetReference,
  replaceProjectWidgetReferences,
} from "../../frontend/project/widgets.js";

test("action target replacement traverses nested conditions and payload shapes", () => {
  const action = { if: {
    condition: { lambda: "return x;" },
    then: [{ "lvgl.widget.show": ["old", "other"] }],
    else: [{ "lvgl.label.update": { id: "old", text: "Ready" } }],
  } };
  replaceActionTargetReference(action, "old", "new");
  assert.deepEqual(action.if.then[0]["lvgl.widget.show"], ["new", "other"]);
  assert.equal(action.if.else[0]["lvgl.label.update"].id, "new");
});

test("project reference replacement covers alignments, lines and bindings", () => {
  const project = freshProject();
  project.widgets = [{
    id: "source",
    align_to: "old",
    events: { on_click: [{ "lvgl.widget.hide": "old" }] },
  }];
  project.glow_strokes = [{ parent_id: "old" }];
  const bindings = [{ widget_id: "old", target: "text" }];
  replaceProjectWidgetReferences(project, bindings, "old", "new");
  assert.equal(project.widgets[0].align_to, "new");
  assert.equal(project.widgets[0].events.on_click[0]["lvgl.widget.hide"], "new");
  assert.equal(project.glow_strokes[0].parent_id, "new");
  assert.equal(bindings[0].widget_id, "new");
});

test("widget tree location, parent lookup and removal use live arrays", () => {
  const child = { id: "child", children: [] };
  const parent = { id: "parent", children: [child] };
  const roots = [parent];
  assert.equal(findWidgetLocation(roots, child).array, parent.children);
  assert.equal(findParentContainerId(roots, child), "parent");
  assert.equal(removeWidget(roots, child), true);
  assert.deepEqual(parent.children, []);
  assert.equal(removeWidget(roots, child), false);
});

test("subtree cloning assigns unique ids to every descendant", () => {
  const project = freshProject();
  project.widgets = [{ id: "obj_1", widget_type: "obj", children: [] }];
  project.reserved_ids = ["label_1"];
  const clone = cloneWidgetSubtree(project, {
    id: "source",
    widget_type: "obj",
    children: [{ id: "title", widget_type: "label", children: [] }],
  });
  assert.equal(clone.id, "obj_2");
  assert.equal(clone.children[0].id, "label_2");
});

