// @ts-check

/** DOM half of the custom-action editor (wired up in
 * controllers/custom-action-controller.js): parameter rows, the raw-YAML
 * toggle and the preview/error area.
 *
 * It renders and reports what was typed. It never validates, calls the API or
 * schedules anything, and receives `document` instead of reaching for the
 * global one - the same contract as properties/view.js.
 */

/** @typedef {import("./custom-yaml.js").CustomActionFields} CustomActionFields */
/** @typedef {import("./custom-yaml.js").CustomActionParam} CustomActionParam */
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
/** @typedef {ReturnType<typeof createCustomActionView>} CustomActionView */

const ROW_CLASS = "widget-action-custom-param";

/**
 * @param {Pick<Document, "createElement">} document
 * @param {CustomEditorElements} els
 * @param {Translate} t
 */
export function createCustomActionView(document, els, t) {
  /** @returns {CustomActionParam[]} */
  function params() {
    return [...els.paramsContainer.querySelectorAll(`.${ROW_CLASS}`)].map((row) => ({
      name: (/** @type {HTMLInputElement} */ (row.querySelector(".custom-param-name"))).value,
      value: (/** @type {HTMLInputElement} */ (row.querySelector(".custom-param-value"))).value,
    }));
  }

  /** @param {boolean} raw */
  function setRawMode(raw) {
    els.rawToggle.checked = raw;
    els.rawField.classList.toggle("hidden", !raw);
    els.nameField.classList.toggle("hidden", raw);
    els.paramsContainer.classList.toggle("hidden", raw);
    els.addParamButton.classList.toggle("hidden", raw);
  }

  return {
    params,
    setRawMode,

    /** @returns {CustomActionFields} */
    fields() {
      return {
        raw: els.rawToggle.checked,
        rawText: els.rawTextarea.value,
        name: els.nameInput.value,
        params: params(),
      };
    },

    /** Append an empty parameter row; `onChange` runs on every edit of it
     * and once more when it is removed.
     * @param {() => void} onChange */
    addParamRow(onChange) {
      const row = document.createElement("div");
      row.className = ROW_CLASS;
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
        onChange();
      });
      [nameInput, valueInput].forEach((input) => input.addEventListener("input", onChange));
      row.append(nameInput, valueInput, remove);
      els.paramsContainer.append(row);
      return row;
    },

    /** @param {string} text */
    setRawText(text) {
      els.rawTextarea.value = text;
    },

    /** @param {string} yaml */
    showPreview(yaml) {
      els.preview.textContent = yaml;
      els.error.classList.add("hidden");
    },

    /** @param {string} message */
    showError(message) {
      els.preview.textContent = "";
      els.error.textContent = message;
      els.error.classList.remove("hidden");
    },

    clearFeedback() {
      els.preview.textContent = "";
      els.error.classList.add("hidden");
    },

    reset() {
      els.nameInput.value = "";
      els.rawTextarea.value = "";
      els.paramsContainer.replaceChildren();
      els.preview.textContent = "";
      els.error.classList.add("hidden");
      setRawMode(false);
    },
  };
}
