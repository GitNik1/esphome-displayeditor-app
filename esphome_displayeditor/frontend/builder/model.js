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

/**
 * Why builder actions are unavailable when it is not the user's role: an
 * i18n key with its values, or null when the builder itself is fine. The
 * disabled buttons used to say "no permission" for an unsupported ESPHome
 * version too.
 * @param {{state?: string, compatible?: boolean, reason?: string, esphome_version?: string | null} | null | undefined} builder
 * @returns {{key: string, values?: Record<string, string>} | null}
 */
export function builderBlockedReason(builder) {
  if (!builder || builder.compatible) return null;
  if (builder.reason === "builder_disabled") return { key: "configs.hint.builderDisabled" };
  if (builder.reason === "unsupported_esphome_version") {
    return { key: "configs.hint.builderUnsupported", values: { version: builder.esphome_version || "?" } };
  }
  return { key: "configs.hint.builderUnavailable", values: { reason: builder.reason || builder.state || "unknown" } };
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

const TERMINAL_JOB_STATUSES = new Set(["success", "succeeded", "completed", "done", "failed", "error", "cancelled", "canceled"]);
const UNSUCCESSFUL_JOB_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

/** @param {BuilderJob} job */
function jobStatus(job) {
  return String(job.status || "").trim().toLowerCase();
}

/**
 * An install is a COMPILE job plus an upload job whose `depends_on` names
 * it; the compile job alone says "completed" even when the upload fails.
 * Same rule as the backend's chain_status.
 * @param {BuilderJob} job @param {BuilderJob[]} dependents
 */
export function builderChainStatus(job, dependents) {
  const own = jobStatus(job);
  if (UNSUCCESSFUL_JOB_STATUSES.has(own) || !TERMINAL_JOB_STATUSES.has(own)) return own;
  const states = dependents.map(jobStatus);
  const pending = states.find((state) => !TERMINAL_JOB_STATUSES.has(state));
  if (pending !== undefined) return pending || "queued";
  return states.find((state) => UNSUCCESSFUL_JOB_STATUSES.has(state)) || own;
}

/**
 * Jobs newest first, each dependent job folded into the job it waits on.
 * `active` is the job a cancel should target: the first one still queued
 * or running, else null.
 * @param {Record<string, BuilderJob>} jobs
 * @returns {{job: BuilderJob, dependents: BuilderJob[], status: string, active: BuilderJob | null}[]}
 */
export function builderJobGroups(jobs) {
  const sorted = sortedBuilderJobs(jobs);
  const isDependent = (/** @type {BuilderJob} */ job) => Boolean(job.depends_on && jobs[job.depends_on]);
  return sorted.filter((job) => !isDependent(job)).map((job) => {
    const dependents = sorted.filter((other) => other.depends_on === job.job_id).reverse();
    const chain = [job, ...dependents];
    const active = chain.find((item) => ["queued", "running"].includes(jobStatus(item))) || null;
    return { job, dependents, status: builderChainStatus(job, dependents), active };
  });
}
