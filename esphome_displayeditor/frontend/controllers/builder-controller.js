export function createBuilderController(api) {
  const config = (name, suffix) => `configurations/${name}${suffix}`;
  return {
    validate(name) { return api(config(name, "/validate"), { method: "POST" }); },
    compile(name, key) { return api(config(name, "/compile"), { method: "POST", headers: { "Idempotency-Key": key } }); },
    install(name, key) { return api(config(name, "/install"), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ port: "OTA", confirmed: true }) }); },
    async jobs() { return (await api("jobs")).jobs || []; },
    cancel(jobId) { return api(`jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }); },
  };
}
