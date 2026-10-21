import test from "node:test";
import assert from "node:assert/strict";

import {
  canApply,
  canUndoImport,
  changeText,
  countsByKind,
  defaultGroups,
  groupSummary,
  hasChanges,
  replacedVersion,
  selectedLosses,
  shortRevision,
  sourceMove,
  unavailableKey,
} from "../../frontend/project/resync-view.js";

const translate = (key, params = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    key,
  );

function group(key, changes, extra = {}) {
  return {
    key,
    changed: changes.length,
    removes: changes.filter((change) => change.kind === "removed").length,
    changes,
    changes_truncated: 0,
    losses: changes.filter((change) => change.kind === "removed"),
    losses_truncated: 0,
    binding_losses: [],
    ...extra,
  };
}

const added = { kind: "added", label: "sensor.pump", line: 12 };
const removed = { kind: "removed", label: "label title", line: null };

test("a plan without changes is not worth a dialog", () => {
  assert.equal(hasChanges({ available: true, changed: false }), false);
  assert.equal(hasChanges({ available: false, changed: true }), false);
  assert.equal(hasChanges(null), false);
  assert.equal(hasChanges({ available: true, changed: true }), true);
});

test("only groups that add or update start ticked", () => {
  const plan = {
    available: true,
    changed: true,
    groups: [
      group("entities", [added]),
      group("resources", []),
      group("layout", [added, removed]),
    ],
  };
  // Layout removes a widget, so adopting it has to be a deliberate act.
  assert.deepEqual(defaultGroups(plan), ["entities"]);
});

test("a truncated list still reports the full count", () => {
  const truncated = group("layout", [added], { changed: 70, changes_truncated: 69 });
  assert.deepEqual(countsByKind(truncated), { added: 1, removed: 0, changed: 69 });
  assert.equal(
    groupSummary(truncated, translate),
    "resync.count.added · resync.count.changed",
  );
});

test("a group summary names only what actually happens", () => {
  assert.equal(groupSummary(group("entities", []), translate), "resync.count.none");
  assert.equal(
    groupSummary(group("entities", [added, removed]), translate),
    "resync.count.added · resync.count.removed",
  );
});

test("a change without a line says so instead of inventing one", () => {
  assert.equal(changeText(added, translate), "resync.line · sensor.pump");
  assert.equal(changeText(removed, translate), "resync.lineUnknown · label title");
});

test("losses cover only the ticked groups", () => {
  const plan = {
    available: true,
    changed: true,
    groups: [
      group("entities", [removed], {
        binding_losses: [{ id: "show_level", missing: ["sensor.tank"] }],
      }),
      group("layout", [removed], {
        binding_losses: [{ id: "show_level", missing: ["title"] }],
      }),
    ],
  };
  const entitiesOnly = selectedLosses(plan, ["entities"]);
  assert.deepEqual(entitiesOnly.bindings, [
    { id: "show_level", missing: ["sensor.tank"] },
  ]);
  assert.equal(entitiesOnly.removals.length, 1);
  assert.equal(entitiesOnly.removals[0].group, "entities");

  // The same binding breaks in both groups: it is one loss, not two.
  const both = selectedLosses(plan, ["entities", "layout"]);
  assert.deepEqual(both.bindings, [
    { id: "show_level", missing: ["sensor.tank", "title"] },
  ]);
  assert.equal(both.removals.length, 2);

  assert.deepEqual(selectedLosses(plan, []), {
    removals: [], bindings: [], truncated: 0,
  });
});

test("adopting nothing is not an option", () => {
  assert.equal(canApply([]), false);
  assert.equal(canApply(["entities"]), true);
});

const importVersion = {
  id: 2, origin: "resync", revision: "sha256:bbb", created_at: "2026-08-28T10:00:00Z",
  details: {
    source: { name: "display.yaml", revision: "sha256:def", previous_revision: "sha256:abc" },
    groups: ["entities"],
    replaced_revision: "sha256:aaa",
  },
};
const beforeImport = {
  id: 1, origin: "ui", revision: "sha256:aaa", created_at: "2026-08-28T09:00:00Z",
  details: null,
};

test("a revision hash is shortened to the part a human can compare", () => {
  assert.equal(shortRevision(`sha256:${"a1b2c3d4e5f6".padEnd(64, "0")}`), "a1b2c3d4e5f6");
  assert.equal(shortRevision("not-a-hash"), "");
  assert.equal(shortRevision(null), "");
});

test("an import version reports the move its configuration made", () => {
  const move = sourceMove(importVersion);
  assert.equal(move.name, "display.yaml");
  assert.equal(move.changed, true);
  assert.deepEqual(move.groups, ["entities"]);
  assert.equal(sourceMove(beforeImport), null);
});

test("re-importing an unmoved config is marked, but not as a change", () => {
  const same = {
    ...importVersion,
    details: {
      ...importVersion.details,
      source: { name: "display.yaml", revision: "sha256:def", previous_revision: "sha256:def" },
    },
  };
  assert.equal(sourceMove(same).changed, false);
});

test("the undo target is matched by revision, not by position", () => {
  const versions = [importVersion, { ...beforeImport, id: 7 }];
  assert.equal(replacedVersion(importVersion, versions).id, 7);
  assert.equal(canUndoImport(importVersion, versions), true);
});

test("an import whose predecessor rotated out cannot be undone", () => {
  assert.equal(replacedVersion(importVersion, [importVersion]), null);
  assert.equal(canUndoImport(importVersion, [importVersion]), false);
  // And an ordinary save is not an import in the first place.
  assert.equal(canUndoImport(beforeImport, [beforeImport, importVersion]), false);
});

test("an unknown reason still gets a translatable key", () => {
  assert.equal(unavailableKey({ available: false, reason: "no_source" }),
    "resync.unavailable.no_source");
  assert.equal(unavailableKey({ available: false, reason: "moon_phase" }),
    "resync.unavailable.unknown");
  assert.equal(unavailableKey({ available: false }), "resync.unavailable.unknown");
});
