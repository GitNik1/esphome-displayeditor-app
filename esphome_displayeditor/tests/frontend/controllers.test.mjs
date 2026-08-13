import assert from "node:assert/strict";
import test from "node:test";
import { createDevicesController } from "../../frontend/controllers/devices-controller.js";
import { createBuilderController } from "../../frontend/controllers/builder-controller.js";

test("devices controller aggregates details and owns admin transport", async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push([path, options]); return path.endsWith("/states") ? { states: [1] } : {}; };
  const controller = createDevicesController(api);
  assert.deepEqual((await controller.details("a/b")).states, [1]);
  await controller.save({ id: "a", encryption_key_ref: "secret" }, null, "key");
  assert.ok(calls.some(([path]) => path === "devices/a%2Fb/info"));
  assert.ok(calls.some(([path]) => path === "admin/device-secrets/secret"));
});

test("builder controller forwards idempotency keys", async () => {
  const calls = [];
  const controller = createBuilderController(async (path, options = {}) => { calls.push([path, options]); return { jobs: [] }; });
  await controller.compile("panel.yaml", "once");
  await controller.install("panel.yaml", "ota");
  assert.equal(calls[0][1].headers["Idempotency-Key"], "once");
  assert.equal(JSON.parse(calls[1][1].body).confirmed, true);
});
