import assert from "node:assert/strict";

import {
  applyViewerAction,
  cloneViewerProject,
  effectiveViewerPartStyle,
  effectiveViewerStyle,
} from "../../frontend/viewer/viewer.js";

const project = {
  theme: { switch: { bg_color: "111111", indicator: { bg_color: "222222" } } },
  styles: [{
    id: "shared",
    style_tree: {
      border_width: 2,
      indicator: { bg_color: "333333" },
      states: { checked: { border_color: "AAAAAA", indicator: { bg_color: "444444" } } },
    },
  }],
  widgets: [{
    id: "panel",
    widget_type: "obj",
    hidden: false,
    properties: {},
    children: [
      { id: "title", widget_type: "label", hidden: false, properties: { text: "Alt" }, children: [] },
      { id: "level", widget_type: "slider", hidden: false, properties: { value: 5 }, children: [] },
      {
        id: "toggle",
        widget_type: "switch",
        hidden: false,
        style_mode: "named",
        style_refs: ["shared"],
        style_tree: { bg_color: "555555", indicator: { border_width: 3 } },
        properties: { state_checked: false },
        children: [],
      },
    ],
  }],
};

const clone = cloneViewerProject(project);
clone.widgets[0].hidden = true;
assert.equal(project.widgets[0].hidden, false, "Viewer clone must not mutate the editor project");

const toggle = project.widgets[0].children[2];
assert.deepEqual(effectiveViewerStyle(project, toggle, "checked"), {
  bg_color: "555555",
  border_width: 2,
  border_color: "AAAAAA",
});
assert.deepEqual(effectiveViewerPartStyle(project, toggle, "indicator", "checked"), {
  bg_color: "444444",
  border_width: 3,
});

assert.equal(applyViewerAction(project, { "lvgl.widget.hide": ["panel"] }).changed, true);
assert.equal(project.widgets[0].hidden, true);
assert.equal(applyViewerAction(project, { "lvgl.widget.show": "panel" }).changed, true);
assert.equal(project.widgets[0].hidden, false);

assert.equal(applyViewerAction(project, {
  "lvgl.label.update": { id: "title", text: "Neu" },
}).handled, true);
assert.equal(project.widgets[0].children[0].properties.text, "Neu");

applyViewerAction(project, { "lvgl.slider.update": { id: "level", value: 42 } });
applyViewerAction(project, { "lvgl.switch.update": { id: "toggle", state_checked: true } });
assert.equal(project.widgets[0].children[1].properties.value, 42);
assert.equal(toggle.properties.state_checked, true);

const blocked = applyViewerAction(project, { "homeassistant.service": { service: "light.turn_on" } });
assert.equal(blocked.handled, false);
assert.equal(blocked.changed, false);

const invalidBoolean = applyViewerAction(project, {
  "lvgl.switch.update": { id: "toggle", state_checked: "false" },
});
assert.equal(invalidBoolean.changed, false);
assert.equal(toggle.properties.state_checked, true);
