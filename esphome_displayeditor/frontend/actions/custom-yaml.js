// @ts-check

/** The YAML text a custom-action editor's fields stand for.
 *
 * The raw textarea wins while it is active; otherwise the action name plus one
 * `  key: value` line per named parameter. Turning that text into the
 * `{name: payload}` action - and rejecting it - is the backend's job
 * (designer/bindings/custom-yaml/validate); this only spells out what was
 * typed, which keeps it testable without a browser.
 */

/** @typedef {{name: string, value: string}} CustomActionParam */
/** @typedef {{raw: boolean, rawText: string, name: string,
 *   params: CustomActionParam[]}} CustomActionFields */

/** Parameters with a name, the name trimmed; the value is kept as typed.
 * @param {CustomActionParam[]} params @returns {CustomActionParam[]} */
export function namedParams(params) {
  return params
    .map((param) => ({ name: param.name.trim(), value: param.value }))
    .filter((param) => param.name);
}

/** @param {CustomActionFields} fields @returns {string} */
export function customActionYaml({ raw, rawText, name, params }) {
  if (raw) return rawText;
  const action = name.trim();
  if (!action) return "";
  const rows = namedParams(params);
  if (!rows.length) return `${action}:`;
  return `${action}:\n${rows.map((row) => `  ${row.name}: ${row.value}`).join("\n")}`;
}
