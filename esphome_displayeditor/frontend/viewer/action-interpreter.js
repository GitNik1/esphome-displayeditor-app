// @ts-check

import { t } from "../i18n/runtime.js";
import { viewerConditionValue } from "./action-model.js";
import { applyViewerControl } from "./action-controls.js";
import { applyViewerUpdate } from "./action-updates.js";

/** @typedef {{handled: boolean, changed: boolean, warning?: boolean, message: string}} ActionResult */

/** @param {any} project @param {unknown} action @param {any} [runtime]
 * @param {any} [context] @returns {ActionResult} */
export function applyViewerAction(project, action, runtime = {}, context = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { handled: false, changed: false, message: t("viewer.event.invalidAction") };
  }
  const entries = Object.entries(action);
  if (entries.length !== 1) {
    return { handled: false, changed: false, message: t("viewer.event.ambiguousAction") };
  }
  const [name, payload] = entries[0];
  if (name === "if") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: t("viewer.event.invalidCondition") };
    }
    const condition = viewerConditionValue(payload.condition, context);
    if (!condition.supported) {
      return { handled: false, changed: false, message: t("viewer.event.conditionNotExecuted") };
    }
    const selected = condition.value ? payload.then : payload.else;
    const actions = selected === undefined ? [] : Array.isArray(selected) ? selected : [selected];
    let changed = false;
    let warning = false;
    /** @type {string[]} */
    const messages = [];
    actions.forEach((nested) => {
      const result = applyViewerAction(project, nested, runtime, context);
      changed ||= result.changed;
      warning ||= Boolean(result.warning || !result.handled);
      messages.push(result.message);
    });
    return {
      handled: true, changed, warning,
      message: `if (${condition.value ? t("viewer.event.true") : t("viewer.event.false")})${messages.length ? `: ${messages.join("; ")}` : ""}`,
    };
  }
  const controlResult = applyViewerControl(project, runtime, name, payload, t);
  if (controlResult) return controlResult;
  const updateResult = applyViewerUpdate(project, name, payload, t, context);
  if (updateResult) return updateResult;
  return { handled: false, changed: false, message: t("viewer.event.notExecutedInBrowser", { name }) };
}
