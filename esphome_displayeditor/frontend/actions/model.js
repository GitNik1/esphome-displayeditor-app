export function actionObjectEntry(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const entries = Object.entries(action);
  return entries.length === 1 ? entries[0] : null;
}

export function actionIdsForEditor(payload) {
  if (typeof payload === "string") return [payload];
  if (Array.isArray(payload)) return payload.flatMap(actionIdsForEditor);
  if (payload && typeof payload === "object") return actionIdsForEditor(payload.id);
  return [];
}

export function generatedActionCondition(action) {
  const entry = actionObjectEntry(action);
  if (entry?.[0] !== "if" || !entry[1] || typeof entry[1] !== "object") return null;
  const expression = String(entry[1].condition?.lambda || "").replace(/\s+/g, "").toLowerCase();
  const branch = Array.isArray(entry[1].then) && entry[1].then.length === 1
    ? entry[1].then[0]
    : null;
  if (!branch || !["returnx;", "return!x;"].includes(expression)) return null;
  return { condition: expression === "returnx;" ? "checked" : "unchecked", action: branch };
}

export function widgetSupportsValueCondition(widget) {
  if (!widget) return false;
  if (widget.widget_type === "switch" || widget.widget_type === "checkbox") return true;
  return widget.widget_type === "button" && Boolean(widget.properties?.checkable);
}

export function normalizeActionColor(value) {
  const raw = String(value || "").trim();
  const hex = raw.replace(/^#/, "").replace(/^0x/i, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `0x${hex.toUpperCase()}` : raw;
}

