// @ts-check

import { normalizeProjectSurfaces } from "./model.js";

/** @typedef {{widgets: any[], style_tree?: Record<string, any>,
 * layout?: Record<string, any>, [key: string]: any}} Surface */
/** @typedef {Surface & {canvas: {width: number, height: number}, pages: (Surface & {id: string, skip?: boolean})[],
 * bottom_layer?: Surface | null, top_layer?: Surface | null,
 * extra_lvgl?: Record<string, any>}} SurfaceProject */
/** @typedef {{key: string, kind: string, label: string, surface: Surface,
 * index?: number}} SurfaceEntry */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */

/** @param {SurfaceProject} project @param {Translate} translate
 * @returns {SurfaceEntry[]} */
export function surfaceEntries(project, translate) {
  normalizeProjectSurfaces(project);
  /** @type {SurfaceEntry[]} */
  const entries = [];
  if (!project.pages.length || project.widgets.length) {
    entries.push({ key: "root", kind: "root", label: translate("surface.root"), surface: project });
  }
  if (project.bottom_layer) {
    entries.push({ key: "bottom", kind: "bottom", label: "Bottom-Layer", surface: project.bottom_layer });
  }
  project.pages.forEach((page, index) => entries.push({
    key: `page:${page.id}`,
    kind: "page",
    label: translate("surface.page", { n: index + 1, id: page.id })
      + (page.skip ? translate("surface.pageSkippedSuffix") : ""),
    surface: page,
    index,
  }));
  if (project.top_layer) {
    entries.push({ key: "top", kind: "top", label: "Top-Layer", surface: project.top_layer });
  }
  return entries;
}

/** @param {SurfaceProject} project @param {string} activeKey
 * @param {Translate} translate */
export function resolveActiveSurface(project, activeKey, translate) {
  const entries = surfaceEntries(project, translate);
  const key = entries.some((entry) => entry.key === activeKey)
    ? activeKey
    : entries.find((entry) => entry.kind === "page")?.key || entries[0]?.key || "root";
  return {
    key,
    entry: entries.find((entry) => entry.key === key)
      || { key: "root", kind: "root", label: translate("surface.root"), surface: project },
  };
}

/** @param {SurfaceProject} project @param {SurfaceEntry | {kind: string, surface?: Surface}} entry */
export function surfaceLayoutProject(project, entry) {
  if (entry.kind === "root") return project;
  return {
    ...project,
    widgets: entry.surface?.widgets || [],
    extra_lvgl: {
      ...(project.extra_lvgl || {}),
      ...(entry.surface?.style_tree || {}),
      layout: entry.surface?.layout || {},
    },
  };
}
