// @ts-check

import { computeLayout } from "../layout.js";

/** @param {any} tileviewWidget @param {Record<string, string>} activeTiles */
export function activeTileFor(tileviewWidget, activeTiles) {
  const children = tileviewWidget.children || [];
  if (!children.length) return null;
  const explicitId = activeTiles?.[tileviewWidget.id];
  const explicit = explicitId && children.find((/** @type {any} */ tile) => tile.id === explicitId);
  if (explicit) return explicit;
  return children.find((/** @type {any} */ tile) => (tile.tile_row || 0) === 0 && (tile.tile_col || 0) === 0)
    || children[0];
}

/** @param {any} tabviewWidget @param {Record<string, string>} activeTabs */
export function activeTabFor(tabviewWidget, activeTabs) {
  const children = tabviewWidget.children || [];
  if (!children.length) return null;
  const explicitId = activeTabs?.[tabviewWidget.id];
  const explicit = explicitId && children.find((/** @type {any} */ tab) => tab.id === explicitId);
  return explicit || children[0];
}

/** @param {any} project @param {Record<string, string>} [activeTiles]
 * @param {Record<string, string>} [activeTabs] */
export function allWidgetItems(project, activeTiles = {}, activeTabs = {}) {
  const boxes = computeLayout(project);
  /** @type {any[]} */
  const result = [];
  /** @param {any[]} widgets @param {boolean} [ancestorHidden] @param {any} [parent] */
  const visit = (widgets, ancestorHidden = false, parent = null) => {
    (widgets || []).forEach((widget) => {
      const hidden = ancestorHidden || Boolean(widget.hidden);
      const box = boxes.get(widget) || {
        left: Number(widget.x) || 0, top: Number(widget.y) || 0,
        width: Number(widget.width) || 100, height: Number(widget.height) || 40,
      };
      if (widget.widget_type === "tile" || widget.widget_type === "tab") {
        visit(widget.children, hidden, parent);
        return;
      }
      result.push({ widget, box, hidden, parent });
      if (widget.widget_type === "tileview") {
        const active = activeTileFor(widget, activeTiles);
        (widget.children || []).forEach((/** @type {any} */ tile) => visit([tile], hidden || tile !== active, widget));
      } else if (widget.widget_type === "tabview") {
        const active = activeTabFor(widget, activeTabs);
        (widget.children || []).forEach((/** @type {any} */ tab) => visit([tab], hidden || tab !== active, widget));
      } else visit(widget.children, hidden, widget);
    });
  };
  visit(project.widgets || []);
  return result;
}

/** @param {any} project */
export function viewerWidgetRoots(project) {
  const roots = [...(project.widgets || [])];
  (project.pages || []).forEach((/** @type {any} */ page) => roots.push(...(page.widgets || [])));
  roots.push(...(project.bottom_layer?.widgets || []), ...(project.top_layer?.widgets || []));
  (project.msgboxes || []).forEach((/** @type {any} */ msgbox) => {
    roots.push(...(msgbox.buttons || []), ...(msgbox.header_buttons || []));
  });
  return roots;
}

/** @param {any} project @param {any} surface */
export function surfaceProject(project, surface) {
  return { ...project, widgets: surface.widgets || [], extra_lvgl: { ...(surface.style_tree || {}), layout: surface.layout || {} } };
}

/** @param {any} project @param {string} activePageId */
export function viewerSurfaces(project, activePageId) {
  /** @type {{kind: string, surface: any}[]} */
  const surfaces = [];
  if (project.bottom_layer) surfaces.push({ kind: "bottom", surface: project.bottom_layer });
  if ((project.pages || []).length) {
    const active = project.pages.find((/** @type {any} */ page) => page.id === activePageId) || project.pages[0];
    if (active) surfaces.push({ kind: "page", surface: active });
  } else {
    surfaces.push({ kind: "root", surface: { widgets: project.widgets || [], layout: project.extra_lvgl?.layout || {}, style_tree: project.extra_lvgl || {} } });
  }
  if (project.top_layer) surfaces.push({ kind: "top", surface: project.top_layer });
  return surfaces;
}
