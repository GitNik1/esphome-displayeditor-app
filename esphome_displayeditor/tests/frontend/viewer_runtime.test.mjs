import assert from "node:assert/strict";

import {
  applyRuntimeBinding,
  applyViewerAction,
  cloneViewerProject,
  describeViewerArc,
  effectiveViewerPartStyle,
  effectiveViewerStyle,
  entityMatchesRuntimeTarget,
  formatRuntimeValue,
  resolveViewerColor,
  runtimeBindingHealth,
  viewerBarGeometry,
  viewerGradientBackground,
  viewerTextAlign,
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

assert.equal(viewerTextAlign("LEFT"), "left");
assert.equal(viewerTextAlign("CENTER"), "center");
assert.equal(viewerTextAlign("RIGHT"), "right");
assert.equal(viewerTextAlign("AUTO"), "start");
assert.equal(viewerTextAlign(""), "");
assert.equal(
  viewerGradientBackground(
    { colors: [{ id: "gradient_end", hex: "0080FF" }] },
    { bg_color: "102030", bg_grad_color: "gradient_end", bg_grad_dir: "HOR" },
  ),
  "linear-gradient(to right, #102030, #0080FF)",
);
assert.equal(
  viewerGradientBackground({}, {
    bg_color: "000000", bg_grad_color: "FFFFFF", bg_grad_dir: "VER", bg_opa: "50%",
  }),
  "linear-gradient(to bottom, rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.5))",
);
assert.equal(
  viewerGradientBackground({}, { bg_color: "000000", bg_grad_color: "FFFFFF", bg_grad_dir: "NONE" }),
  "",
);

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

const colorButtonProject = {
  theme: {}, styles: [],
  widgets: [{
    id: "color_button", widget_type: "button",
    properties: { text: "Aktivieren", checkable: true },
    style_tree: {
      bg_color: "404040", text_color: "FFFFFF",
      states: {
        pressed: { bg_color: "0080FF" },
        checked: { bg_color: "00A000", text_color: "FFFFFF" },
      },
    },
    children: [],
  }],
};
const colorButton = colorButtonProject.widgets[0];
colorButtonProject.colors = [{ id: "status_green", hex: "00FF00" }];
assert.equal(resolveViewerColor(colorButtonProject, "status_green"), "#00FF00");
assert.deepEqual(effectiveViewerStyle(colorButtonProject, colorButton), {
  bg_color: "404040", text_color: "FFFFFF",
});
assert.deepEqual(effectiveViewerStyle(colorButtonProject, colorButton, "pressed"), {
  bg_color: "0080FF", text_color: "FFFFFF",
});
assert.deepEqual(effectiveViewerStyle(colorButtonProject, colorButton, "checked"), {
  bg_color: "00A000", text_color: "FFFFFF",
});

const imageButtonProject = {
  images: [
    { id: "button_normal", file_path: "normal.png" },
    { id: "button_pressed", file_path: "pressed.png" },
  ],
  widgets: [{
    id: "image_button", widget_type: "button", properties: { checkable: false },
    children: [{
      id: "image_button_image", widget_type: "image",
      properties: { src: "button_normal" }, children: [],
    }],
  }],
};
assert.equal(applyViewerAction(imageButtonProject, {
  "lvgl.image.update": { id: "image_button_image", src: "button_pressed" },
}).changed, true);
assert.equal(imageButtonProject.widgets[0].children[0].properties.src, "button_pressed");
const wrongImageUpdate = applyViewerAction(imageButtonProject, {
  "lvgl.image.update": { id: "image_button", src: "button_normal" },
});
assert.equal(wrongImageUpdate.changed, false);
assert.equal(wrongImageUpdate.warning, true);

assert.equal(applyViewerAction(project, { "lvgl.widget.hide": ["panel"] }).changed, true);
assert.equal(project.widgets[0].hidden, true);
assert.equal(applyViewerAction(project, { "lvgl.widget.show": "panel" }).changed, true);
assert.equal(project.widgets[0].hidden, false);

assert.equal(applyViewerAction(project, {
  "lvgl.label.update": { id: "title", text: "Neu" },
}).handled, true);
assert.equal(project.widgets[0].children[0].properties.text, "Neu");

assert.equal(applyViewerAction(project, {
  "lvgl.label.update": {
    id: "title", text: "Aktiv", text_color: "0x00FF00", bg_color: "0x102010",
  },
}).changed, true);
assert.equal(project.widgets[0].children[0].properties.text, "Aktiv");
assert.equal(project.widgets[0].children[0].style_tree.text_color, "0x00FF00");
assert.equal(project.widgets[0].children[0].style_tree.bg_color, "0x102010");

const conditionalOff = applyViewerAction(project, {
  if: {
    condition: { lambda: "return x;" },
    then: [{ "lvgl.label.update": { id: "title", text_color: "0xFFFFFF" } }],
  },
}, {}, { x: false });
assert.equal(conditionalOff.changed, false);
assert.equal(project.widgets[0].children[0].style_tree.text_color, "0x00FF00");
const conditionalOn = applyViewerAction(project, {
  if: {
    condition: { lambda: "return x;" },
    then: [{ "lvgl.label.update": { id: "title", text_color: "0xFFFFFF" } }],
  },
}, {}, { x: true });
assert.equal(conditionalOn.changed, true);
assert.equal(project.widgets[0].children[0].style_tree.text_color, "0xFFFFFF");

assert.equal(applyViewerAction(colorButtonProject, {
  "lvgl.button.update": { id: "color_button", text: "Ein", bg_color: "0x008000" },
}).changed, true);
assert.equal(colorButton.properties.text, "Ein");
assert.equal(colorButton.style_tree.bg_color, "0x008000");

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

const pageProject = {
  pages: [
    { id: "main", skip: false, widgets: [] },
    { id: "service", skip: true, widgets: [] },
    { id: "settings", skip: false, widgets: [] },
  ],
  page_wrap: false,
  widgets: [],
};
const runtime = { activePageId: "main" };
assert.equal(applyViewerAction(pageProject, { "lvgl.page.next": {} }, runtime).changed, true);
assert.equal(runtime.activePageId, "settings", "next must skip pages marked with skip");
assert.equal(applyViewerAction(pageProject, { "lvgl.page.next": {} }, runtime).warning, true);
assert.equal(runtime.activePageId, "settings", "page_wrap=false must stop at the final page");
assert.equal(applyViewerAction(pageProject, { "lvgl.page.previous": {} }, runtime).changed, true);
assert.equal(runtime.activePageId, "main");
assert.equal(applyViewerAction(pageProject, { "lvgl.page.show": "service" }, runtime).changed, true);
assert.equal(runtime.activePageId, "service", "page.show may open a skipped page directly");

assert.equal(formatRuntimeValue(21.56, "{state:.1f} °C"), "21.6 °C");
const liveSource = {
  widgets: [
    { id: "temperature", widget_type: "label", properties: { text: "Original" }, children: [] },
    { id: "level_live", widget_type: "slider", properties: { value: 5 }, children: [] },
    { id: "switch_live", widget_type: "switch", properties: { state_checked: false }, children: [] },
    { id: "bar_live", widget_type: "bar", properties: { value: 5, min_value: 0, max_value: 100 }, children: [] },
    { id: "arc_live", widget_type: "arc", properties: { value: 5, min_value: 0, max_value: 100 }, children: [] },
  ],
};
const liveProject = cloneViewerProject(liveSource);
const receivedAt = new Date().toISOString();
assert.equal(applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "temperature", target: "text", value_format: "{state:.1f} °C", fallback: "--.- °C",
}, { state: 21.56, available: true, received_at: receivedAt }), true);
assert.equal(liveProject.widgets[0].properties.text, "21.6 °C");
assert.equal(applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "temperature", target: "text", fallback: "offline", stale_after: 1,
}, { state: 21.56, available: true, received_at: "2020-01-01T00:00:00Z" }), true);
assert.equal(liveProject.widgets[0].properties.text, "offline");
applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "level_live", target: "value",
}, { state: "42.5", available: true, received_at: receivedAt });
assert.equal(liveProject.widgets[1].properties.value, 42.5);
applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "switch_live", target: "state_checked",
}, { state: "ON", available: true, received_at: receivedAt });
assert.equal(liveProject.widgets[2].properties.state_checked, true);
applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "bar_live", target: "value",
}, { state: "72", available: true, received_at: receivedAt });
applyRuntimeBinding(liveProject, liveSource, {
  widget_id: "arc_live", target: "value",
}, { state: "33", available: true, received_at: receivedAt });
assert.equal(liveProject.widgets[3].properties.value, 72);
assert.equal(liveProject.widgets[4].properties.value, 33);

