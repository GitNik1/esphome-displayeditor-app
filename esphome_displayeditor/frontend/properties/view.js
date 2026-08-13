// @ts-check

import { LIST_KINDS } from "./model.js";

/** @typedef {{kind: string, default?: unknown, enum_values?: string[]}} PropertySchema */
/** @param {Pick<Document, "createElement">} document
 * @param {PropertySchema} property @param {any} value
 * @returns {HTMLInputElement | HTMLSelectElement} */
export function createBasicPropertyControl(document, property, value) {
  /** @type {HTMLInputElement | HTMLSelectElement} */
  let control;
  if (property.kind === "bool") {
    control = document.createElement("input");
    control.type = "checkbox";
    control.checked = value ?? Boolean(property.default);
  } else if (property.kind === "enum") {
    control = document.createElement("select");
    control.append(new Option("—", ""));
    const enumValues = property.enum_values || [];
    enumValues.forEach((option) => control.append(new Option(option, option)));
    if (value !== undefined && !enumValues.includes(String(value))) {
      control.append(new Option(String(value), String(value)));
    }
    control.value = String(value ?? "");
  } else if (LIST_KINDS.includes(property.kind)) {
    control = document.createElement("input");
    control.type = "text";
    control.value = Array.isArray(value) ? value.join(", ") : "";
    control.placeholder = property.kind === "grid_track_list"
      ? "40, FR(1), CONTENT" : property.kind === "text_list"
        ? "Monday, Tuesday, Wednesday" : "img_a, img_b";
  } else {
    control = document.createElement("input");
    control.type = ["int", "float"].includes(property.kind) ? "number" : "text";
    if (property.kind === "float") control.step = "any";
    control.value = String(value ?? "");
    if (property.default !== null) control.placeholder = String(property.default);
    if (property.kind === "color") control.placeholder = "RRGGBB oder Farb-ID";
  }
  return control;
}
