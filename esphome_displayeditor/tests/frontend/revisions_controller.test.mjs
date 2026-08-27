import test from "node:test";
import assert from "node:assert/strict";

import { createRevisionsController } from "../../frontend/controllers/revisions-controller.js";

function fakeApi(response = {}) {
  const calls = [];
  const api = (path, options = {}) => {
    calls.push({ path, ...options });
    return Promise.resolve(response);
  };
  return { api, calls };
}

test("list and read address one project's versions", async () => {
  const { api, calls } = fakeApi();
  const controller = createRevisionsController(api);

  await controller.list("display.lvgldesign");
  await controller.read("display.lvgldesign", 42);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "designer/projects/display.lvgldesign/revisions",
      "designer/projects/display.lvgldesign/revisions/42",
    ],
  );
});

test("project names are encoded so they cannot break out of the path", async () => {
  const { api, calls } = fakeApi();
  await createRevisionsController(api).list("a b/../c.lvgldesign");

  assert.equal(
    calls[0].path,
    "designer/projects/a%20b%2F..%2Fc.lvgldesign/revisions",
  );
});

test("diff defaults to the current state and accepts another version", async () => {
  const { api, calls } = fakeApi();
  const controller = createRevisionsController(api);

  await controller.diff("display.lvgldesign", 7);
  await controller.diff("display.lvgldesign", 7, 3);

  assert.equal(
    calls[0].path,
    "designer/projects/display.lvgldesign/revisions/7/diff?against=current",
  );
  assert.equal(
    calls[1].path,
    "designer/projects/display.lvgldesign/revisions/7/diff?against=3",
  );
});

test("setLabel sends only the label", async () => {
  const { api, calls } = fakeApi();
  await createRevisionsController(api).setLabel("display.lvgldesign", 7, "vor dem Umbau");

  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].body), { label: "vor dem Umbau" });
});

test("locking and unlocking use POST and DELETE without a body", async () => {
  const { api, calls } = fakeApi();
  const controller = createRevisionsController(api);

  await controller.setLocked("display.lvgldesign", 7, true);
  await controller.setLocked("display.lvgldesign", 7, false);

  assert.equal(calls[0].path, "designer/projects/display.lvgldesign/revisions/7/lock");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].method, "DELETE");
});

test("restore carries the expected revision, and null for a deleted project", async () => {
  const { api, calls } = fakeApi();
  const controller = createRevisionsController(api);

  await controller.restore("display.lvgldesign", 7, "sha256:abc");
  await controller.restore("display.lvgldesign", 7);

  assert.equal(
    calls[0].path,
    "designer/projects/display.lvgldesign/revisions/7/restore",
  );
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { expected_revision: "sha256:abc" });
  assert.deepEqual(JSON.parse(calls[1].body), { expected_revision: null });
});

test("feed unwraps events and tolerates an empty response", async () => {
  const withEvents = fakeApi({ events: [{ id: 1 }] });
  assert.deepEqual(await createRevisionsController(withEvents.api).feed(25), [{ id: 1 }]);
  assert.equal(withEvents.calls[0].path, "designer/revisions?limit=25");

  const empty = fakeApi({});
  assert.deepEqual(await createRevisionsController(empty.api).feed(), []);
  assert.equal(empty.calls[0].path, "designer/revisions?limit=50");
});
