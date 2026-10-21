// @ts-check

import { t } from "../i18n/runtime.js";

/** @typedef {{name: string, actions: any[], on?: {name: string, payload: any},
 * transitions?: Record<string, string>, initial?: string}} ViewerScenario */
/** @typedef {{yaml: string, scenarios: ViewerScenario[], suggestions: string}} ViewerScenarioSet */

/** A project's scenario set in its stored shape, whatever was saved.
 * @param {any} value @returns {ViewerScenarioSet} */
export function viewerScenarioSet(value) {
  if (!value || typeof value !== "object" || typeof value.yaml !== "string") {
    return { yaml: "", scenarios: [], suggestions: "" };
  }
  return {
    yaml: value.yaml,
    scenarios: Array.isArray(value.scenarios) ? value.scenarios : [],
    suggestions: typeof value.suggestions === "string" ? value.suggestions : "",
  };
}

/** How many scenarios a suggestion text holds (its `- name:` lines).
 * @param {string} text */
export function countSuggestedScenarios(text) {
  return (String(text || "").match(/^- name:/gm) || []).length;
}

/** Starter text for an empty editor: the format, by example.
 * @returns {string} */
export function viewerScenarioTemplate() {
  return [
    `# ${t("viewer.scenario.templateHint")}`,
    "- name: Beispiel",
    "  actions:",
    "    - lvgl.label.update:",
    "        id: my_label",
    "        text: \"42\"",
    "        bg_color: 0x00FF00",
    "    - lvgl.widget.show: [my_button]",
    "",
  ].join("\n");
}

/**
 * The scenario row of the Viewer: one play button per scenario.
 * @param {HTMLElement} list
 * @param {ViewerScenario[]} scenarios
 * @param {(scenario: ViewerScenario) => void} onRun
 */
export function renderViewerScenarioButtons(list, scenarios, onRun, suggestionCount = 0) {
  list.replaceChildren();
  if (!scenarios.length) {
    const empty = document.createElement("span");
    empty.className = "viewer-scenario-empty";
    empty.textContent = suggestionCount
      ? t("viewer.scenario.suggestionsAvailable", { count: suggestionCount })
      : t("viewer.scenario.none");
    list.append(empty);
    return;
  }
  scenarios.forEach((scenario) => {
    const button = document.createElement("button");
    button.type = "button";
    // A trigger scenario reacts to an action (`on:`); clicking it fires that
    // action, which is what the device's own button would do.
    const trigger = Boolean(scenario.on);
    button.className = `button subtle compact viewer-scenario-run${trigger ? " is-trigger" : ""}`;
    button.textContent = `${trigger ? "⚡" : "▶"} ${scenario.name}`;
    button.title = trigger
      ? t("viewer.scenario.triggerTitle", { action: `${scenario.on?.name}${scenario.on?.payload == null ? "" : `: ${typeof scenario.on.payload === "string" ? scenario.on.payload : JSON.stringify(scenario.on.payload)}`}` })
      : t("viewer.scenario.runTitle", { count: scenario.actions.length });
    button.addEventListener("click", () => onRun(scenario));
    list.append(button);
  });
}
