// @ts-check

/** Presentation rules for the "source config changed" dialog.
 *
 * Kept free of DOM access on purpose: which groups start ticked, and what the
 * confirmation actually costs, are the two decisions worth testing without a
 * browser.
 */

/** @typedef {{kind: "added" | "removed" | "changed", label: string,
 *   line: number | null}} ResyncChange */
/** @typedef {{id: string, missing: string[]}} BindingLoss */
/** @typedef {{key: string, changed: number, removes: number,
 *   changes: ResyncChange[], changes_truncated: number,
 *   losses: ResyncChange[], losses_truncated: number,
 *   binding_losses: BindingLoss[]}} ResyncGroup */
/** @typedef {{available: boolean, reason?: string, changed?: boolean,
 *   groups?: ResyncGroup[], unsupported?: {severity: string, message: string,
 *   path: string, line: number | null}[], unsupported_truncated?: number,
 *   binding_losses?: BindingLoss[], source?: {name: string, revision: string,
 *   known_revision: string | null}}} ResyncPlan */

export const RESYNC_GROUPS = ["entities", "resources", "layout"];

/** @param {ResyncPlan | null | undefined} plan */
export function hasChanges(plan) {
  return Boolean(plan && plan.available && plan.changed);
}

/** @param {ResyncPlan} plan @param {string} key */
export function groupOf(plan, key) {
  return (plan.groups || []).find((group) => group.key === key) || null;
}

/** Groups ticked when the dialog opens.
 *
 * A group that only adds and updates is free to take; one that removes
 * something can destroy work the designer never published, so it stays
 * unticked until the user reads its loss list and decides.
 * @param {ResyncPlan} plan */
export function defaultGroups(plan) {
  return (plan.groups || [])
    .filter((group) => group.changed > 0 && group.removes === 0)
    .map((group) => group.key);
}

/** @param {ResyncGroup} group */
export function countsByKind(group) {
  const counts = { added: 0, removed: 0, changed: 0 };
  group.changes.forEach((change) => {
    if (change.kind in counts) counts[change.kind] += 1;
  });
  // The lists are capped server-side; the totals are not, so a truncated list
  // must not silently shrink the headline number.
  const listed = counts.added + counts.removed + counts.changed;
  counts.changed += Math.max(0, group.changed - listed);
  return counts;
}

/** "3 neu · 1 entfällt" - only the non-zero parts, in a stable order.
 * @param {ResyncGroup} group
 * @param {(key: string, params?: Record<string, unknown>) => string} translate */
export function groupSummary(group, translate) {
  const counts = countsByKind(group);
  const parts = [];
  if (counts.added) parts.push(translate("resync.count.added", { count: counts.added }));
  if (counts.changed) parts.push(translate("resync.count.changed", { count: counts.changed }));
  if (counts.removed) parts.push(translate("resync.count.removed", { count: counts.removed }));
  return parts.length ? parts.join(" · ") : translate("resync.count.none");
}

/** @param {ResyncChange} change
 * @param {(key: string, params?: Record<string, unknown>) => string} translate */
export function changeText(change, translate) {
  const where = change.line
    ? translate("resync.line", { line: change.line })
    : translate("resync.lineUnknown");
  return `${where} · ${change.label}`;
}

/** Everything the current tick selection would cost.
 *
 * Unions the per-group loss lists, and dedupes the bindings: one binding can
 * lose both its entity and its widget, and saying so twice helps nobody.
 * @param {ResyncPlan} plan @param {readonly string[]} selected */
export function selectedLosses(plan, selected) {
  const groups = (plan.groups || []).filter((group) => selected.includes(group.key));
  /** @type {{group: string, change: ResyncChange}[]} */
  const removals = [];
  /** @type {Map<string, BindingLoss>} */
  const bindings = new Map();
  groups.forEach((group) => {
    group.losses.forEach((change) => removals.push({ group: group.key, change }));
    (group.binding_losses || []).forEach((loss) => {
      const previous = bindings.get(loss.id);
      bindings.set(loss.id, previous
        ? { id: loss.id, missing: [...new Set([...previous.missing, ...loss.missing])] }
        : loss);
    });
  });
  const truncated = groups.reduce((total, group) => total + group.losses_truncated, 0);
  return { removals, bindings: [...bindings.values()], truncated };
}

/** Whether "Übernehmen" may be pressed at all. */
/** @param {readonly string[]} selected */
export function canApply(selected) {
  return selected.length > 0;
}

// --- what a version says about the import that made it ----------------------

/** @typedef {{name: string, revision: string,
 *   previous_revision: string | null}} VersionSource */
/** The fields of a revision entry this module reads. Deliberately a subset of
 * the `RevisionEntry` the history renders - `created_at` rides along because
 * the undo confirmation names the date it is about to restore.
 * @typedef {{id: number, revision: string, created_at: string, origin: string,
 *   details?: {source?: VersionSource, groups?: string[],
 *   dropped_bindings?: string[], replaced_revision?: string} | null}} Version */

/** The recognisable part of a revision hash. @param {unknown} revision */
export function shortRevision(revision) {
  return typeof revision === "string" && revision.startsWith("sha256:")
    ? revision.slice(7, 19)
    : "";
}

/** The configuration move a version recorded, or null if it is not an import.
 *
 * `changed` is false when an import adopted a config that had not actually
 * moved - a re-import of the same file. The timeline should mark the version,
 * not claim the YAML changed.
 * @param {Version | null | undefined} version */
export function sourceMove(version) {
  const source = version?.details?.source;
  if (!source?.name) return null;
  return {
    name: source.name,
    from: shortRevision(source.previous_revision),
    to: shortRevision(source.revision),
    changed: Boolean(source.revision) && source.revision !== source.previous_revision,
    groups: version?.details?.groups || [],
  };
}

/** The version an import displaced, if the history still holds it.
 *
 * Matched by revision rather than by position: versions rotate out, and the
 * entry directly below is only the right answer while nothing has been
 * evicted. @param {Version | null | undefined} version @param {Version[]} versions */
export function replacedVersion(version, versions) {
  const target = version?.details?.replaced_revision;
  if (!target) return null;
  return (versions || []).find((item) => item.revision === target) || null;
}

/** @param {Version | null | undefined} version @param {Version[]} versions */
export function canUndoImport(version, versions) {
  return version?.origin === "resync" && Boolean(replacedVersion(version, versions));
}

/** i18n key explaining why there is nothing to compare against.
 * @param {ResyncPlan} plan */
export function unavailableKey(plan) {
  const reasons = new Set(["no_source", "source_missing", "import_failed"]);
  return `resync.unavailable.${reasons.has(String(plan.reason)) ? plan.reason : "unknown"}`;
}
