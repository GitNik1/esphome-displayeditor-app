// @ts-check

import { builderBlockedReason } from "../builder/model.js";

/** @typedef {(key: string, values?: Record<string, unknown>) => string} Translate */
/** @typedef {{label: string, value: string, hint?: string, tone?: "ok" | "off"}} StatusRow */

/**
 * The hint for someone who can open the app but not edit anything. Every
 * Ingress user gets the add-on's `default_role` (viewer unless configured),
 * and finding one's own Home Assistant user id was left to the user.
 * @param {any} system @param {Record<string, unknown>} capabilities
 * @returns {{userId: string, role: string, snippet: string} | null}
 */
export function roleOnboarding(system, capabilities) {
  const userId = system?.user?.id;
  const writable = ["write", "write_with_builder"].includes(system?.access_level);
  if (!userId || !writable || capabilities["designer.project_write"]) return null;
  return {
    userId: String(userId),
    role: String(system?.user?.role || "viewer"),
    snippet: `user_roles:\n  - user_id: "${userId}"\n    role: administrator\n`,
  };
}

/**
 * Readable rows for the System view - it showed the raw JSON of system and
 * capabilities. Each switched-off part says how to switch it on.
 * @param {any} system @param {Translate} t @returns {StatusRow[]}
 */
export function systemStatusRows(system, t) {
  const user = system?.user || {};
  const backends = system?.backends || {};
  const builder = system?.builder || {};
  const filesystem = backends.configuration === "filesystem";
  const runtime = backends.runtime && backends.runtime !== "disabled";
  const blocked = builderBlockedReason(builder);
  return [
    { label: t("system.row.version"), value: String(system?.version || "?") },
    { label: t("system.row.access"), value: t(`system.access.${system?.access_level || "none"}`) },
    {
      label: t("system.row.user"),
      value: `${user.display_name || user.name || user.id || "Ingress"} · ${user.role || "?"}`,
    },
    {
      label: t("system.row.configurations"),
      value: t(filesystem ? "system.value.available" : "system.value.off"),
      tone: filesystem ? "ok" : "off",
      hint: filesystem ? undefined : t("system.hint.filesystem"),
    },
    {
      label: t("system.row.devices"),
      value: t(runtime ? "system.value.available" : "system.value.off"),
      tone: runtime ? "ok" : "off",
      hint: runtime ? undefined : t("system.hint.runtime"),
    },
    {
      label: t("system.row.builder"),
      value: blocked ? t("system.value.off") : t("system.value.builderReady", { version: builder.esphome_version || "?" }),
      tone: blocked ? "off" : "ok",
      hint: blocked ? t(blocked.key, blocked.values) : undefined,
    },
  ];
}

/** @param {Record<string, unknown>} capabilities */
export function capabilitySummary(capabilities) {
  const keys = Object.keys(capabilities || {}).sort();
  return {
    available: keys.filter((key) => capabilities[key]),
    unavailable: keys.filter((key) => !capabilities[key]),
  };
}
