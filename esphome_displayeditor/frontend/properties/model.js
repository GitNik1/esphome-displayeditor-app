export const LIST_KINDS = ["grid_track_list", "image_ref_list", "text_list"];

export function propertyTarget(widget, property, create, kind = property.category, activeState = "") {
  if (kind === "content") return widget.properties;
  if (kind === "layout") {
    if (!widget.layout && create) widget.layout = {};
    return widget.layout;
  }
  if (kind === "grid_cell") {
    if (!widget.grid_cell && create) widget.grid_cell = {};
    return widget.grid_cell;
  }
  let root = widget.style_tree;
  if (activeState) {
    if (!root.states && create) root.states = {};
    if (!root.states?.[activeState] && create) root.states[activeState] = {};
    root = root.states?.[activeState];
  }
  if (!root) return undefined;
  if (property.part === "main") return root;
  if (!root[property.part] && create) root[property.part] = {};
  return root[property.part];
}

export function parseListValue(property, text) {
  const items = String(text).split(",").map((part) => part.trim()).filter(Boolean);
  if (property.kind !== "grid_track_list") return items;
  return items.map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
}

export function propertyInputValue(property, control) {
  if (property.kind === "bool") return control.checked;
  if (LIST_KINDS.includes(property.kind)) return parseListValue(property, control.value);
  if (["int", "float"].includes(property.kind)) return control.value === "" ? null : Number(control.value);
  return control.value;
}

export function propertyValueClears(value) {
  return value === "" || value === null || (Array.isArray(value) && value.length === 0);
}
