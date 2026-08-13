import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState, createStore } from "../../frontend/state/store.js";

test("createInitialState returns isolated mutable collections", () => {
  const first = createInitialState();
  const second = createInitialState();
  first.devices.push({ id: "one" });
  first.builderRequestsRunning.add("job");
  assert.deepEqual(second.devices, []);
  assert.equal(second.builderRequestsRunning.size, 0);
  assert.notEqual(first.project, second.project);
});

test("store updates state and notifies subscribers", () => {
  const store = createStore({ count: 0 });
  const seen = [];
  const unsubscribe = store.subscribe((count) => seen.push(count), (state) => state.count);
  store.update((state) => { state.count += 1; });
  unsubscribe();
  store.update((state) => { state.count += 1; });
  assert.equal(store.state.count, 2);
  assert.deepEqual(seen, [1]);
});

test("selector subscriptions ignore unrelated changes", () => {
  const store = createStore({ count: 0, label: "a" });
  const seen = [];
  store.subscribe((value, previous) => seen.push([previous, value]), (state) => state.count);
  store.update((state) => { state.label = "b"; });
  store.update((state) => { state.count = 1; });
  assert.deepEqual(seen, [[0, 1]]);
});
