// The configuration workspace's endpoints - list, read, draft, syntax check,
// diff, publish and the Device Builder jobs - for configurations.spec.mjs.
// Opt-in through mockApi(page, { configurations: true }), so the other
// suites keep a backend without filesystem access.

const ACTIVE = "esphome:\n  name: display\n\nlvgl:\n  widgets: []\n";

export const configurationCapabilities = {
  "configuration.list": true,
  "configuration.read": true,
  "configuration.write_draft": true,
  "configuration.publish": true,
  "configuration.validate_yaml": true,
  "configuration.validate_esphome": true,
  "firmware.compile": true,
  "firmware.upload": true,
};

export const connectedBuilder = {
  state: "connected", compatible: true, reason: null, esphome_version: "2026.10.1",
};

/** A line-by-line diff, enough for the view to show added and removed lines. */
function lineDiff(before, after) {
  const old = before.split("\n");
  const changed = after.split("\n");
  const lines = ["--- active", "+++ draft", `@@ -1,${old.length} +1,${changed.length} @@`];
  for (let index = 0; index < Math.max(old.length, changed.length); index += 1) {
    if (old[index] === changed[index]) {
      lines.push(` ${old[index]}`);
      continue;
    }
    if (old[index] !== undefined) lines.push(`-${old[index]}`);
    if (changed[index] !== undefined) lines.push(`+${changed[index]}`);
  }
  return lines.join("\n");
}

export function createConfigurationMock() {
  const control = {
    name: "display.yaml",
    active: ACTIVE,
    activeRevision: "sha256:c1",
    draft: null,
    nextDraft: 1,
    /** Every write request, in order: {method, path, body, headers}. */
    writes: [],
    jobs: [],
    /** The mocked /jobs/events socket, once the page has opened it. */
    socket: null,
  };
  const json = (route, status, body) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  const draftConflict = (route) => json(route, 409, {
    error: "revision_conflict",
    message: "The configuration draft changed in the meantime.",
    details: { target: "configuration_draft", actual_revision: control.draft?.revision ?? null },
  });
  const draftMatches = (body) => !("expected_draft_revision" in body)
    || body.expected_draft_revision === (control.draft?.revision ?? null);

  async function handleConfiguration(route, suffix, method, body) {
    const name = control.name;
    if (suffix === "" && method === "GET") {
      return json(route, 200, { name, content: control.active, revision: control.activeRevision });
    }
    if (suffix === "/draft" && method === "GET") {
      return control.draft
        ? json(route, 200, { name, content: control.draft.content, revision: control.draft.revision })
        : json(route, 404, { error: "draft_not_found", message: "No draft exists." });
    }
    if (suffix === "/draft" && method === "PUT") {
      if (!draftMatches(body)) return draftConflict(route);
      control.draft = { content: body.content, revision: `sha256:d${control.nextDraft++}` };
      return json(route, 200, { name, revision: control.draft.revision });
    }
    if (suffix === "/check-yaml") {
      const fromDraft = new URL(route.request().url()).searchParams.get("source") === "draft";
      const content = fromDraft ? control.draft.content : control.active;
      const broken = content.split("\n").findIndex((line) => line.includes("broken"));
      if (broken >= 0) {
        return json(route, 200, {
          valid: false, line: broken + 1, column: 3, error: "mapping values are not allowed here",
        });
      }
      return json(route, 200, {
        valid: true, revision: fromDraft ? control.draft.revision : control.activeRevision,
      });
    }
    if (suffix === "/diff") {
      return json(route, 200, { diff: lineDiff(control.active, control.draft.content) });
    }
    if (suffix === "/publish") {
      if (body.expected_revision !== control.activeRevision) {
        return json(route, 409, {
          error: "revision_conflict", message: "The active configuration changed.",
          details: { target: "configuration", actual_revision: control.activeRevision },
        });
      }
      if (!draftMatches(body)) return draftConflict(route);
      control.active = control.draft.content;
      control.activeRevision = "sha256:c2";
      control.draft = null;
      return json(route, 200, { name, revision: control.activeRevision });
    }
    if (suffix === "/validate") {
      return json(route, 200, {
        valid: true, revision: control.activeRevision,
        output: ["INFO Configuration is valid!"], expires_in_seconds: 600,
      });
    }
    if (suffix === "/compile" || suffix === "/install") {
      const job = {
        job_id: `job-${control.jobs.length + 1}`, configuration: name,
        job_type: suffix.slice(1), status: "queued", progress: 0,
        created_at: `2026-11-21T10:0${control.jobs.length}:00+00:00`,
      };
      control.jobs.push(job);
      return json(route, 200, { job, revision: control.activeRevision, idempotent_replay: false });
    }
    return json(route, 404, { error: "not_mocked", message: `${method} ${suffix}` });
  }

  /** Answer a configuration or job request; false for every other path. */
  async function handle(route, path, method) {
    if (path === "configurations" && method === "GET") {
      await json(route, 200, { configurations: [{
        name: control.name, size: control.active.length,
        has_draft: Boolean(control.draft), revision: control.activeRevision,
      }] });
      return true;
    }
    const configuration = path.match(/^configurations\/([^/]+)(\/[a-z-]+)?$/);
    if (configuration && decodeURIComponent(configuration[1]) === control.name) {
      const body = method === "GET" ? null : route.request().postDataJSON();
      if (method !== "GET") {
        control.writes.push({ method, path, body, headers: route.request().headers() });
      }
      await handleConfiguration(route, configuration[2] || "", method, body || {});
      return true;
    }
    if (path === "jobs" && method === "GET") {
      await json(route, 200, { jobs: control.jobs });
      return true;
    }
    const cancel = path.match(/^jobs\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") {
      const job = control.jobs.find((item) => item.job_id === decodeURIComponent(cancel[1]));
      job.status = "cancelled";
      await route.fulfill({ status: 204 });
      return true;
    }
    return false;
  }

  /** The job event stream: a status first, like the backend, then whatever
   * a test pushes through control.socket. */
  function handleJobEvents(socket) {
    control.socket = socket;
    socket.send(JSON.stringify({ type: "builder_status", builder: connectedBuilder }));
  }

  return { control, handle, handleJobEvents };
}
