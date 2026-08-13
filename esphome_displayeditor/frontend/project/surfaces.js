import { normalizeProjectSurfaces } from "./model.js";

export function surfaceEntries(project, translate) {
  normalizeProjectSurfaces(project);
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

export function surfaceLayoutProject(project, entry) {
  if (entry.kind === "root") return project;
  return {
    ...project,
    widgets: entry.surface.widgets,
    extra_lvgl: {
      ...(project.extra_lvgl || {}),
      ...(entry.surface.style_tree || {}),
      layout: entry.surface.layout || {},
    },
  };
}

