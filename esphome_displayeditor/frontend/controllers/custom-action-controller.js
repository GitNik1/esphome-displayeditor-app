// @ts-check
//
// Reusable "name + parameter rows + live preview + raw YAML fallback" editor
// for a single arbitrary ESPHome action ({name: payload}). Shared by the
// widget Actions builder's "Custom-Aktion" and the device Custom-YAML
// binding editor - both validate through the same backend endpoint
// (designer/bindings/custom-yaml/validate, backend/entity_bindings.py
// parse_custom_binding_yaml) and produce the same action-dict shape.
//
// This module only coordinates: the DOM lives in actions/view.js, the YAML
// spelling in actions/custom-yaml.js and the preview timer in
// services/debounce.js.

import { customActionYaml, namedParams } from "../actions/custom-yaml.js";
import { createDebouncer } from "../services/debounce.js";

/** @typedef {import("../api/client.js").ApiClient} ApiClient */
/** @typedef {import("../actions/view.js").CustomActionView} CustomActionView */
/** @typedef {ReturnType<typeof createDebouncer>} Debouncer */

const VALIDATE_PATH = "designer/bindings/custom-yaml/validate";
const PREVIEW_DELAY_MS = 250;

/**
 * @param {CustomActionView} view
 * @param {ApiClient} api
 * @param {Debouncer} [debouncer]
 */
export function createCustomActionController(view, api, debouncer = createDebouncer(PREVIEW_DELAY_MS)) {
  const yamlText = () => customActionYaml(view.fields());

  /** @param {string} content */
  const validate = (content) => api(VALIDATE_PATH, {
    method: "POST",
    body: JSON.stringify({ content }),
  });

  async function renderPreview() {
    const text = yamlText();
    if (!text.trim()) {
      view.clearFeedback();
      return;
    }
    try {
      const result = await validate(text);
      view.showPreview(result.yaml);
    } catch (/** @type {any} */ validationError) {
      view.showError(validationError.message);
    }
  }

  function schedulePreview() {
    debouncer.run(() => { renderPreview(); });
  }

  return {
    /** Named parameter rows, as the YAML will spell them. */
    paramRows: () => namedParams(view.params()),
    yamlText,
    schedulePreview,
    renderPreview,
    setRawMode: view.setRawMode,

    addParamRow() {
      const row = view.addParamRow(schedulePreview);
      schedulePreview();
      return row;
    },

    /** Validates the current content and returns the parsed action dict, or throws. */
    async validateAndBuild() {
      const text = yamlText();
      if (!text.trim()) throw new Error("missing_custom_action_name");
      const result = await validate(text);
      return result.action;
    },

    /** Loads an existing action's YAML for editing - always in raw mode, since
     * reversing arbitrary YAML back into flat name+param rows isn't reliably
     * possible (nested values, nested lists, nested !lambda tags).
     * @param {string} existingYamlText */
    loadFromYaml(existingYamlText) {
      view.setRawText(existingYamlText || "");
      view.setRawMode(true);
      renderPreview();
    },

    reset() {
      // A preview still waiting would only re-render the cleared fields.
      debouncer.cancel();
      view.reset();
    },
  };
}
