import { projectWidgetEntries } from "../project/model.js";

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

export function bindingIsOrphan(project, binding) {
  const widget = projectWidgetEntries(project).find((item) => item.id === binding.widget_id);
  return !widget || !runtimeTargets(widget, () => "").some((target) => target.value === binding.target);
}

export function runtimeStateFor(device, entityId) {
  return (device?.states || []).find((item) => item.entity_id === entityId) || null;
}

export function findRuntimeBinding(bindings, widgetId, target) {
  return bindings.find((binding) => binding.widget_id === widgetId && binding.target === target) || null;
}

export function assignRuntimeBinding(bindings, widgetIds, binding) {
  const ids = new Set(widgetIds);
  return [
    ...bindings.filter((item) => !(ids.has(item.widget_id) && item.target === binding.target)),
    ...widgetIds.map((widgetId) => ({ ...binding, widget_id: widgetId })),
  ];
}

export function removeRuntimeBinding(bindings, widgetId, target) {
  return bindings.filter((binding) => !(binding.widget_id === widgetId && binding.target === target));
}

export function cleanRuntimeBindings(project, bindings) {
  return bindings.filter((binding) => !bindingIsOrphan(project, binding));
}

export function canPasteRuntimeBinding(widget, binding) {
  return Boolean(
    widget
    && binding
    && runtimeTargets(widget, () => "").some((target) => target.value === binding.target)
  );
}
