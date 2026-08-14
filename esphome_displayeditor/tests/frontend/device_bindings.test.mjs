import assert from "node:assert/strict";
import test from "node:test";

import {
  bindingsForWidget,
  bindingGraph,
  compatibleEntities,
  defaultBindingId,
  deviceBindingTargets,
  removeDeviceBinding,
  upsertDeviceBinding,
} from "../../frontend/bindings/device-bindings.js";

test("capability matrix exposes meter, display and input bindings", () => {
  assert.deepEqual(deviceBindingTargets({ widget_type: "meter" }, "entity_to_widget").slice(0, 3),
    ["indicator_value", "indicator_start", "indicator_end"]);
  assert.deepEqual(deviceBindingTargets({ widget_type: "slider" }, "widget_to_entity"), ["value", "release"]);
  assert.deepEqual(deviceBindingTargets({ widget_type: "label" }, "entity_to_widget"),
    ["text", "visible", "opacity", "color"]);
});

test("binding graph deduplicates nodes and represents bidirectional edges", () => {
  const graph = bindingGraph([
    { id: "a", direction: "entity_to_widget", source: { domain: "sensor", id: "temp" }, target: { widget_id: "label" } },
    { id: "b", direction: "bidirectional", source: { domain: "number", id: "setpoint" }, target: { widget_id: "slider" } },
  ]);
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.edges.map((edge) => edge.bidirectional), [false, true]);
});

test("entity compatibility respects read, write and bidirectional modes", () => {
  const entities = [
    { id: "sensor", readable: true, writable: false },
    { id: "button", readable: false, writable: true },
    { id: "number", readable: true, writable: true },
  ];
  assert.deepEqual(compatibleEntities(entities, "entity_to_widget").map((e) => e.id), ["sensor", "number"]);
  assert.deepEqual(compatibleEntities(entities, "widget_to_entity").map((e) => e.id), ["button", "number"]);
  assert.deepEqual(compatibleEntities(entities, "bidirectional").map((e) => e.id), ["number"]);
});

test("binding collection updates by stable id and filters by widget", () => {
  const first = { id: "one", source: { domain: "sensor", id: "temp" }, target: { widget_id: "meter" } };
  const changed = { ...first, transform: { factor: 2 } };
  const other = { id: "two", source: { widget_id: "button" }, target: { domain: "light", id: "lamp" } };
  const bindings = upsertDeviceBinding(upsertDeviceBinding([], first), changed).concat(other);
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindingsForWidget(bindings, "meter"), [changed]);
  assert.deepEqual(removeDeviceBinding(bindings, "one"), [other]);
  assert.equal(defaultBindingId("meter-1", "sensor.temp"), "bind_meter_1_sensor_temp");
});
