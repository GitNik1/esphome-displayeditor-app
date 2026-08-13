import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneProject,
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

