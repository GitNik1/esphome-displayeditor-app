// @ts-check

/** @typedef {{id: string, domain?: string, readable?: boolean, writable?: boolean, [key: string]: any}} Entity */
/** @typedef {{widget_type: string, [key: string]: any}} Widget */
/** @typedef {{id: string, direction: string, source: Record<string, any>, target: Record<string, any>, [key: string]: any}} DeviceBinding */

/** @type {Record<string, string[]>} */
const INPUTS = {
  label: ["text", "visible", "opacity", "color"], textarea: ["text", "visible"],
  meter: ["indicator_value", "indicator_start", "indicator_end", "visible", "opacity"],
  bar: ["value", "visible", "opacity", "color"], led: ["value", "visible", "opacity", "color"],
  image: ["image", "visible", "opacity"], animimg: ["visible", "opacity", "flow_direction"],
  button: ["text", "checked", "visible", "opacity", "color"], switch: ["checked", "visible"],
  checkbox: ["checked", "text", "visible"], slider: ["value", "visible"],
  arc: ["value", "visible", "color"], dropdown: ["selected", "visible"],
  roller: ["selected", "visible"], spinbox: ["value", "visible"], qrcode: ["text", "visible"],
  tabview: ["selected", "visible"], tileview: ["selected", "visible"],
  obj: ["visible", "opacity", "color"], container: ["visible", "opacity", "color"],
};
/** @type {Record<string, string[]>} */
const OUTPUTS = {
  button: ["click", "press", "release", "value"], switch: ["value"], checkbox: ["value"],
  slider: ["value", "release"], arc: ["value", "release"], dropdown: ["value"],
  roller: ["value"], spinbox: ["value"], textarea: ["value"],
  label: ["click"], image: ["click"], animimg: ["click"], led: ["click"],
  qrcode: ["click"], tabview: ["value"], tileview: ["value"],
  obj: ["click", "press", "release"], container: ["click", "press", "release"],
};

/** @param {Widget | null | undefined} widget @param {string} direction @returns {string[]} */
export function deviceBindingTargets(widget, direction) {
  if (!widget) return [];
  if (direction === "widget_to_entity") return OUTPUTS[widget.widget_type] || [];
  return INPUTS[widget.widget_type] || [];
}

/** @param {Entity[]} entities @param {string} direction @returns {Entity[]} */
export function compatibleEntities(entities, direction) {
  return (entities || []).filter((entity) => direction === "entity_to_widget"
    ? entity.readable : direction === "widget_to_entity" ? entity.writable
      : entity.readable && entity.writable);
}

/** @param {DeviceBinding[]} bindings @param {DeviceBinding} binding @returns {DeviceBinding[]} */
export function upsertDeviceBinding(bindings, binding) {
  return [...(bindings || []).filter((item) => item.id !== binding.id), binding];
}

/** @param {DeviceBinding[]} bindings @param {string} id @returns {DeviceBinding[]} */
export function removeDeviceBinding(bindings, id) {
  return (bindings || []).filter((item) => item.id !== id);
}

/** @param {DeviceBinding[]} bindings @param {string} widgetId @returns {DeviceBinding[]} */
export function bindingsForWidget(bindings, widgetId) {
  return (bindings || []).filter((binding) => binding.source?.widget_id === widgetId
    || binding.target?.widget_id === widgetId);
}

/** @param {string} widgetId @param {string} entityId */
export function defaultBindingId(widgetId, entityId) {
  return `bind_${widgetId}_${entityId}`.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]/, "b_");
}

/** @param {DeviceBinding[]} bindings */
export function bindingGraph(bindings) {
  /** @type {Map<string, {id: string, kind: string, label: string}>} */
  const nodes = new Map();
  /** @type {{id: string, from: string, to: string, bidirectional: boolean}[]} */
  const edges = [];
  (bindings || []).forEach((binding) => {
    if (binding.deleted) return;
    const widget = binding.direction === "widget_to_entity" ? binding.source : binding.target;
    const entity = binding.direction === "widget_to_entity" ? binding.target : binding.source;
    const widgetId = `widget:${widget.widget_id}`;
    const entityId = `entity:${entity.domain}.${entity.id}`;
    nodes.set(widgetId, { id: widgetId, kind: "widget", label: widget.widget_id });
    nodes.set(entityId, { id: entityId, kind: "entity", label: `${entity.domain}.${entity.id}` });
    edges.push({
      id: binding.id,
      from: binding.direction === "widget_to_entity" ? widgetId : entityId,
      to: binding.direction === "widget_to_entity" ? entityId : widgetId,
      bidirectional: binding.direction === "bidirectional",
    });
  });
  return { nodes: [...nodes.values()], edges };
}
