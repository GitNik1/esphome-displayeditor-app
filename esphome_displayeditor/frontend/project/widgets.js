// @ts-check

import { actionObjectEntry } from "../actions/model.js";
import { collectProjectWidgets, projectWidgetEntries } from "./model.js";

/** @typedef {Record<string, any>} WidgetAction */
/** @typedef {{id: string, widget_type: string, children?: Widget[],
 * align_to?: string, events?: Record<string, WidgetAction | WidgetAction[]>,
 * [key: string]: any}} Widget */
/** @typedef {Widget} CloneableWidget */
/** @typedef {{widget_id: string, [key: string]: any}} WidgetBinding */
/** @typedef {{glow_strokes?: {parent_id?: string}[], reserved_ids?: string[],
 * [key: string]: any}} WidgetProject */

/** @param {WidgetAction} action @param {string} previousId @param {string} nextId */
export function replaceActionTargetReference(action, previousId, nextId) {
  const entry = actionObjectEntry(action);
  if (!entry) return;
  const [name, payload] = entry;
  if (name === "if" && payload && typeof payload === "object") {
    [payload.then, payload.else].forEach((branch) => {
      const actions = Array.isArray(branch) ? branch : branch ? [branch] : [];
      actions.forEach((nested) => replaceActionTargetReference(nested, previousId, nextId));
    });
    return;
  }
  if (["lvgl.widget.show", "lvgl.widget.hide", "lvgl.page.show"].includes(name)) {
    if (payload === previousId) action[name] = nextId;
    else if (Array.isArray(payload)) {
      action[name] = payload.map((/** @type {unknown} */ item) => item === previousId ? nextId : item);
    } else if (payload && typeof payload === "object") {
      if (payload.id === previousId) payload.id = nextId;
      else if (Array.isArray(payload.id)) {
        payload.id = payload.id.map((/** @type {unknown} */ item) => item === previousId ? nextId : item);
      }
    }
    return;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.id === previousId) payload.id = nextId;
    else if (Array.isArray(payload.id)) {
      payload.id = payload.id.map((/** @type {unknown} */ item) => item === previousId ? nextId : item);
    }
  }
}

/** @param {WidgetProject} project @param {WidgetBinding[]} bindings
 * @param {string} previousId @param {string} nextId */
export function replaceProjectWidgetReferences(project, bindings, previousId, nextId) {
  /** @type {Widget[]} */ (projectWidgetEntries(project)).forEach((item) => {
    if (item.align_to === previousId) item.align_to = nextId;
    Object.values(item.events || {}).forEach((raw) => {
      const actions = Array.isArray(raw) ? raw : [raw];
      actions.forEach((action) => replaceActionTargetReference(action, previousId, nextId));
    });
  });
  (project.glow_strokes || []).forEach((stroke) => {
    if (stroke.parent_id === previousId) stroke.parent_id = nextId;
  });
  bindings.forEach((binding) => {
    if (binding.widget_id === previousId) binding.widget_id = nextId;
  });
}

/** @param {Widget[]} nodes @param {Widget} target @returns {boolean} */
export function removeWidget(nodes, target) {
  const index = nodes.indexOf(target);
  if (index >= 0) {
    nodes.splice(index, 1);
    return true;
  }
  return nodes.some((widget) => removeWidget(widget.children || [], target));
}

/** @param {Widget[]} nodes @param {Widget} target
 * @returns {{array: Widget[], index: number} | null} */
export function findWidgetLocation(nodes, target) {
  const index = nodes.indexOf(target);
  if (index >= 0) return { array: nodes, index };
  for (const node of nodes) {
    const found = findWidgetLocation(node.children || [], target);
    if (found) return found;
  }
  return null;
}

/** @param {Widget[]} nodes @param {Widget} target @param {string} [parentId]
 * @returns {string | null} */
export function findParentContainerId(nodes, target, parentId = "") {
  if (nodes.includes(target)) return parentId;
  for (const node of nodes) {
    const found = findParentContainerId(node.children || [], target, node.id);
    if (found !== null) return found;
  }
  return null;
}

/** @param {WidgetProject} project @param {CloneableWidget} widget
 * @returns {CloneableWidget} */
export function cloneWidgetSubtree(project, widget) {
  const usedIds = new Set([
    .../** @type {Widget[]} */ (collectProjectWidgets(project)).map((item) => item.id),
    ...(project.reserved_ids || []),
  ]);
  /** @param {CloneableWidget} node */
  const assignIds = (node) => {
    let number = 1;
    let candidate = `${node.widget_type}_${number}`;
    while (usedIds.has(candidate)) candidate = `${node.widget_type}_${++number}`;
    node.id = candidate;
    usedIds.add(candidate);
    (node.children || []).forEach(assignIds);
  };
  const clone = /** @type {CloneableWidget} */ (JSON.parse(JSON.stringify(widget)));
  assignIds(clone);
  return clone;
}
