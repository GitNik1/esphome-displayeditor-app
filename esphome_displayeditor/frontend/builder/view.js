// @ts-check

import { encodedName } from "../api/client.js";
import {
  applyBuilderEvent,
  builderAvailability,
  builderBlockedReason,
  builderRequest,
  replaceBuilderJobs,
  sortedBuilderJobs,
} from "./model.js";

/** @typedef {import("./model.js").BuilderJob} BuilderJob */
/** @typedef {ReturnType<typeof import("../controllers/builder-controller.js").createBuilderController>} BuilderController */
/** @typedef {typeof import("../services/websocket.js").createJsonSocket} CreateSocket */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {(message: string, error?: boolean, details?: unknown) => void} Notify */
/**
 * @typedef {{
 *   activeConfig: string | null, hasDraft: boolean, capabilities: Record<string, unknown>,
 *   system: {builder?: Parameters<typeof builderBlockedReason>[0]} | null,
 *   builderJobs: Record<string, BuilderJob>, builderSocket: unknown,
 *   builderRequestKeys: Record<string, string>, builderRequestsRunning: Set<string>,
 * }} BuilderViewState
 */
/**
 * @typedef {{
 *   validate: HTMLButtonElement, compile: HTMLButtonElement, install: HTMLButtonElement,
 *   refreshJobs: HTMLButtonElement, panel: HTMLElement, list: HTMLElement, output: HTMLElement,
 * }} BuilderElements
 */

