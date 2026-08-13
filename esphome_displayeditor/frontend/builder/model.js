export function builderAvailability(state) {
  const published = Boolean(state.activeConfig) && !state.hasDraft;
  return {
    validate: published && Boolean(state.capabilities["configuration.validate_esphome"]),
    compile: published && Boolean(state.capabilities["firmware.compile"]) && !state.builderRequestsRunning.has("compile"),
    install: published && Boolean(state.capabilities["firmware.upload"]) && !state.builderRequestsRunning.has("install"),
  };
}

export function builderRequest(state, operation, createKey) {
  const slot = `${operation}:${state.activeConfig}`;
  state.builderRequestKeys[slot] ||= createKey();
  return { slot, key: state.builderRequestKeys[slot] };
}

export function replaceBuilderJobs(jobs) {
  return Object.fromEntries(jobs.map((job) => [job.job_id, job]));
}

export function sortedBuilderJobs(jobs) {
  return Object.values(jobs).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

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
