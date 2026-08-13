// @ts-check

/** @typedef {{type?: unknown, key?: unknown, object_id?: unknown,
 * entity_id?: string, received_at?: unknown, [key: string]: any}} DeviceState */
/** @typedef {{id: string, status?: unknown, last_seen?: unknown,
 * states?: DeviceState[], [key: string]: any}} RuntimeDevice */
/** @typedef {{devices?: RuntimeDevice[]}} RuntimeSnapshot */
/** @typedef {{type?: string, device_id?: string, status?: unknown,
 * state?: DeviceState}} RuntimeEvent */

/** @param {Record<string, unknown>[]} rows @param {string[]} preferredColumns */
export function deviceTableColumns(rows, preferredColumns) {
  return preferredColumns.filter((column) => rows.some((row) => row[column] !== undefined));
}

/** @param {{received_at?: unknown, level?: unknown, message?: unknown}[]} logs
 * @param {string} [emptyText] */
export function formatDeviceLogs(logs, emptyText = "") {
  if (!logs.length) return emptyText;
  return logs
    .map((item) => `[${item.received_at || ""}] [${item.level || "INFO"}] ${item.message || ""}`)
    .join("\n");
}

/** @param {DeviceState} state */
export function deviceStateKey(state) {
  return `${state.type}:${state.key ?? state.object_id ?? "unknown"}`;
}

/** @param {DeviceState[]} states @param {DeviceState} nextState */
export function mergeDeviceState(states, nextState) {
  const index = states.findIndex((item) => deviceStateKey(item) === deviceStateKey(nextState));
  if (index >= 0) states[index] = nextState;
  else states.push(nextState);
  return states;
}

/** @param {RuntimeSnapshot} snapshot @param {RuntimeEvent} event */
export function applyRuntimeEvent(snapshot, event) {
  const devices = snapshot.devices || (snapshot.devices = []);
  if (event.type === "device_removed") {
    snapshot.devices = devices.filter((device) => device.id !== event.device_id);
    return snapshot;
  }
  const device = devices.find((item) => item.id === event.device_id);
  if (!device) return snapshot;
  if (event.type === "connection") {
    device.status = event.status;
    return snapshot;
  }
  if (event.type !== "state" || !event.state) return snapshot;
  const runtimeState = { ...event.state };
  runtimeState.entity_id ||= deviceStateKey(runtimeState);
  device.states ||= [];
  const index = device.states.findIndex((item) => item.entity_id === runtimeState.entity_id);
  if (index >= 0) device.states[index] = runtimeState;
  else device.states.push(runtimeState);
  device.last_seen = runtimeState.received_at || device.last_seen;
  return snapshot;
}
