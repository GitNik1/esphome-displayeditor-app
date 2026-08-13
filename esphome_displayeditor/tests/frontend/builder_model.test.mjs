import assert from "node:assert/strict";
import test from "node:test";

import { applyBuilderEvent, builderAvailability, builderRequest, replaceBuilderJobs, sortedBuilderJobs } from "../../frontend/builder/model.js";

test("builder availability requires a published configuration and capabilities", () => {
  const state = { activeConfig: "panel.yaml", hasDraft: false, capabilities: { "configuration.validate_esphome": true, "firmware.compile": true, "firmware.upload": true }, builderRequestsRunning: new Set(["compile"]) };
  assert.deepEqual(builderAvailability(state), { validate: true, compile: false, install: true });
  state.hasDraft = true;
  assert.deepEqual(builderAvailability(state), { validate: false, compile: false, install: false });
});

test("builder request keys remain stable until cleared", () => {
  const state = { activeConfig: "panel.yaml", builderRequestKeys: {} };
  let generated = 0;
  const first = builderRequest(state, "compile", () => `key-${++generated}`);
  const second = builderRequest(state, "compile", () => `key-${++generated}`);
  assert.deepEqual(first, second);
  assert.equal(generated, 1);
});

test("builder job snapshots sort newest first and events merge", () => {
  const jobs = replaceBuilderJobs([{ job_id: "old", created_at: "2025" }, { job_id: "new", created_at: "2026" }]);
  assert.deepEqual(sortedBuilderJobs(jobs).map((job) => job.job_id), ["new", "old"]);
  applyBuilderEvent(jobs, { type: "builder_job", event: "job_changed", data: { job_id: "old", status: "running" } });
  applyBuilderEvent(jobs, { type: "builder_job", event: "job_output", data: { job_id: "old", line: "building" } });
  assert.equal(jobs.old.status, "running");
  assert.equal(jobs.old.last_output, "building");
});
