import { normalizeActionColor } from "./model.js";

export function buildWidgetAction({ type, targetId, targetWidget, fields = {} }) {
  if (["show", "hide"].includes(type)) return { [`lvgl.widget.${type}`]: targetId };
  if (type === "page_show") return { "lvgl.page.show": targetId };
  if (["animimg_start", "animimg_stop"].includes(type)) {
    return { [`lvgl.animimg.${type === "animimg_start" ? "start" : "stop"}`]: targetId };
  }
  if (type !== "update") throw new Error("unsupported_action_type");

  const payload = { id: targetId };
  const text = String(fields.text || "").trim();
  if (text && ["label", "button"].includes(targetWidget?.widget_type)) payload.text = text;
  const imageSource = String(fields.imageSource || "").trim();
  if (imageSource && targetWidget?.widget_type === "image") payload.src = imageSource;
  for (const key of ["bg_color", "text_color", "border_color", "opa"]) {
    const value = String(fields[key] || "").trim();
    if (value) payload[key] = key.endsWith("_color") ? normalizeActionColor(value) : value;
  }
  if (Object.keys(payload).length === 1) throw new Error("missing_update_fields");

  const actionName = targetWidget?.widget_type === "label"
    ? "lvgl.label.update"
    : targetWidget?.widget_type === "button"
      ? "lvgl.button.update"
      : targetWidget?.widget_type === "image"
        ? "lvgl.image.update"
        : "lvgl.widget.update";
  return { [actionName]: payload };
}

export function wrapValueCondition(action, condition) {
  if (!condition || condition === "always") return action;
  if (!["checked", "unchecked"].includes(condition)) throw new Error("invalid_value_condition");
  return {
    if: {
      condition: { lambda: condition === "checked" ? "return x;" : "return !x;" },
      then: [action],
    },
  };
}

