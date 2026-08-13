// @ts-check

/** @typedef {{job_id: string, created_at?: unknown, last_output?: string,
 * [key: string]: any}} BuilderJob */
/** @typedef {{activeConfig: string | null, hasDraft: boolean,
 * capabilities: Record<string, unknown>, builderRequestsRunning: Set<string>}} AvailabilityState */
/** @typedef {{activeConfig: string | null,
 * builderRequestKeys: Record<string, string>}} RequestState */
/** @typedef {{type?: string, event?: string,
 * data?: (BuilderJob & {line?: unknown})}} BuilderEvent */

/** @param {AvailabilityState} state */
export function builderAvailability(state) {
  const published = Boolean(state.activeConfig) && !state.hasDraft;
  return {
    validate: published && Boolean(state.capabilities["configuration.validate_esphome"]),
    compile: published && Boolean(state.capabilities["firmware.compile"]) && !state.builderRequestsRunning.has("compile"),
    install: published && Boolean(state.capabilities["firmware.upload"]) && !state.builderRequestsRunning.has("install"),
  };
}

/** @param {RequestState} state @param {string} operation
 * @param {() => string} createKey */
export function builderRequest(state, operation, createKey) {
  const slot = `${operation}:${state.activeConfig}`;
  state.builderRequestKeys[slot] ||= createKey();
  return { slot, key: state.builderRequestKeys[slot] };
}

/** @param {BuilderJob[]} jobs @returns {Record<string, BuilderJob>} */
export function replaceBuilderJobs(jobs) {
  return Object.fromEntries(jobs.map((job) => [job.job_id, job]));
}

/** @param {Record<string, BuilderJob>} jobs @returns {BuilderJob[]} */
export function sortedBuilderJobs(jobs) {
  return Object.values(jobs).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

/** @param {Record<string, BuilderJob>} jobs @param {BuilderEvent} payload */
export function applyBuilderEvent(jobs, payload) {
  if (payload.type !== "builder_job" || !payload.data?.job_id) return jobs;
  const data = payload.data;
  if (payload.event === "job_output") {
    if (jobs[data.job_id]) jobs[data.job_id].last_output = String(data.line || "").slice(-4096);
  } else {
    jobs[data.job_id] = { ...(jobs[data.job_id] || {}), ...data };
  }
  return jobs;
}
