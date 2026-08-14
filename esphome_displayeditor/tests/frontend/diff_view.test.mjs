import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "../../frontend/configurations/diff-view.js";

test("diff parser distinguishes headers, hunks, additions and deletions", () => {
  const lines = parseUnifiedDiff("--- active/a.yaml\n+++ draft/a.yaml\n@@ -1 +1 @@\n context\n-old\n+new\n-removed\n context");
  assert.deepEqual(lines.map((line) => line.kind), [
    "header", "header", "hunk", "context", "changed-old", "changed-new", "deleted", "context",
  ]);
});

test("diff parser marks unpaired additions and empty final rows", () => {
  const lines = parseUnifiedDiff("@@ -0,0 +1,2 @@\n+first\n+second\n");
  assert.deepEqual(lines.map((line) => line.kind), ["hunk", "added", "added", "context"]);
});
