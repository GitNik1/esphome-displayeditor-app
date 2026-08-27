import test from "node:test";
import assert from "node:assert/strict";

import {
  actionKey,
  actorKind,
  actorLabel,
  carriesContent,
  entryModifier,
  formatSize,
  groupFeedByDay,
  lockQuota,
  originKey,
  versionTitle,
} from "../../frontend/project/revisions-view.js";

const translate = (key, params = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    key,
  );

test("actorKind separates editor, MCP and hidden authors", () => {
  assert.equal(actorKind("ha:abc123"), "ui");
  assert.equal(actorKind("mcp:lan:deadbeef"), "mcp");
  assert.equal(actorKind(null), "hidden");
  assert.equal(actorKind("something"), "unknown");
});

test("actorLabel strips the prefix and shortens long MCP digests", () => {
  assert.equal(actorLabel("ha:abc123", translate), "abc123");
  assert.equal(actorLabel("mcp:lan:short", translate), "lan:short");
  assert.equal(
    actorLabel("mcp:lan:0123456789abcdef0123", translate),
    "lan:0123456789…",
  );
  assert.equal(actorLabel(null, translate), "revisions.actor.hidden");
});

test("origin and action keys fall back for unknown values", () => {
  assert.equal(originKey("mcp"), "revisions.origin.mcp");
  assert.equal(originKey("restore"), "revisions.origin.restore");
  assert.equal(originKey("from-the-future"), "revisions.origin.unknown");
  assert.equal(actionKey("delete"), "revisions.action.delete");
  assert.equal(actionKey("nonsense"), "revisions.action.save");
});

test("entryModifier marks deletions regardless of their origin", () => {
  assert.equal(entryModifier({ origin: "mcp", action: "save" }), "mcp");
  assert.equal(entryModifier({ origin: "ui", action: "delete" }), "delete");
  assert.equal(entryModifier({ origin: "weird", action: "save" }), "unknown");
});

test("versionTitle prefers the label over the ordinal", () => {
  assert.equal(versionTitle({ label: "vor dem Umbau" }, 2, translate), "vor dem Umbau");
  assert.equal(versionTitle({ label: null }, 2, translate), "revisions.untitled");
  assert.equal(
    versionTitle({ label: null }, 0, (key, params) => `${key}:${params.number}`),
    "revisions.untitled:1",
  );
});

test("carriesContent rejects tombstones and skipped entries", () => {
  assert.equal(carriesContent({ encoding: "zlib" }), true);
  assert.equal(carriesContent({ encoding: "tombstone" }), false);
  assert.equal(carriesContent({ encoding: "skipped" }), false);
});

test("lockQuota reports usage and exhaustion", () => {
  assert.deepEqual(lockQuota({ locked_used: 2, locked_depth: 5 }), {
    used: 2,
    limit: 5,
    exhausted: false,
  });
  assert.deepEqual(lockQuota({ locked_used: 5, locked_depth: 5 }), {
    used: 5,
    limit: 5,
    exhausted: true,
  });
  assert.deepEqual(lockQuota({}), { used: 0, limit: 0, exhausted: true });
});

test("formatSize stays readable for small and large versions", () => {
  assert.equal(formatSize(0), "0 KB");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(41233), "40 KB");
});

test("groupFeedByDay buckets consecutive days and keeps order", () => {
  const groups = groupFeedByDay([
    { created_at: "2026-08-27T10:00:00+00:00", id: 3 },
    { created_at: "2026-08-27T09:00:00+00:00", id: 2 },
    { created_at: "2026-08-26T18:00:00+00:00", id: 1 },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.day, group.events.map((event) => event.id)]),
    [
      ["2026-08-27", [3, 2]],
      ["2026-08-26", [1]],
    ],
  );
});
