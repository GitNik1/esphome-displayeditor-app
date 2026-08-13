// @ts-check

import {
  actionIdsForEditor,
  actionObjectEntry,
  generatedActionCondition,
} from "./model.js";

/** @typedef {Record<string, any>} Action */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {{text: string, targetIds: string[], supported: boolean,
 * skipMissingCheck?: boolean}} ActionDescription */

/** @param {Action} action @param {Translate} translate @returns {ActionDescription | null} */
export function describeFlowAction(action, translate) {
  const entry = actionObjectEntry(action);
  if (entry?.[0] !== "if") return null;
  const outer = entry[1];
  if (typeof outer?.condition?.lambda !== "string" || !outer.condition.lambda.includes("abs((int)x)")) {
    return null;
  }
  /** @type {Set<string>} */
  const ids = new Set();
  /** @param {unknown} branch */
  const collect = (branch) => {
    if (!Array.isArray(branch)) return;
    branch.forEach((item) => {
      const nested = actionObjectEntry(item);
      if (!nested) return;
      if (["lvgl.widget.hide", "lvgl.widget.show", "lvgl.animimg.start"].includes(nested[0])) {
        ids.add(String(nested[1]));
      }
      if (nested[0] === "if") {
        collect(nested[1]?.then);
        collect(nested[1]?.else);
      }
    });
  };
  collect(outer.then);
  collect(outer.else);
  if (!ids.size) return null;
  return {
    text: `${translate("action.desc.flow")}: ${[...ids].join(" ⇄ ")}`,
    targetIds: [...ids],
    supported: true,
    skipMissingCheck: true,
  };
}

/** @param {Action} action @param {Translate} translate @returns {ActionDescription} */
export function describeWidgetAction(action, translate) {
  const conditional = generatedActionCondition(action);
  if (conditional) {
    const prefix = conditional.condition === "checked"
      ? translate("action.desc.whenChecked")
      : translate("action.desc.whenUnchecked");
    const inner = describeWidgetAction(conditional.action, translate);
    return { ...inner, text: `${prefix}${inner.text}` };
  }
  const flow = describeFlowAction(action, translate);
  if (flow) return flow;
  const entry = actionObjectEntry(action);
  if (!entry) return { text: translate("action.desc.unsupported"), targetIds: [], supported: false };
  const [name, payload] = entry;
  const targetIds = actionIdsForEditor(payload);
  if (["lvgl.widget.show", "lvgl.widget.hide"].includes(name)) {
    return {
      text: `${name.endsWith(".show") ? translate("action.desc.show") : translate("action.desc.hide")}: ${targetIds.join(", ") || translate("action.desc.noTarget")}`,
      targetIds,
      supported: Boolean(targetIds.length),
    };
  }
  if (["lvgl.animimg.start", "lvgl.animimg.stop"].includes(name)) {
    return {
      text: `${name.endsWith(".start") ? translate("action.desc.animimgStart") : translate("action.desc.animimgStop")}: ${targetIds.join(", ") || translate("action.desc.noTarget")}`,
      targetIds,
      supported: Boolean(targetIds.length),
    };
  }
  if (name === "lvgl.page.show") {
    return {
      text: `${translate("action.desc.openPage")}${targetIds.join(", ") || translate("action.desc.noTarget")}`,
      targetIds: [],
      supported: Boolean(targetIds.length),
    };
  }
  if ([
    "lvgl.widget.update",
    "lvgl.label.update",
    "lvgl.button.update",
    "lvgl.image.update",
    "lvgl.animimg.update",
  ].includes(name) && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const fields = Object.keys(payload).filter((key) => key !== "id");
    return {
      text: `${translate("action.desc.change")}${targetIds.join(", ") || translate("action.desc.noTarget")}${fields.length ? ` · ${fields.join(", ")}` : ""}`,
      targetIds,
      supported: Boolean(targetIds.length && fields.length),
    };
  }
  return {
    text: translate("action.desc.yamlOnly", { name }),
    targetIds,
    supported: false,
  };
}
// @ts-check
