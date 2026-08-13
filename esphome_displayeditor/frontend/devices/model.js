export function deviceTableColumns(rows, preferredColumns) {
  return preferredColumns.filter((column) => rows.some((row) => row[column] !== undefined));
}

export function formatDeviceLogs(logs, emptyText = "") {
  if (!logs.length) return emptyText;
  return logs
    .map((item) => `[${item.received_at || ""}] [${item.level || "INFO"}] ${item.message || ""}`)
    .join("\n");
}

export function deviceStateKey(state) {
  return `${state.type}:${state.key ?? state.object_id ?? "unknown"}`;
}

export function mergeDeviceState(states, nextState) {
  const index = states.findIndex((item) => deviceStateKey(item) === deviceStateKey(nextState));
  if (index >= 0) states[index] = nextState;
  else states.push(nextState);
  return states;
}

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
