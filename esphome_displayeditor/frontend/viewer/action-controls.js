// @ts-check

import {
  findViewerWidget,
  navigateViewerPage,
  viewerActionIds,
  viewerPageActionId,
} from "./action-model.js";

/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {{handled: boolean, changed: boolean, warning?: boolean, message: string}} ActionResult */

/** @param {any} project @param {any} runtime @param {string} name @param {any} payload
 * @param {Translate} translate @returns {ActionResult | null} */
export function applyViewerControl(project, runtime, name, payload, translate) {
  if (name === "lvgl.page.show") {
    const id = viewerPageActionId(payload);
    const page = (project.pages || []).find((/** @type {any} */ entry) => entry.id === id);
    if (!page) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.pageNotFound", { id: id || translate("viewer.event.noId") }),
    };
    const changed = runtime.activePageId !== page.id;
    runtime.activePageId = page.id;
    return { handled: true, changed, message: `lvgl.page.show: ${page.id}` };
  }

  if (["lvgl.page.next", "lvgl.page.previous"].includes(name)) {
    const page = navigateViewerPage(project, runtime, name.endsWith(".next") ? 1 : -1);
    if (!page) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.noReachablePage", { name }),
    };
    const changed = runtime.activePageId !== page.id;
    runtime.activePageId = page.id;
    return { handled: true, changed, message: `${name}: ${page.id}` };
  }

  if (name === "lvgl.tileview.select") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: translate("viewer.event.invalidAction") };
    }
    const tileviewId = String(payload.id || "");
    const tileview = findViewerWidget(project, tileviewId);
    if (!tileview || tileview.widget_type !== "tileview") return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.updateNotFound", { id: tileviewId || translate("viewer.event.noId") }),
    };
    const children = tileview.children || [];
    let target = payload.tile_id
      ? children.find((/** @type {any} */ tile) => tile.id === String(payload.tile_id))
      : null;
    if (!target && (payload.row !== undefined || payload.column !== undefined)) {
      const row = Number(payload.row) || 0;
      const column = Number(payload.column) || 0;
      target = children.find((/** @type {any} */ tile) => (
        (tile.tile_row || 0) === row && (tile.tile_col || 0) === column
      ));
    }
    if (!target) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.updateNotFound", { id: tileviewId }),
    };
    runtime.activeTiles ||= {};
    const changed = runtime.activeTiles[tileviewId] !== target.id;
    runtime.activeTiles[tileviewId] = target.id;
    return { handled: true, changed, message: `lvgl.tileview.select: ${target.id}` };
  }

  if (name === "lvgl.tabview.select") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: translate("viewer.event.invalidAction") };
    }
    const tabviewId = String(payload.id || "");
    const tabview = findViewerWidget(project, tabviewId);
    if (!tabview || tabview.widget_type !== "tabview") return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.updateNotFound", { id: tabviewId || translate("viewer.event.noId") }),
    };
    const index = Number(payload.index);
    const target = Number.isInteger(index) ? (tabview.children || [])[index] : undefined;
    if (!target) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.updateNotFound", { id: tabviewId }),
    };
    runtime.activeTabs ||= {};
    const changed = runtime.activeTabs[tabviewId] !== target.id;
    runtime.activeTabs[tabviewId] = target.id;
    return { handled: true, changed, message: `lvgl.tabview.select: ${target.id}` };
  }

  if (["lvgl.spinbox.increment", "lvgl.spinbox.decrement"].includes(name)) {
    const direction = name.endsWith(".increment") ? 1 : -1;
    const ids = viewerActionIds(payload);
    let changed = false;
    /** @type {string[]} */
    const rejected = [];
    ids.forEach((id) => {
      const widget = findViewerWidget(project, id);
      if (!widget || widget.widget_type !== "spinbox") {
        rejected.push(id);
        return;
      }
      widget.properties ||= {};
      const decimals = Number(widget.properties.decimal_places) || 0;
      const step = decimals > 0 ? 1 / (10 ** decimals) : 1;
      widget.properties.value = Number(widget.properties.value || 0) + direction * step;
      changed = true;
    });
    if (!ids.length) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.noValidWidgetId", { name }),
    };
    const detail = rejected.length ? translate("viewer.event.notFoundSuffix", { ids: rejected.join(", ") }) : "";
    return { handled: true, changed, warning: Boolean(rejected.length), message: `${name}: ${ids.join(", ")}${detail}` };
  }

  if (["lvgl.widget.show", "lvgl.widget.hide"].includes(name)) {
    const hidden = name.endsWith(".hide");
    const ids = viewerActionIds(payload);
    let changed = false;
    /** @type {string[]} */
    const missing = [];
    ids.forEach((id) => {
      const widget = findViewerWidget(project, id);
      if (!widget) missing.push(id);
      else {
        widget.hidden = hidden;
        changed = true;
      }
    });
    if (!ids.length) return {
      handled: true, changed: false, warning: true,
      message: translate("viewer.event.noValidWidgetId", { name }),
    };
    const suffix = missing.length ? translate("viewer.event.notFoundSuffix", { ids: missing.join(", ") }) : "";
    return { handled: true, changed, warning: Boolean(missing.length), message: `${name}: ${ids.join(", ")}${suffix}` };
  }

  if (["lvgl.animation.start", "lvgl.animation.stop", "lvgl.animimg.start", "lvgl.animimg.stop"].includes(name)) {
    const running = name.endsWith(".start");
    const ids = viewerActionIds(payload);
    let changed = false;
    /** @type {string[]} */
    const rejected = [];
    ids.forEach((id) => {
      const widget = findViewerWidget(project, id);
      if (!widget || widget.widget_type !== "animimg") rejected.push(id);
      else {
        widget.properties ||= {};
        widget.properties.auto_start = running;
        changed = true;
      }
    });
    const detail = rejected.length ? translate("viewer.event.notAnimimgSuffix", { ids: rejected.join(", ") }) : "";
    return {
      handled: true, changed, warning: Boolean(rejected.length || !ids.length),
      message: `${name}: ${ids.join(", ") || translate("viewer.event.noValidWidgetIdFallback")}${detail}`,
    };
  }

  return null;
}
