// @ts-check

/** @typedef {{kind?: string, category?: string, part?: string}} PropertySchema */
/** @typedef {Record<string, any> & {states?: Record<string, Record<string, any>>}} StyleTree */
/** @typedef {{properties: Record<string, any>, layout?: Record<string, any>,
 * grid_cell?: Record<string, any>, style_tree: StyleTree}} PropertyWidget */

/** @type {string[]} */
export const LIST_KINDS = ["grid_track_list", "image_ref_list", "text_list"];

/** @param {PropertyWidget} widget @param {PropertySchema} property
 * @param {boolean} create @param {string} [kind] @param {string} [activeState] */
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
    if (!root.states) {
      if (!create) return undefined;
      root.states = {};
    }
    let stateRoot = root.states[activeState];
    if (!stateRoot) {
      if (!create) return undefined;
      stateRoot = {};
      root.states[activeState] = stateRoot;
    }
    root = stateRoot;
  }
  if (!root) return undefined;
  const part = property.part || "main";
  if (part === "main") return root;
  if (!root[part] && create) root[part] = {};
  return root[part];
}

/** @param {PropertySchema} property @param {unknown} text
 * @returns {(string | number)[]} */
export function parseListValue(property, text) {
  const items = String(text).split(",").map((part) => part.trim()).filter(Boolean);
  if (property.kind !== "grid_track_list") return items;
  return items.map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
}

/** @param {PropertySchema} property
 * @param {{checked?: boolean, value?: string}} control */
export function propertyInputValue(property, control) {
  if (property.kind === "bool") return control.checked;
  if (LIST_KINDS.includes(property.kind || "")) return parseListValue(property, control.value);
  if (["int", "float"].includes(property.kind || "")) return control.value === "" ? null : Number(control.value);
  return control.value;
}

/** @param {unknown} value */
export function propertyValueClears(value) {
  return value === "" || value === null || (Array.isArray(value) && value.length === 0);
}
