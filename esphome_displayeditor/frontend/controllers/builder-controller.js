// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

/** @param {ApiClient} api */
export function createBuilderController(api) {
  /** @param {string} name @param {string} suffix */
  const config = (name, suffix) => `configurations/${name}${suffix}`;
  return {
    /** @param {string} name */
    validate(name) { return api(config(name, "/validate"), { method: "POST" }); },
    /** @param {string} name @param {string} key */
    compile(name, key) { return api(config(name, "/compile"), { method: "POST", headers: { "Idempotency-Key": key } }); },
    /** @param {string} name @param {string} key */
    install(name, key) { return api(config(name, "/install"), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ port: "OTA", confirmed: true }) }); },
    async jobs() { return (await api("jobs")).jobs || []; },
    /** @param {string} jobId */
    cancel(jobId) { return api(`jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }); },
  };
}
