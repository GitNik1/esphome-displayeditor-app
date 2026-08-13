import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProjectWidgets,
  freshGlowStroke,
  freshProject,
  normalizeProjectSurfaces,
  projectWidgetEntries,
  uniqueProjectWidgetId,
} from "../../frontend/project/model.js";

test("fresh projects do not share mutable collections", () => {
  const first = freshProject();
  const second = freshProject();
  first.widgets.push({ id: "one" });
  assert.deepEqual(second.widgets, []);
  assert.equal(first.format_version, 3);
});

test("surface normalization repairs imported optional structures", () => {
  const project = {
    widgets: null,
    pages: [{ widgets: null, layout: [], style_tree: null, extra: "invalid" }],
    page_wrap: "yes",
    msgboxes: [{ buttons: null, body: null }],
  };
  normalizeProjectSurfaces(project);
  assert.deepEqual(project.widgets, []);
  assert.equal(project.page_wrap, true);
  assert.deepEqual(project.pages[0].layout, {});
  assert.deepEqual(project.msgboxes[0].buttons, []);
  assert.equal(project.msgboxes[0].body.text, "");
  assert.equal(project.msgboxes[0].close_button, true);
});

test("widget collection spans every project surface", () => {
  const project = freshProject();
  project.widgets = [{ id: "root", children: [{ id: "child" }] }];
  project.pages = [{ widgets: [{ id: "page" }] }];
  project.top_layer = { widgets: [{ id: "top" }] };
  project.bottom_layer = { widgets: [{ id: "bottom" }] };
  project.msgboxes = [{ buttons: [{ id: "dialog" }], header_buttons: [{ id: "close" }] }];
  assert.deepEqual(
    collectProjectWidgets(project).map((widget) => widget.id),
    ["root", "child", "page", "bottom", "top", "dialog", "close"],
  );
});

test("generated widget ids avoid modeled and reserved ids", () => {
  const project = freshProject();
  project.widgets = [{ id: "button_1" }];
  project.reserved_ids = ["button_2"];
  assert.equal(uniqueProjectWidgetId(project, "button"), "button_3");
});

test("action target entries include message boxes as pseudo widgets", () => {
  const project = freshProject();
  project.msgboxes = [{
    id: "confirm",
    buttons: [{ id: "yes" }],
    header_buttons: [{ id: "close" }],
  }];
  assert.deepEqual(projectWidgetEntries(project).map(({ id, widget_type }) => ({ id, widget_type })), [
    { id: "confirm", widget_type: "msgbox" },
    { id: "yes", widget_type: undefined },
    { id: "close", widget_type: undefined },
  ]);
});

test("fresh glow strokes contain independent nested defaults", () => {
  const first = freshGlowStroke("line_1");
  const second = freshGlowStroke("line_2");
  first.flow.enabled = true;
  assert.equal(second.flow.enabled, false);
  assert.equal(second.id, "line_2");
});