assert.equal(applyViewerAction(liveProject, {
  "lvgl.bar.update": { id: "bar_live", value: 81, mode: "RANGE", start_value: 15 },
}).changed, true);
assert.equal(liveProject.widgets[3].properties.value, 81);
assert.equal(liveProject.widgets[3].properties.start_value, 15);
assert.equal(applyViewerAction(liveProject, {
  "lvgl.arc.update": { id: "arc_live", value: 44, adjustable: true, start_angle: 120 },
}).changed, true);
assert.equal(liveProject.widgets[4].properties.adjustable, true);
const wrongWidgetUpdate = applyViewerAction(liveProject, {
  "lvgl.arc.update": { id: "bar_live", value: 10 },
});
assert.equal(wrongWidgetUpdate.changed, false);
assert.equal(wrongWidgetUpdate.warning, true);
assert.match(describeViewerArc(135, 270), /^M [\d.]+ [\d.]+ A 40 40 0 1 1 [\d.]+ [\d.]+$/);
assert.equal(describeViewerArc(Number.NaN, Number.POSITIVE_INFINITY).includes("NaN"), false);
assert.deepEqual(viewerBarGeometry({
  width: 200, height: 20,
  properties: { min_value: 0, max_value: 100, mode: "RANGE", start_value: 20, value: 75 },
}), { lower: 0.2, upper: 0.75, vertical: false, percentage: 0.75 });
assert.deepEqual(viewerBarGeometry({
  width: 20, height: 200,
  properties: { min_value: -100, max_value: 100, mode: "SYMMETRICAL", value: -25 },
}), { lower: 0.375, upper: 0.5, vertical: true, percentage: 0.375 });

