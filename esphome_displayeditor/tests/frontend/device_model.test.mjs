import assert from "node:assert/strict";
import test from "node:test";

import { applyRuntimeEvent, deviceTableColumns, formatDeviceLogs, mergeDeviceState } from "../../frontend/devices/model.js";

test("device table includes only populated preferred columns", () => {
  assert.deepEqual(deviceTableColumns([{ type: "sensor", state: 2 }], ["type", "name", "state"]), ["type", "state"]);
});

test("device logs have stable readable lines", () => {
  assert.equal(formatDeviceLogs([], "none"), "none");
  assert.equal(formatDeviceLogs([{ received_at: "now", message: "ok" }]), "[now] [INFO] ok");
});

test("device states update by their semantic identity", () => {
  const states = [{ type: "sensor", key: 1, state: 10 }];
  mergeDeviceState(states, { type: "sensor", key: 1, state: 11 });
  mergeDeviceState(states, { type: "switch", object_id: "lamp", state: true });
  assert.deepEqual(states.map((item) => item.state), [11, true]);
});

test("runtime events update connections, states and removals", () => {
  const snapshot = { devices: [{ id: "panel", status: "ready", states: [] }] };
  applyRuntimeEvent(snapshot, { type: "connection", device_id: "panel", status: "disconnected" });
  applyRuntimeEvent(snapshot, { type: "state", device_id: "panel", state: { type: "sensor", key: 7, state: 21, received_at: "now" } });
  assert.equal(snapshot.devices[0].status, "disconnected");
  assert.equal(snapshot.devices[0].states[0].entity_id, "sensor:7");
  assert.equal(snapshot.devices[0].last_seen, "now");
  applyRuntimeEvent(snapshot, { type: "device_removed", device_id: "panel" });
  assert.deepEqual(snapshot.devices, []);
});
