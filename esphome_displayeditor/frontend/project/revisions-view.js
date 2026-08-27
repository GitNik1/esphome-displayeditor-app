// @ts-check

/** @typedef {{id: number, revision: string, created_at: string, actor: string | null,
 *   origin: string, action: string, byte_size: number, encoding: string,
 *   restored_from: number | null, label: string | null, locked: boolean,
 *   is_current?: boolean, project_name?: string}} RevisionEntry */

const ORIGINS = new Set(["ui", "mcp", "mcp_import", "restore", "unknown"]);
const ACTIONS = new Set(["save", "delete"]);

/** Which kind of writer an actor id names.
 * @param {string | null | undefined} actor @returns {"ui"|"mcp"|"hidden"|"unknown"} */
export function actorKind(actor) {
  if (actor === null || actor === undefined) return "hidden";
  if (actor.startsWith("ha:")) return "ui";
  if (actor.startsWith("mcp:")) return "mcp";
  return "unknown";
}

/** @param {string | null | undefined} actor @param {(key: string) => string} translate */
export function actorLabel(actor, translate) {
  const kind = actorKind(actor);
  if (kind === "hidden") return translate("revisions.actor.hidden");
  if (kind === "unknown") return translate("revisions.actor.unknown");
  const rest = String(actor).slice(kind === "ui" ? 3 : 4);
  // MCP identities are long digests; a prefix is enough to tell them apart.
  return kind === "mcp" && rest.length > 14 ? `${rest.slice(0, 14)}…` : rest;
}

/** i18n key for an origin, tolerating values a future server might add.
 * @param {string} origin */
export function originKey(origin) {
  return `revisions.origin.${ORIGINS.has(origin) ? origin : "unknown"}`;
}

/** @param {string} action */
export function actionKey(action) {
  return `revisions.action.${ACTIONS.has(action) ? action : "save"}`;
}

/** CSS modifier for an entry's chip, so a delete reads differently from a save.
 * @param {RevisionEntry} entry */
export function entryModifier(entry) {
  return entry.action === "delete" ? "delete" : (ORIGINS.has(entry.origin) ? entry.origin : "unknown");
}

/** A stable, human-facing name: the label if there is one, else an ordinal.
 * @param {RevisionEntry} entry @param {number} index
 * @param {(key: string, params?: Record<string, unknown>) => string} translate */
export function versionTitle(entry, index, translate) {
  if (entry.label) return entry.label;
  return translate("revisions.untitled", { number: index + 1 });
}

/** Whether the restore button may be offered for an entry at all.
 * Tombstones and skipped oversized entries carry no content to restore.
 * @param {RevisionEntry} entry */
export function carriesContent(entry) {
  return entry.encoding !== "tombstone" && entry.encoding !== "skipped";
}

/** @param {{locked_used?: number, locked_depth?: number}} listing */
export function lockQuota(listing) {
  const used = listing.locked_used || 0;
  const limit = listing.locked_depth || 0;
  return { used, limit, exhausted: used >= limit };
}

/** @param {number} bytes */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Group a chronological feed into day buckets, preserving order.
 * @param {RevisionEntry[]} events @returns {{day: string, events: RevisionEntry[]}[]} */
export function groupFeedByDay(events) {
  /** @type {{day: string, events: RevisionEntry[]}[]} */
  const groups = [];
  events.forEach((event) => {
    const day = String(event.created_at || "").slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  });
  return groups;
}
