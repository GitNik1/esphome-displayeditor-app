// @ts-check

import { projectWidgetEntries } from "./model.js";

/** @typedef {{id: string, [key: string]: any}} Identified */
/** @typedef {{pages?: Identified[], styles?: Identified[], fonts?: Identified[],
 * images?: Identified[], colors?: Identified[], reserved_ids?: string[],
 * [key: string]: any}} ColorProject */

/** @param {unknown} value @returns {string | null} */
export function normalizeLibraryHex(value) {
  const raw = String(value || "").trim().replace(/^#/, "").replace(/^0x/i, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split("").map((character) => character + character).join("").toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : null;
}

/** @param {ColorProject} project @param {string} id
 * @param {string | null} [replacement] @returns {string[]} */
export function colorReferenceLocations(project, id, replacement = null) {
  /** @type {string[]} */
  const matches = [];
  /** @param {unknown} value @param {string} path @param {string} [key]
   * @param {Record<string, any> | null} [parent] */
  const visit = (value, path, key = "", parent = null) => {
    if (typeof value === "string") {
      if (/color$/i.test(key) && value === id) {
        matches.push(path);
        if (replacement !== null && parent) parent[key] = replacement;
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([childKey, child]) => {
      visit(child, path ? `${path}.${childKey}` : childKey, childKey, value);
    });
  };
  Object.entries(project).forEach(([key, value]) => {
    if (key !== "colors") visit(value, key);
  });
  return matches;
}

/** @param {ColorProject} project @param {string} id
 * @param {string | null} [ignoredColorId] */
export function projectIdIsUsed(project, id, ignoredColorId = null) {
  if (projectWidgetEntries(project).some((entry) => entry.id === id)) return true;
  if ((project.pages || []).some((page) => page.id === id)) return true;
  const libraries = [project.styles, project.fonts, project.images];
  if (libraries.some((entries) => (entries || []).some((entry) => entry.id === id))) return true;
  if ((project.reserved_ids || []).includes(id)) return true;
  return (project.colors || []).some((entry) => entry.id === id && entry.id !== ignoredColorId);
}
