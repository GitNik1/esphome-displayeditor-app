import test from "node:test";
import assert from "node:assert/strict";

import { createResyncController } from "../../frontend/controllers/resync-controller.js";

function fakeApi(response = {}) {
  const calls = [];
  const api = (path, options = {}) => {
    calls.push({ path, ...options });
    return Promise.resolve(response);
  };
  return { api, calls };
}

test("the preview is a plain read of the project's source", async () => {
  const { api, calls } = fakeApi();
  await createResyncController(api).preview("display.lvgldesign");

  assert.deepEqual(calls, [{ path: "designer/projects/display.lvgldesign/source" }]);
});

test("applying posts the ticked groups and the revision it saw", async () => {
  const { api, calls } = fakeApi();
  await createResyncController(api).apply(
    "display.lvgldesign", ["entities", "layout"], "sha256:abc",
  );

  assert.equal(calls[0].path, "designer/projects/display.lvgldesign/source/apply");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), {
    groups: ["entities", "layout"],
    expected_revision: "sha256:abc",
    lock_previous: false,
  });
});

test("pinning the pre-import version is opt-in and travels with the request", async () => {
  const { api, calls } = fakeApi();
  await createResyncController(api).apply(
    "display.lvgldesign", ["entities"], "sha256:abc", true,
  );

  assert.equal(JSON.parse(calls[0].body).lock_previous, true);
});

test("project names are encoded so they cannot break out of the path", async () => {
  const { api, calls } = fakeApi();
  await createResyncController(api).preview("a b/../c.lvgldesign");

  assert.equal(calls[0].path, "designer/projects/a%20b%2F..%2Fc.lvgldesign/source");
});
