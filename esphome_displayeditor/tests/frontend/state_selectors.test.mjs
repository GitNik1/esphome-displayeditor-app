import assert from "node:assert/strict";
import test from "node:test";
import { selectCapability, selectDesignerStatus, selectPublishedConfiguration, selectSelectedDevice } from "../../frontend/state/selectors.js";

test("state selectors centralize derived application state", () => {
  const state = { capabilities: { write: 1 }, activeConfig: "panel.yaml", hasDraft: false, projectDirty: true, projectName: null, selectedDevice: "two", devices: [{ id: "one" }, { id: "two" }] };
  assert.equal(selectCapability("write")(state), true);
  assert.equal(selectPublishedConfiguration(state), true);
  assert.equal(selectSelectedDevice(state).id, "two");
  assert.equal(selectDesignerStatus(state), "dirty:local");
});
