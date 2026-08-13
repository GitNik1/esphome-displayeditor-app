import assert from "node:assert/strict";
import test from "node:test";

import {
  fontReferenceLocations,
  fontSourceMetadataMap,
  formatGlyphCodepoint,
  ingressAssetUrl,
  isMdiWebfontUrl,
  parseGlyphInput,
  uniqueGlyphs,
} from "../../frontend/project/fonts.js";
import { freshProject } from "../../frontend/project/model.js";

test("font URLs remain ingress-relative and MDI URLs are recognized", () => {
  assert.equal(ingressAssetUrl("/ingress/token", "vendor/font.ttf"), "/ingress/token/vendor/font.ttf");
  assert.equal(isMdiWebfontUrl("https://example.test/materialdesignicons-webfont.ttf?v=1"), true);
  assert.equal(isMdiWebfontUrl("other.ttf"), false);
});

test("font references are located and replaced outside the font library", () => {
  const project = freshProject();
  project.default_font = "body";
  project.fonts = [{ id: "body" }];
  project.widgets = [{ id: "label", style_tree: { text_font: "body" } }];
  assert.deepEqual(fontReferenceLocations(project, "body"), [
    "default_font", "widgets.0.style_tree.text_font",
  ]);
  fontReferenceLocations(project, "body", "heading");
  assert.equal(project.default_font, "heading");
  assert.equal(project.widgets[0].style_tree.text_font, "heading");
  assert.equal(project.fonts[0].id, "body");
});

test("font source metadata is created only when requested", () => {
  const project = freshProject();
  assert.deepEqual(fontSourceMetadataMap(project), {});
  const metadata = fontSourceMetadataMap(project, true);
  metadata.body = { url: "https://example.test/font.ttf" };
  assert.equal(project.import_source.font_sources.body.url, "https://example.test/font.ttf");
});

test("glyph parsing supports unicode notation, catalog names and deduplication", () => {
  const translate = (key, values) => `${key}:${values.token}`;
  const glyphs = parseGlyphInput("U+0041 0x0041 mdi:home", translate);
  assert.equal(glyphs[0], "A");
  assert.equal(glyphs.length, 2);
  assert.equal(formatGlyphCodepoint("😀"), "U+1F600");
  assert.deepEqual(uniqueGlyphs(["AA", "😀😀"]), ["A", "😀"]);
  assert.throws(() => parseGlyphInput("U+110000", translate), /invalidCodepoint/);
  assert.throws(() => parseGlyphInput("mdi:not-real", translate), /notInCatalog/);
});

