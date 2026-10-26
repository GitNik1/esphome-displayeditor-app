import assert from "node:assert/strict";
import test from "node:test";

import { capabilitySummary, roleOnboarding, systemStatusRows } from "../../frontend/system/status.js";

const t = (key, values = {}) => `${key}${Object.keys(values).length ? JSON.stringify(values) : ""}`;

test("a viewer on a writable install gets their user id and a user_roles snippet", () => {
  const system = { access_level: "write", user: { id: "abc123", role: "viewer" } };
  const hint = roleOnboarding(system, { "designer.project_write": false });
  assert.equal(hint.userId, "abc123");
  assert.equal(hint.role, "viewer");
  assert.match(hint.snippet, /user_id: "abc123"\n    role: administrator/);
  assert.equal(roleOnboarding(system, { "designer.project_write": true }), null);
  assert.equal(roleOnboarding({ ...system, access_level: "read" }, {}), null);
  assert.equal(roleOnboarding({ access_level: "write", user: {} }, {}), null);
});

test("the system rows say what is off and how to switch it on", () => {
  const rows = systemStatusRows({
    version: "0.401.0", access_level: "write",
    user: { name: "nik", role: "administrator" },
    backends: { configuration: "filesystem", runtime: "disabled" },
    builder: { compatible: false, reason: "builder_disabled" },
  }, t);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(byLabel["system.row.version"].value, "0.401.0");
  assert.equal(byLabel["system.row.access"].value, "system.access.write");
  assert.equal(byLabel["system.row.devices"].tone, "off");
  assert.equal(byLabel["system.row.devices"].hint, "system.hint.runtime");
  assert.equal(byLabel["system.row.builder"].hint, "configs.hint.builderDisabled");
  assert.equal(byLabel["system.row.configurations"].tone, "ok");
});

test("capabilities are split into available and unavailable", () => {
  assert.deepEqual(capabilitySummary({ b: true, a: false, c: true }), { available: ["b", "c"], unavailable: ["a"] });
});
