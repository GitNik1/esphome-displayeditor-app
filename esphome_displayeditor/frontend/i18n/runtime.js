// @ts-check

import { STRINGS } from "../i18n.js";

/** @typedef {"de" | "en"} Language */
/** @typedef {Record<Language, Record<string, string>>} TranslationTable */
/** @typedef {{getItem?: (key: string) => unknown,
 * setItem?: (key: string, value: string) => unknown}} StorageLike */
/** @typedef {{storage?: StorageLike, browserLanguage?: string,
 * strings?: TranslationTable}} I18nOptions */

const STORAGE_KEY = "esphome_de_app_lang";

/** @param {I18nOptions} [options] */
export function createI18n({ storage, browserLanguage = "de", strings = STRINGS } = {}) {
  /** @returns {Language} */
  const detect = () => {
    try {
      const stored = storage?.getItem?.(STORAGE_KEY);
      if (stored === "de" || stored === "en") return stored;
    } catch { /* best-effort storage */ }
    return String(browserLanguage || "de").toLowerCase().startsWith("en") ? "en" : "de";
  };
  let language = detect();
  return {
    getLanguage: () => language,
    /** @param {string} value */
    setLanguage(value) {
      language = value === "en" ? "en" : "de";
      try { storage?.setItem?.(STORAGE_KEY, language); } catch { /* best-effort storage */ }
    },
    /** @param {string} key @param {Record<string, unknown>} [params] */
    t(key, params) {
      let value = strings[language]?.[key] ?? strings.de[key] ?? key;
      for (const [name, replacement] of Object.entries(params || {})) {
        value = value.replaceAll(`{${name}}`, String(replacement));
      }
      return value;
    },
  };
}

const runtime = createI18n({
  storage: globalThis.window?.localStorage,
  browserLanguage: globalThis.navigator?.language,
});

export const getLanguage = runtime.getLanguage;
export const setLanguage = runtime.setLanguage;
export const t = runtime.t;

/** @param {ParentNode} [root] */
export function applyStaticTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.getAttribute("data-i18n") || "");
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((element) => {
    (element.getAttribute("data-i18n-attr") || "").split(";").filter(Boolean).forEach((pair) => {
      const [attribute, key] = pair.split(":");
      if (attribute && key) element.setAttribute(attribute.trim(), t(key.trim()));
    });
  });
}