assert.equal(entityMatchesRuntimeTarget({ type: "sensor" }, "value"), true);
assert.equal(entityMatchesRuntimeTarget({ type: "binary_sensor" }, "value", { state: "ON" }), false);
assert.equal(entityMatchesRuntimeTarget({ type: "binary_sensor" }, "state_checked"), true);
assert.equal(entityMatchesRuntimeTarget({ type: "lock" }, "state_checked", { state: "LOCKED" }), true);
assert.equal(entityMatchesRuntimeTarget({ type: "text_sensor" }, "state_checked", { state: "maybe" }), false);
assert.equal(entityMatchesRuntimeTarget({ type: "text_sensor" }, "text"), true);

const runtimeSnapshot = {
  devices: [{
    id: "display-1",
    status: "ready",
    states: [{ entity_id: "sensor:temperature", state: 21.5, available: true, received_at: receivedAt }],
  }],
};
const healthBinding = {
  device_id: "display-1", entity_id: "sensor:temperature", stale_after: 60,
};
assert.equal(runtimeBindingHealth(healthBinding, runtimeSnapshot).status, "online");
assert.equal(runtimeBindingHealth(
  { ...healthBinding, stale_after: 1 },
  runtimeSnapshot,
  { now: Date.parse(receivedAt) + 2000 },
).status, "stale");
assert.equal(runtimeBindingHealth(healthBinding, {
  devices: [{ ...runtimeSnapshot.devices[0], status: "disconnected" }],
}).status, "offline");

