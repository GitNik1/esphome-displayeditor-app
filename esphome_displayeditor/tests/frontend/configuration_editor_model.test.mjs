import test from "node:test";
import assert from "node:assert/strict";

import {
  cursorPosition,
  editorIsDirty,
  findMatch,
  lineNumbers,
} from "../../frontend/configurations/editor-model.js";

test("lineNumbers mirrors all editor rows", () => {
  assert.equal(lineNumbers("first\nsecond\n"), "1\n2\n3");
});

test("editorIsDirty requires an active configuration and changed content", () => {
  assert.equal(editorIsDirty(null, "changed", "original"), false);
  assert.equal(editorIsDirty("display.yaml", "same", "same"), false);
  assert.equal(editorIsDirty("display.yaml", "changed", "original"), true);
});

test("cursorPosition reports one-based line and column", () => {
  assert.deepEqual(cursorPosition("abc\ndef", 5), { line: 2, column: 2 });
});

test("findMatch navigates forward, backward and wraps", () => {
  assert.deepEqual(findMatch("Alpha beta alpha", "alpha", 0, 1), {
    count: 2, selected: 1, index: 11,
  });
  assert.deepEqual(findMatch("Alpha beta alpha", "alpha", 0, -1), {
    count: 2, selected: 1, index: 11,
  });
  assert.deepEqual(findMatch("Alpha beta alpha", "missing", 0, 1), {
    count: 0, selected: -1, index: -1,
  });
});
