// @ts-check

import { t } from "../i18n/runtime.js";
import { viewerConditionValue } from "./action-model.js";
import { applyViewerControl } from "./action-controls.js";
import { applyViewerUpdate } from "./action-updates.js";

/** @typedef {{key: string, label: string}} PendingCondition */
/** @typedef {{handled: boolean, changed: boolean, warning?: boolean, message: string,
 * pending?: PendingCondition}} ActionResult */
/** @typedef {{supported: boolean, value: boolean, pending?: PendingCondition}} ConditionResult */

/**
 * Evaluate an ESPHome condition as far as the browser can: `and`/`or`/`not`
 * and condition lists combine, `return x;`-style lambdas compare against the
 * event value, and everything else is asked of `context.resolveCondition`
 * (the Viewer's simulation: remembered answers, simulated switch states).
 * An unanswered part yields `pending`, unless the known parts already decide.
 * @param {any} condition @param {any} context @returns {ConditionResult}
 */
export function evaluateViewerCondition(condition, context) {
  if (Array.isArray(condition)) return combine(condition, context, true);
  if (condition && typeof condition === "object") {
    const entries = Object.entries(condition);
    if (entries.length === 1) {
      const [[name, payload]] = entries;
      if (name === "and") return combine(Array.isArray(payload) ? payload : [payload], context, true);
      if (name === "or") return combine(Array.isArray(payload) ? payload : [payload], context, false);
      if (name === "not") {
        const inner = evaluateViewerCondition(payload, context);
        return inner.supported ? { supported: true, value: !inner.value } : inner;
      }
      if (name === "lambda" && typeof payload === "string") {
        const native = viewerConditionValue(condition, context);
        if (native.supported) return native;
      }
    }
  }
  if (typeof context.resolveCondition !== "function") return { supported: false, value: false };
  const answer = context.resolveCondition(condition);
  if (answer.known) return { supported: true, value: answer.value };
  return { supported: false, value: false, pending: { key: answer.key, label: answer.label } };
}

/** @param {any[]} parts @param {any} context @param {boolean} all @returns {ConditionResult} */
function combine(parts, context, all) {
  /** @type {ConditionResult | null} */
  let open = null;
  for (const part of parts) {
    const result = evaluateViewerCondition(part, context);
    if (!result.supported) {
      open ||= result;
      continue;
    }
    // A known false decides an `and`, a known true an `or` - no question needed.
    if (result.value !== all) return { supported: true, value: !all };
  }
  return open || { supported: true, value: all };
}

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
    const condition = evaluateViewerCondition(payload.condition, context);
    if (condition.pending) {
      return {
        handled: false, changed: false, pending: condition.pending,
        message: t("viewer.event.conditionPending", { condition: condition.pending.label }),
      };
    }
    if (!condition.supported) {
      return { handled: false, changed: false, message: t("viewer.event.conditionNotExecuted") };
    }
    const selected = condition.value ? payload.then : payload.else;
    const actions = selected === undefined ? [] : Array.isArray(selected) ? selected : [selected];
    let changed = false;
    let warning = false;
    /** @type {string[]} */
    const messages = [];
    for (const nested of actions) {
      const result = applyViewerAction(project, nested, runtime, context);
      if (result.pending) return { ...result, changed: changed || result.changed };
      changed ||= result.changed;
      warning ||= Boolean(result.warning || !result.handled);
      messages.push(result.message);
    }
    return {
      handled: true, changed, warning,
      message: `if (${condition.value ? t("viewer.event.true") : t("viewer.event.false")})${messages.length ? `: ${messages.join("; ")}` : ""}`,
    };
  }
  const controlResult = applyViewerControl(project, runtime, name, payload, t);
  if (controlResult) return controlResult;
  const updateResult = applyViewerUpdate(project, name, payload, t, context);
  if (updateResult) return updateResult;
  // The Viewer's simulation may stand in for what the browser cannot run.
  const simulated = typeof context.onUnsupportedAction === "function"
    ? context.onUnsupportedAction(name, payload)
    : null;
  if (simulated) return simulated;
  return { handled: false, changed: false, message: t("viewer.event.notExecutedInBrowser", { name }) };
}
