// @ts-check

/** @typedef {Record<string, any>} DynamicRecord */
/** @typedef {{widgets?: DynamicRecord[], pages?: DynamicRecord[], bottom_layer?: DynamicRecord,
 * top_layer?: DynamicRecord, msgboxes?: DynamicRecord[]}} RuntimeProject */

/** @type {Record<string, Set<string>>} */
const RUNTIME_TARGET_WIDGET = {
  text: new Set(["label", "textarea"]),
  value: new Set(["slider", "bar", "arc"]),
  state_checked: new Set(["switch", "checkbox"]),
  selected_index: new Set(["dropdown", "roller"]),
};

/** @param {RuntimeProject | null | undefined} project @returns {DynamicRecord[]} */
function roots(project) {
  if (!project) return [];
  const result = [...(project.widgets || [])];
  (project.pages || []).forEach((page) => result.push(...(page.widgets || [])));
  result.push(...(project.bottom_layer?.widgets || []), ...(project.top_layer?.widgets || []));
  (project.msgboxes || []).forEach((box) => result.push(...(box.buttons || []), ...(box.header_buttons || [])));
  return result;
}

/** @param {RuntimeProject | null | undefined} project @param {unknown} id @returns {DynamicRecord | null} */
function findWidget(project, id) {
  /** @type {DynamicRecord | null} */
  let found = null;
  /** @param {DynamicRecord[] | undefined} widgets @returns {boolean} */
  const visit = (widgets) => (widgets || []).some((widget) => {
    if (String(widget.id || "") === String(id)) { found = widget; return true; }
    return visit(widget.children);
  });
  visit(roots(project));
  return found || (project?.msgboxes || []).find((box) => String(box.id || "") === String(id)) || null;
}

/** @param {unknown} value */
export function runtimeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "an", "ein", "locked"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "aus", "unlocked"].includes(normalized)) return false;
  return null;
}

/** @param {DynamicRecord | null | undefined} entity @param {string} target
 * @param {DynamicRecord | null} [runtimeState] */
export function entityMatchesRuntimeTarget(entity, target, runtimeState = null) {
  if (!entity || target === "text") return Boolean(entity);
  const type = String(entity.type || "").toLowerCase();
  if (target === "value" || target === "selected_index") {
    if (["sensor", "number"].includes(type)) return true;
    const value = Number(runtimeState?.state);
    return runtimeState?.state !== "" && runtimeState?.state != null && Number.isFinite(value);
  }
  if (target === "state_checked") {
    if (["binary_sensor", "switch", "light", "fan", "lock"].includes(type)) return true;
    return runtimeState && runtimeBoolean(runtimeState.state) !== null;
  }
  return false;
}

/** @param {DynamicRecord | null | undefined} binding @param {DynamicRecord | null | undefined} snapshot
 * @param {{now?: number}} [options] */
export function runtimeBindingHealth(binding, snapshot, { now = Date.now() } = {}) {
  if (!binding?.device_id || !binding?.entity_id) return { status: "unconfigured", device: null, state: null, stale: false };
  const device = (snapshot?.devices || []).find((/** @type {DynamicRecord} */ item) => item.id === binding.device_id) || null;
  if (!device) return { status: "missing_device", device: null, state: null, stale: false };
  const state = (device.states || []).find((/** @type {DynamicRecord} */ item) => item.entity_id === binding.entity_id) || null;
  if (device.status !== "ready") return { status: "offline", device, state, stale: false };
  if (!state) return { status: "missing_entity", device, state: null, stale: false };
  const receivedAt = Date.parse(state.received_at || "");
  const staleAfter = Math.max(0, Number(binding.stale_after) || 0);
  const stale = staleAfter > 0 && Number.isFinite(receivedAt) && now - receivedAt > staleAfter * 1000;
  if (stale) return { status: "stale", device, state, stale: true };
  if (state.available === false || state.state == null) return { status: "unavailable", device, state, stale: false };
  return { status: "online", device, state, stale: false };
}

/** @param {unknown} value @param {string} [template] */
export function formatRuntimeValue(value, template = "{state}") {
  return String(template || "{state}").replace(/\{state(?::\.(\d)f)?\}/g, (_match, decimals) => {
    if (decimals === undefined) return String(value ?? "");
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(Number(decimals)) : String(value ?? "");
  });
}

/** @param {RuntimeProject | null | undefined} project @param {RuntimeProject | null | undefined} source @param {DynamicRecord} binding
 * @param {DynamicRecord | null | undefined} runtimeState
 * @param {{deviceAvailable?: boolean, now?: number}} [options] */
export function applyRuntimeBinding(project, source, binding, runtimeState, { deviceAvailable = true, now = Date.now() } = {}) {
  const widget = findWidget(project, binding?.widget_id);
  const sourceWidget = findWidget(source, binding?.widget_id);
  const target = String(binding?.target || "");
  if (!widget || !sourceWidget || !RUNTIME_TARGET_WIDGET[target]?.has(widget.widget_type)) return false;
  const receivedAt = Date.parse(runtimeState?.received_at || "");
  const staleAfter = Math.max(0, Number(binding.stale_after) || 0);
  const stale = staleAfter > 0 && Number.isFinite(receivedAt) && now - receivedAt > staleAfter * 1000;
  const available = Boolean(deviceAvailable && runtimeState?.available !== false && !stale && runtimeState?.state != null);
  widget.properties ||= {};
  if (!available) {
    if (target !== "text") return false;
    const next = binding.fallback !== "" && binding.fallback !== undefined ? String(binding.fallback) : String(sourceWidget.properties?.text ?? "");
    if (widget.properties.text === next) return false;
    widget.properties.text = next;
    return true;
  }
  if (!runtimeState) return false;
  let next;
  if (target === "text") next = formatRuntimeValue(runtimeState.state, binding.value_format);
  else if (target === "value" || target === "selected_index") {
    next = Number(runtimeState.state);
    if (!Number.isFinite(next)) return false;
  } else {
    next = runtimeBoolean(runtimeState.state);
    if (next === null) return false;
  }
  if (widget.properties[target] === next) return false;
  widget.properties[target] = next;
  return true;
}
