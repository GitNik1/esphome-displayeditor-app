// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */
/** @typedef {{encryption_key_ref: string, [key: string]: unknown}} DeviceInput */

/** @param {ApiClient} api */
export function createDevicesController(api) {
  /** @param {string} id @param {string} [suffix] */
  const path = (id, suffix = "") => `devices/${encodeURIComponent(id)}${suffix}`;
  return {
    async list() { return (await api("devices")).devices || []; },
    /** @param {string} id */
    async details(id) {
      const [info, entities, states, logs] = await Promise.all([
        api(path(id, "/info")), api(path(id, "/entities")),
        api(path(id, "/states")), api(path(id, "/logs?limit=500")),
      ]);
      return { info: info.info || {}, entities: entities.entities || [], states: states.states || [], logs: logs.logs || [] };
    },
    /** @param {DeviceInput} device @param {string | null} [editingId]
     * @param {string} [encryptionKey] */
    async save(device, editingId = null, encryptionKey = "") {
      await api(editingId ? `admin/devices/${encodeURIComponent(editingId)}` : "admin/devices", {
        method: editingId ? "PUT" : "POST", body: JSON.stringify(device),
      });
      if (encryptionKey) await api(`admin/device-secrets/${encodeURIComponent(device.encryption_key_ref)}`, {
        method: "PUT", body: JSON.stringify({ encryption_key: encryptionKey }),
      });
    },
    /** @param {string} id */
    reconnect(id) { return api(`admin/devices/${encodeURIComponent(id)}/reconnect`, { method: "POST" }); },
    /** @param {string} id */
    remove(id) { return api(`admin/devices/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async runtime() { return api("viewer/runtime"); },
  };
}