const tileviewProject = {
  widgets: [
    {
      id: "main_tileview", widget_type: "tileview", properties: {}, children: [
        { id: "home_tile", widget_type: "tile", tile_row: 0, tile_col: 0, properties: {}, children: [] },
        { id: "settings_tile", widget_type: "tile", tile_row: 0, tile_col: 1, properties: {}, children: [] },
      ],
    },
  ],
};
const tileRuntime = { activeTiles: {} };
const byId = applyViewerAction(
  tileviewProject, { "lvgl.tileview.select": { id: "main_tileview", tile_id: "settings_tile" } }, tileRuntime,
);
assert.equal(byId.changed, true);
assert.equal(tileRuntime.activeTiles.main_tileview, "settings_tile");
const byRowColumn = applyViewerAction(
  tileviewProject, { "lvgl.tileview.select": { id: "main_tileview", row: 0, column: 0 } }, tileRuntime,
);
assert.equal(byRowColumn.changed, true);
assert.equal(tileRuntime.activeTiles.main_tileview, "home_tile");
const unknownTile = applyViewerAction(
  tileviewProject, { "lvgl.tileview.select": { id: "main_tileview", tile_id: "no_such_tile" } }, tileRuntime,
);
assert.equal(unknownTile.warning, true);
assert.equal(tileRuntime.activeTiles.main_tileview, "home_tile", "an unresolved target must not change the active tile");

const tabviewProject = {
  widgets: [
    {
      id: "main_tabview", widget_type: "tabview", properties: {}, children: [
        { id: "home_tab", widget_type: "tab", tab_title: "Home", properties: {}, children: [] },
        { id: "settings_tab", widget_type: "tab", tab_title: "Settings", properties: {}, children: [] },
      ],
    },
  ],
};
const tabRuntime = { activeTabs: {} };
const byIndex = applyViewerAction(
  tabviewProject, { "lvgl.tabview.select": { id: "main_tabview", index: 1 } }, tabRuntime,
);
assert.equal(byIndex.changed, true);
assert.equal(tabRuntime.activeTabs.main_tabview, "settings_tab");
const sameIndexAgain = applyViewerAction(
  tabviewProject, { "lvgl.tabview.select": { id: "main_tabview", index: 1 } }, tabRuntime,
);
assert.equal(sameIndexAgain.changed, false, "selecting the already-active tab must report no change");
const outOfRangeTab = applyViewerAction(
  tabviewProject, { "lvgl.tabview.select": { id: "main_tabview", index: 5 } }, tabRuntime,
);
assert.equal(outOfRangeTab.warning, true);
assert.equal(tabRuntime.activeTabs.main_tabview, "settings_tab", "an unresolved target must not change the active tab");

const msgboxProject = {
  widgets: [
    { id: "open_button", widget_type: "button", properties: {}, children: [] },
  ],
  msgboxes: [
    {
      id: "message_box", title: "Message box", close_button: true,
      body: { text: "Hi" },
      buttons: [{ id: "msgbox_close", widget_type: "button", properties: {}, children: [] }],
      header_buttons: [],
    },
  ],
};
const showResult = applyViewerAction(msgboxProject, { "lvgl.widget.show": "message_box" }, {});
assert.equal(showResult.changed, true);
assert.equal(msgboxProject.msgboxes[0].hidden, false, "lvgl.widget.show must find a msgbox by its own id, not just tree widgets");
const hideResult = applyViewerAction(msgboxProject, { "lvgl.widget.hide": "message_box" }, {});
assert.equal(hideResult.changed, true);
assert.equal(msgboxProject.msgboxes[0].hidden, true);
const showButtonResult = applyViewerAction(msgboxProject, { "lvgl.widget.hide": "msgbox_close" }, {});
assert.equal(showButtonResult.changed, true, "a msgbox button id must also be reachable, since it is a normal WidgetNode");
assert.equal(msgboxProject.msgboxes[0].buttons[0].hidden, true);
