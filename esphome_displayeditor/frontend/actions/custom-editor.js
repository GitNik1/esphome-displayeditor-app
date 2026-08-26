// @ts-check
//
// Reusable "name + parameter rows + live preview + raw YAML fallback" editor
// for a single arbitrary ESPHome action ({name: payload}). Shared by the
// widget Actions builder's "Custom-Aktion" and the device Custom-YAML
// binding editor - both validate through the same backend endpoint
// (designer/bindings/custom-yaml/validate, backend/entity_bindings.py
// parse_custom_binding_yaml) and produce the same action-dict shape.

/** @typedef {{
 *   nameField: HTMLElement,
 *   nameInput: HTMLInputElement,
 *   paramsContainer: HTMLElement,
 *   addParamButton: HTMLElement,
 *   rawToggle: HTMLInputElement,
 *   rawField: HTMLElement,
 *   rawTextarea: HTMLTextAreaElement,
 *   preview: HTMLElement,
 *   error: HTMLElement,
 * }} CustomEditorElements */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {(path: string, init?: any) => Promise<any>} ApiClient */

/**
 * @param {CustomEditorElements} els
 * @param {Translate} t
 * @param {ApiClient} api
 */
export function createCustomActionEditor(els, t, api) {
  let previewTimer = 0;

  function paramRows() {
    return [...els.paramsContainer.querySelectorAll(".widget-action-custom-param")]
      .map((row) => ({
        name: (/** @type {HTMLInputElement} */ (row.querySelector(".custom-param-name"))).value.trim(),
        value: (/** @type {HTMLInputElement} */ (row.querySelector(".custom-param-value"))).value,
      }))
      .filter((row) => row.name);
  }

  function addParamRow() {
    const row = document.createElement("div");
    row.className = "widget-action-custom-param";
    const nameInput = document.createElement("input");
    nameInput.className = "custom-param-name";
    nameInput.maxLength = 64;
    nameInput.placeholder = t("actions.custom.paramName");
    const valueInput = document.createElement("input");
    valueInput.className = "custom-param-value";
    valueInput.maxLength = 256;
    valueInput.placeholder = t("actions.custom.paramValue");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger compact";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      row.remove();
      schedulePreview();
    });
    [nameInput, valueInput].forEach((input) => input.addEventListener("input", schedulePreview));
    row.append(nameInput, valueInput, remove);
    els.paramsContainer.append(row);
    schedulePreview();
    return row;
  }

  function yamlText() {
    if (els.rawToggle.checked) return els.rawTextarea.value;
    const name = els.nameInput.value.trim();
    if (!name) return "";
    const rows = paramRows();
    if (!rows.length) return `${name}:`;
    return `${name}:\n${rows.map((row) => `  ${row.name}: ${row.value}`).join("\n")}`;
  }

  function schedulePreview() {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => { renderPreview(); }, 250);
  }

  async function renderPreview() {
    const text = yamlText();
    if (!text.trim()) {
      els.preview.textContent = "";
      els.error.classList.add("hidden");
      return;
    }
    try {
      const result = await api("designer/bindings/custom-yaml/validate", {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      els.preview.textContent = result.yaml;
      els.error.classList.add("hidden");
    } catch (/** @type {any} */ validationError) {
      els.preview.textContent = "";
      els.error.textContent = validationError.message;
      els.error.classList.remove("hidden");
    }
  }

  /** Validates the current content and returns the parsed action dict, or throws. */
  async function validateAndBuild() {
    const text = yamlText();
    if (!text.trim()) throw new Error("missing_custom_action_name");
    const result = await api("designer/bindings/custom-yaml/validate", {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });
    return result.action;
  }

  /** @param {boolean} raw */
  function setRawMode(raw) {
    els.rawToggle.checked = raw;
    els.rawField.classList.toggle("hidden", !raw);
    els.nameField.classList.toggle("hidden", raw);
    els.paramsContainer.classList.toggle("hidden", raw);
    els.addParamButton.classList.toggle("hidden", raw);
  }

  /** Loads an existing action's YAML for editing - always in raw mode, since
   * reversing arbitrary YAML back into flat name+param rows isn't reliably
   * possible (nested values, nested lists, nested !lambda tags).
   * @param {string} existingYamlText
   */
  function loadFromYaml(existingYamlText) {
    els.rawTextarea.value = existingYamlText || "";
    setRawMode(true);
    renderPreview();
  }

  function reset() {
    els.nameInput.value = "";
    els.rawTextarea.value = "";
    els.paramsContainer.replaceChildren();
    els.preview.textContent = "";
    els.error.classList.add("hidden");
    setRawMode(false);
  }

  return {
    paramRows, addParamRow, yamlText, schedulePreview, renderPreview,
    validateAndBuild, setRawMode, loadFromYaml, reset,
  };
}
