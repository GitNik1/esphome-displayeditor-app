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

test("an install groups its upload job and reports the upload's outcome", async () => {
  const { builderJobGroups, builderChainStatus } = await import("../../frontend/builder/model.js");
  const jobs = replaceBuilderJobs([
    { job_id: "c1", job_type: "compile", status: "completed", created_at: "2026-11-23T10:00" },
    { job_id: "u1", job_type: "upload", status: "running", depends_on: "c1", created_at: "2026-11-23T10:01" },
    { job_id: "solo", job_type: "compile", status: "completed", created_at: "2026-11-23T09:00" },
  ]);
  let groups = builderJobGroups(jobs);
  assert.deepEqual(groups.map((group) => group.job.job_id), ["c1", "solo"]);
  assert.equal(groups[0].status, "running");
  assert.equal(groups[0].active?.job_id, "u1");
  assert.deepEqual(groups[0].dependents.map((job) => job.job_id), ["u1"]);
  assert.equal(groups[1].active, null);

  applyBuilderEvent(jobs, { type: "builder_job", event: "job_changed", data: { job_id: "u1", status: "failed" } });
  groups = builderJobGroups(jobs);
  assert.equal(groups[0].status, "failed");
  assert.equal(groups[0].active, null);

  assert.equal(builderChainStatus({ job_id: "c", status: "failed" }, [{ job_id: "u", status: "queued" }]), "failed");
  // An upload whose compile job is not in the list stays visible on its own.
  const orphan = replaceBuilderJobs([{ job_id: "u2", status: "failed", depends_on: "gone" }]);
  assert.deepEqual(builderJobGroups(orphan).map((group) => group.job.job_id), ["u2"]);
});
