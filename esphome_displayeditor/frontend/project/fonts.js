// @ts-check

import { MDI_GLYPHS } from "../mdi-glyphs.js";

/** @typedef {{font_sources?: Record<string, any>, [key: string]: any}} ImportSource */
/** @typedef {{default_font?: string | null, import_source?: ImportSource,
 * [key: string]: any}} FontProject */
/** @typedef {(key: string, params: Record<string, unknown>) => string} Translate */

const mdiByName = new Map(MDI_GLYPHS.map((entry) => [entry.name.toLowerCase(), entry]));

/** @param {string} pathname @param {string} assetPath */
export function ingressAssetUrl(pathname, assetPath) {
  const appBase = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return `${appBase}${assetPath.replace(/^\//, "")}`;
}

/** @param {unknown} url */
export function isMdiWebfontUrl(url) {
  return /materialdesignicons-webfont\.ttf(\?.*)?$/i.test(String(url || "").trim());
}

/** @param {FontProject} project @param {string} id
 * @param {string | null} [replacement] @returns {string[]} */
export function fontReferenceLocations(project, id, replacement = null) {
  /** @type {string[]} */
  const matches = [];
  if (project.default_font === id) {
    matches.push("default_font");
    if (replacement !== null) project.default_font = replacement;
  }
  /** @param {unknown} value @param {string} path @param {string} [key]
   * @param {Record<string, any> | null} [parent] */
  const visit = (value, path, key = "", parent = null) => {
    if (typeof value === "string") {
      if (/font$/i.test(key) && value === id) {
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
    if (key !== "fonts" && key !== "default_font") visit(value, key);
  });
  return matches;
}

/** @param {FontProject} project @param {boolean} [create]
 * @returns {Record<string, any>} */
export function fontSourceMetadataMap(project, create = false) {
  if (!project.import_source || typeof project.import_source !== "object") {
    if (!create) return {};
    project.import_source = {};
  }
  if (!project.import_source.font_sources || typeof project.import_source.font_sources !== "object") {
    if (!create) return {};
    project.import_source.font_sources = {};
  }
  return project.import_source.font_sources;
}

/** @param {unknown} glyph @returns {number | undefined} */
export function glyphCodepoint(glyph) {
  return String(glyph || "").codePointAt(0);
}

/** @param {unknown} glyphOrCodepoint */
export function formatGlyphCodepoint(glyphOrCodepoint) {
  const value = typeof glyphOrCodepoint === "number"
    ? glyphOrCodepoint
    : glyphCodepoint(glyphOrCodepoint);
  return typeof value === "number" && Number.isInteger(value)
    ? `U+${value.toString(16).toUpperCase().padStart(4, "0")}` : "—";
}

/** @param {unknown[]} values @returns {string[]} */
export function uniqueGlyphs(values) {
  /** @type {string[]} */
  const result = [];
  /** @type {Set<number>} */
  const seen = new Set();
  values.flatMap((value) => Array.from(String(value || ""))).forEach((glyph) => {
    const codepoint = glyphCodepoint(glyph);
    if (codepoint === undefined || seen.has(codepoint)) return;
    seen.add(codepoint);
    result.push(glyph);
  });
  return result;
}

/** @param {unknown} value @param {Translate} translate @returns {string[]} */
export function parseGlyphInput(value, translate) {
  const input = String(value || "").trim();
  if (!input) return [];
  /** @type {string[]} */
  const glyphs = [];
  input.split(/[\s,;]+/).filter(Boolean).forEach((rawToken) => {
    const token = rawToken.replace(/^["']|["']$/g, "");
    const mdi = mdiByName.get(token.toLowerCase());
    if (mdi) {
      glyphs.push(mdi.glyph);
      return;
    }
    const codeMatch = token.match(/^(?:U\+|0x|\\U|\\u\{?)([0-9A-Fa-f]{4,8})\}?$/i);
    if (codeMatch) {
      const codepoint = Number.parseInt(codeMatch[1] || "", 16);
      if (codepoint > 0x10FFFF || (codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
        throw new Error(translate("validation.glyph.invalidCodepoint", { token }));
      }
      glyphs.push(String.fromCodePoint(codepoint));
      return;
    }
    if (/^mdi:/i.test(token)) {
      throw new Error(translate("validation.glyph.notInCatalog", { token }));
    }
    glyphs.push(...Array.from(token));
  });
  return uniqueGlyphs(glyphs);
}
