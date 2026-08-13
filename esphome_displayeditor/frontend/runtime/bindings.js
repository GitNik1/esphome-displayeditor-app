// @ts-check

import { projectWidgetEntries } from "../project/model.js";

/** @typedef {{id?: string, widget_type: string, [key: string]: any}} RuntimeWidget */
/** @typedef {{widget_id: string, target: string, entity_id?: string,
 * device_id?: string, [key: string]: any}} RuntimeBinding */
/** @typedef {{entity_id: string, [key: string]: any}} RuntimeState */
/** @typedef {{states?: RuntimeState[]}} RuntimeDevice */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {{value: string, label: string}} RuntimeTarget */

/** @param {RuntimeWidget | null | undefined} widget @param {Translate} translate
 * @returns {RuntimeTarget[]} */
export function runtimeTargets(widget, translate) {
  if (!widget) return [];
  if (["label", "textarea"].includes(widget.widget_type)) {
    return [{ value: "text", label: translate("binding.target.text") }];
  }
  if (["slider", "bar", "arc"].includes(widget.widget_type)) {
    const typeName = widget.widget_type === "slider" ? "Slider" : widget.widget_type === "bar" ? "Bar" : "Arc";
    return [{ value: "value", label: translate("binding.target.value", { type: typeName }) }];
  }
  if (["switch", "checkbox"].includes(widget.widget_type)) {
    const typeName = widget.widget_type === "switch" ? "Switch" : "Checkbox";
    return [{ value: "state_checked", label: translate("binding.target.state", { type: typeName }) }];
  }
  if (["dropdown", "roller"].includes(widget.widget_type)) {
    const typeName = widget.widget_type === "dropdown" ? "Dropdown" : "Roller";
    return [{ value: "selected_index", label: translate("binding.target.value", { type: typeName }) }];
  }
  return [];
}

/** @param {any} project @param {RuntimeBinding} binding */
export function bindingIsOrphan(project, binding) {
  const widget = projectWidgetEntries(project).find((item) => item.id === binding.widget_id);
  return !widget || !widget.widget_type
    || !runtimeTargets(/** @type {RuntimeWidget} */ (widget), () => "")
      .some((target) => target.value === binding.target);
}

/** @param {RuntimeDevice | null | undefined} device @param {string} entityId */
export function runtimeStateFor(device, entityId) {
  return (device?.states || []).find((item) => item.entity_id === entityId) || null;
}

/** @param {RuntimeBinding[]} bindings @param {string} widgetId @param {string} target */
export function findRuntimeBinding(bindings, widgetId, target) {
  return bindings.find((binding) => binding.widget_id === widgetId && binding.target === target) || null;
}

/** @param {RuntimeBinding[]} bindings @param {string[]} widgetIds
 * @param {RuntimeBinding} binding @returns {RuntimeBinding[]} */
export function assignRuntimeBinding(bindings, widgetIds, binding) {
  const ids = new Set(widgetIds);
  return [
    ...bindings.filter((item) => !(ids.has(item.widget_id) && item.target === binding.target)),
    ...widgetIds.map((widgetId) => ({ ...binding, widget_id: widgetId })),
  ];
}

/** @param {RuntimeBinding[]} bindings @param {string} widgetId @param {string} target */
export function removeRuntimeBinding(bindings, widgetId, target) {
  return bindings.filter((binding) => !(binding.widget_id === widgetId && binding.target === target));
}

/** @param {any} project @param {RuntimeBinding[]} bindings */
export function cleanRuntimeBindings(project, bindings) {
  return bindings.filter((binding) => !bindingIsOrphan(project, binding));
}

/** @param {RuntimeWidget | null | undefined} widget
 * @param {RuntimeBinding | null | undefined} binding */
export function canPasteRuntimeBinding(widget, binding) {
  return Boolean(
    widget
    && binding
    && runtimeTargets(widget, () => "").some((target) => target.value === binding.target)
  );
}
