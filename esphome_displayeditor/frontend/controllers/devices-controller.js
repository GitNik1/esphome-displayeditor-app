export function createDevicesController(api) {
  const path = (id, suffix = "") => `devices/${encodeURIComponent(id)}${suffix}`;
  return {
    async list() { return (await api("devices")).devices || []; },
    async details(id) {
      const [info, entities, states, logs] = await Promise.all([
        api(path(id, "/info")), api(path(id, "/entities")),
        api(path(id, "/states")), api(path(id, "/logs?limit=500")),
      ]);
      return { info: info.info || {}, entities: entities.entities || [], states: states.states || [], logs: logs.logs || [] };
    },
    async save(device, editingId = null, encryptionKey = "") {
      await api(editingId ? `admin/devices/${encodeURIComponent(editingId)}` : "admin/devices", {
        method: editingId ? "PUT" : "POST", body: JSON.stringify(device),
      });
      if (encryptionKey) await api(`admin/device-secrets/${encodeURIComponent(device.encryption_key_ref)}`, {
        method: "PUT", body: JSON.stringify({ encryption_key: encryptionKey }),
      });
    },
    reconnect(id) { return api(`admin/devices/${encodeURIComponent(id)}/reconnect`, { method: "POST" }); },
    remove(id) { return api(`admin/devices/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async runtime() { return api("viewer/runtime"); },
  };
}
