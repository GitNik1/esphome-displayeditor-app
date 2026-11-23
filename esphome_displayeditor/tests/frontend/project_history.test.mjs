import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneProject,
  commitPendingUndo,
  pushHistory,
  redoHistory,
  undoHistory,
} from "../../frontend/project/history.js";

test("project clones do not share nested state", () => {
  const source = { widgets: [{ properties: { text: "old" } }] };
  const cloned = cloneProject(source);
  cloned.widgets[0].properties.text = "new";
  assert.equal(source.widgets[0].properties.text, "old");
});

test("history deduplicates snapshots and enforces its limit", () => {
  let undo = pushHistory([], { value: 1 }, 2);
  undo = pushHistory(undo, { value: 1 }, 2);
  undo = pushHistory(undo, { value: 2 }, 2);
  undo = pushHistory(undo, { value: 3 }, 2);
  assert.deepEqual(undo.map(JSON.parse), [{ value: 2 }, { value: 3 }]);
});

test("undo and redo move immutable snapshots between stacks", () => {
  const first = { value: 1 };
  const second = { value: 2 };
  const undo = pushHistory([], first);
  const undone = undoHistory(undo, [], second);
  assert.deepEqual(undone.project, first);
  assert.deepEqual(undone.undo, []);
  assert.deepEqual(undone.redo.map(JSON.parse), [second]);

  const redone = redoHistory(undone.undo, undone.redo, undone.project);
  assert.deepEqual(redone.project, second);
  assert.deepEqual(redone.undo.map(JSON.parse), [first]);
  assert.deepEqual(redone.redo, []);
});

test("empty history operations are no-ops", () => {
  assert.equal(undoHistory([], [], {}), null);
  assert.equal(redoHistory([], [], {}), null);
});


test("a snapshot taken just in case becomes an undo step only after a change", () => {
  const before = { value: 1 };
  const pending = JSON.stringify(before);

  const untouched = commitPendingUndo([], ["redo"], pending, { value: 1 });
  assert.equal(untouched.committed, false);
  assert.deepEqual(untouched.redo, ["redo"]);  // a mere click keeps redo

  const changed = commitPendingUndo([], ["redo"], pending, { value: 2 });
  assert.equal(changed.committed, true);
  assert.deepEqual(changed.undo.map(JSON.parse), [before]);
  assert.deepEqual(changed.redo, []);

  assert.equal(commitPendingUndo([], [], null, { value: 2 }).committed, false);
});

test("committing never stacks the same snapshot twice and keeps the limit", () => {
  const first = JSON.stringify({ value: 1 });
  let result = commitPendingUndo([first], [], first, { value: 2 }, 2);
  assert.deepEqual(result.undo, [first]);
  result = commitPendingUndo([first, JSON.stringify({ value: 2 })], [], JSON.stringify({ value: 3 }), { value: 4 }, 2);
  assert.deepEqual(result.undo.map(JSON.parse), [{ value: 2 }, { value: 3 }]);
});