const JOB_TOASTS = {
  compile: { started: "toast.builder.jobStarted", restored: "toast.builder.jobRestored" },
  install: { started: "toast.builder.otaStarted", restored: "toast.builder.otaRestored" },
};

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function randomRequestKey() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-request`;
}

/**
 * The Device Builder part of the configuration view: ESPHome validation,
 * compiling and OTA-installing the published configuration, and the job
 * list the event stream keeps current.
 * @param {{
 *   els: BuilderElements, state: BuilderViewState, t: Translate, toast: Notify,
 *   confirm: (message: string) => boolean, controller: BuilderController,
 *   createSocket: CreateSocket, createKey?: () => string,
 * }} deps
 */
export function createBuilderView({
  els, state, t, toast, confirm, controller, createSocket, createKey = randomRequestKey,
}) {
  /** @type {ReturnType<CreateSocket> | null} */
  let events = null;
  const notifyError = (/** @type {any} */ error) => toast(error.message, true, error.details);

  // Each action needs a published file, the capability and - for jobs - no
  // request of its own kind in flight; the disabled button says which.
  function updateButtons() {
    const available = builderAvailability(state);
    const hasConfig = Boolean(state.activeConfig);
    const published = hasConfig && !state.hasDraft;
    const blocked = builderBlockedReason(state.system?.builder);
    const unavailable = blocked ? t(blocked.key, blocked.values) : t("configs.hint.noPermission");
    /** @param {HTMLButtonElement} button @param {boolean} enabled
     * @param {string} capability @param {string} [operation] */
    const update = (button, enabled, capability, operation) => {
      button.disabled = !enabled;
      button.title = !hasConfig ? t("configs.hint.noConfig")
        : !published ? t("configs.hint.publishFirst")
        : !state.capabilities[capability] ? unavailable
        : operation && state.builderRequestsRunning.has(operation) ? t("configs.hint.alreadyRunning")
        : "";
    };
    update(els.validate, available.validate, "configuration.validate_esphome");
    update(els.compile, available.compile, "firmware.compile", "compile");
    update(els.install, available.install, "firmware.upload", "install");
  }

  async function validate() {
    const name = state.activeConfig;
    if (!name || state.hasDraft) return;
    const { output } = els;
    output.classList.remove("diff-output");
    output.textContent = t("config.output.validating");
    output.classList.remove("hidden");
    try {
      const result = await controller.validate(encodedName(name));
      const lines = Array.isArray(result.output) ? result.output.join("\n") : "";
      const validity = result.valid
        ? t("config.output.buildApprovalSuffix", { seconds: result.expires_in_seconds })
        : "";
      const verdict = result.valid ? t("config.output.espValid") : t("config.output.espInvalid");
      output.textContent = `${verdict}\nRevision: ${result.revision}${validity}\n\n${lines}`.trim();
    } catch (/** @type {any} */ error) {
      output.textContent = `${error.code || t("config.output.errorFallback")}: ${error.message}`;
      notifyError(error);
    }
  }

  /** @param {"compile" | "install"} operation */
  async function startJob(operation) {
    const name = state.activeConfig;
    if (!name || state.hasDraft) return;
    if (operation === "install" && !confirm(t("confirm.firmware.installOta", { name }))) return;
    // The key survives a failed attempt, so retrying it cannot start a
    // second job for the same click.
    const request = builderRequest(state, operation, createKey);
    state.builderRequestsRunning.add(operation);
    updateButtons();
    try {
      const result = await controller[operation](encodedName(name), request.key);
      delete state.builderRequestKeys[request.slot];
      state.builderJobs[result.job.job_id] = result.job;
      renderJobs();
      const messages = JOB_TOASTS[operation];
      toast(t(result.idempotent_replay ? messages.restored : messages.started, { id: result.job.job_id }));
    } catch (error) { notifyError(error); }
    finally {
      state.builderRequestsRunning.delete(operation);
      updateButtons();
    }
  }

  async function loadJobs() {
    if (!state.capabilities["firmware.compile"]) return;
    try {
      state.builderJobs = replaceBuilderJobs(await controller.jobs());
      renderJobs();
    } catch (error) { notifyError(error); }
  }

  /** @param {BuilderJob} job */
  function jobRow(job) {
    const document = els.list.ownerDocument;
    const row = document.createElement("div");
    row.className = "builder-job";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${job.configuration || "—"} · ${job.job_type || t("configs.jobFallback")}`;
    const meta = document.createElement("small");
    const progress = Number.isFinite(job.progress) ? ` · ${job.progress}%` : "";
    meta.textContent = `${job.status || t("configs.statusUnknown")}${progress} · ${job.job_id}`;
    description.append(title, meta);
    if (job.last_output) {
      const log = document.createElement("pre");
      log.className = "builder-job-output";
      log.textContent = job.last_output;
      description.append(log);
    }
    row.append(description);
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      const cancel = document.createElement("button");
      cancel.className = "button subtle compact";
      cancel.textContent = t("configs.cancelJob");
      cancel.addEventListener("click", async () => {
        try {
          await controller.cancel(job.job_id);
          await loadJobs();
        } catch (error) { notifyError(error); }
      });
      row.append(cancel);
    }
    return row;
  }

  function renderJobs() {
    const jobs = sortedBuilderJobs(state.builderJobs);
    els.panel.classList.toggle("hidden", !state.capabilities["firmware.compile"]);
    els.list.replaceChildren(...jobs.map(jobRow));
    if (!jobs.length) els.list.textContent = t("configs.noJobs");
  }

  function connectEvents() {
    if (!state.capabilities["firmware.compile"] || events?.socket) return;
    events ||= createSocket({
      path: "jobs/events",
      onOpen: (socket) => { state.builderSocket = socket; },
      onClose: () => { state.builderSocket = null; },
      onMessage: (rawPayload) => {
        const payload = /** @type {any} */ (rawPayload);
        if (payload.type === "resync_required") {
          loadJobs();
          return;
        }
        if (payload.type !== "builder_job" || !payload.data) return;
        applyBuilderEvent(state.builderJobs, payload);
        renderJobs();
      },
    });
    state.builderSocket = events.connect();
  }

  return {
    bind() {
      els.validate.addEventListener("click", validate);
      els.compile.addEventListener("click", () => startJob("compile"));
      els.install.addEventListener("click", () => startJob("install"));
      els.refreshJobs.addEventListener("click", () => loadJobs());
    },
    updateButtons,
    loadJobs,
    connectEvents,
  };
}
