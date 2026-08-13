import assert from "node:assert/strict";
import test from "node:test";
import { createProjectsController } from "../../frontend/controllers/projects-controller.js";

test("project controller owns transport paths and revision protocol", async () => {
  const calls = [];
  const controller = createProjectsController(async (path, options = {}) => {
    calls.push([path, options]);
    return path === "designer/projects" ? { projects: [{ name: "one" }] } : { revision: "r2" };
  });
  assert.deepEqual(await controller.list(), [{ name: "one" }]);
  await controller.load("folder/panel");
  await controller.save("panel", { widgets: [] }, "r1");
  await controller.remove("panel", "r2");
  assert.equal(calls[1][0], "designer/projects/folder%2Fpanel");
  assert.deepEqual(JSON.parse(calls[2][1].body), { project: { widgets: [] }, expected_revision: "r1" });
  assert.match(calls[3][0], /expected_revision=r2$/);
});
