import assert from "node:assert/strict";
import test from "node:test";
import { createI18n } from "../../frontend/i18n/runtime.js";

test("i18n runtime detects, persists, interpolates and falls back", () => {
  const values = new Map([["esphome_de_app_lang", "en"]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const runtime = createI18n({ storage, browserLanguage: "de", strings: { de: { hello: "Hallo {name}", fallback: "Nur deutsch" }, en: { hello: "Hello {name}" } } });
  assert.equal(runtime.t("hello", { name: "Ada" }), "Hello Ada");
  assert.equal(runtime.t("fallback"), "Nur deutsch");
  runtime.setLanguage("de");
  assert.equal(values.get("esphome_de_app_lang"), "de");
  assert.equal(runtime.t("missing"), "missing");
});
