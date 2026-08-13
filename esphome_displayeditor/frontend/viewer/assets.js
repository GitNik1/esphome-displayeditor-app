// @ts-check

import { fontFamilyId, resolvedFontFamily } from "../layout.js";

export const VIEWER_FONT_LOADED_EVENT = "esphome-viewer-font-loaded";
/** @type {Map<string, "loading" | "loaded" | "failed">} */
const fontLoadState = new Map();

/** @param {unknown} filePath @param {string} [pathname] */
export function resolveViewerAssetUrl(filePath, pathname = window.location.pathname) {
  const path = String(filePath || "");
  if (/^https?:\/\//i.test(path)) return path;
  if (!path) return null;
  const appBase = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${appBase}api/v1/designer/assets/read/${encoded}`;
}

/** @param {any} project @param {string} fontId */
export function ensureViewerFontLoaded(project, fontId) {
  if (!fontId || fontLoadState.has(fontId)) return;
  const entry = (project.fonts || []).find((/** @type {any} */ font) => font.id === fontId);
  const source = entry?.file_path || entry?.web_url;
  if (!source) return;
  const url = resolveViewerAssetUrl(source);
  if (!url) return;
  fontLoadState.set(fontId, "loading");
  const face = new FontFace(fontFamilyId(fontId), `url(${JSON.stringify(url)})`);
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    fontLoadState.set(fontId, "loaded");
    document.dispatchEvent(new CustomEvent(VIEWER_FONT_LOADED_EVENT));
  }).catch(() => fontLoadState.set(fontId, "failed"));
}

/** @param {any} project @param {unknown} reference */
export function viewerFont(project, reference) {
  if (!reference) return null;
  const raw = String(reference);
  const entry = (project.fonts || []).find((/** @type {any} */ font) => font.id === raw);
  const inferredSize = Number.parseInt(raw.match(/(\d+)(?!.*\d)/)?.[1] || "", 10);
  const namedFamily = entry?.gfonts_family || entry?.builtin_name || null;
  const hasRealFile = Boolean(entry?.file_path || entry?.web_url);
  if (!namedFamily && hasRealFile) ensureViewerFontLoaded(project, raw);
  return {
    family: namedFamily,
    familyCss: namedFamily ? null : (hasRealFile ? resolvedFontFamily(raw) : null),
    size: Number(entry?.size) || inferredSize || null,
    weight: Number(entry?.gfonts_weight) || null,
    italic: Boolean(entry?.gfonts_italic),
  };
}

/** @param {any} project @param {unknown} id */
export function viewerImageSource(project, id) {
  const entry = (project.images || []).find((/** @type {any} */ image) => image.id === id);
  return resolveViewerAssetUrl(entry?.file_path);
}
