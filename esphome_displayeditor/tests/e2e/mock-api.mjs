import { expect } from "@playwright/test";

// Shared by app.spec.mjs and layout.spec.mjs: one mocked backend, so the
// behavioural and the geometry suites exercise the very same screens.

export const project = {
  format_version: 2,
  canvas: { width: 320, height: 240 },
  widgets: [], pages: [], top_layer: [], bottom_layer: [],
  styles: [], colors: [], fonts: [], images: [], msgboxes: [], glow_strokes: [],
  background: {}, extra_lvgl: {}, extra: {},
};

const revisionVersions = [
  {
    id: 2, revision: "sha256:bbb", created_at: "2026-08-27T10:00:00+00:00",
    actor: "ha:smoke", origin: "ui", action: "save", byte_size: 900,
    encoding: "zlib", restored_from: null, label: null, locked: false,
    is_current: true, restorable: null, details: null,
  },
  {
    id: 1, revision: "sha256:aaa", created_at: "2026-08-27T09:00:00+00:00",
    actor: "mcp:lan:abcdef", origin: "mcp", action: "save", byte_size: 880,
    encoding: "zlib", restored_from: null, label: null, locked: false,
    is_current: false, restorable: null, details: null,
  },
];

function longDiff() {
  const context = Array.from(
    { length: 200 },
    (_unused, index) => `   "line_${index}": ${index},
`,
  ).join("");
  return `--- a
+++ b
@@ -1,201 +1,201 @@
-  "width": 320
+  "width": 480
${context}`;
}

/** What the source config says beyond the stored project. Off by default:
 * a plan with changes opens a modal on load, which every other spec would
 * then have to dismiss before it could touch the editor. */
export const sourcePlanWithChanges = {
  available: true,
  changed: true,
  source: {
    name: "display.yaml",
    revision: "sha256:ddd",
    known_revision: "sha256:ccc",
  },
  groups: [
    {
      key: "entities", changed: 1, removes: 0,
      changes: [{ kind: "added", label: "sensor.pump_state", line: 12 }],
      changes_truncated: 0, losses: [], losses_truncated: 0, binding_losses: [],
    },
    {
      key: "layout", changed: 1, removes: 1,
      changes: [{ kind: "removed", label: "label title", line: null }],
      changes_truncated: 0,
      losses: [{ kind: "removed", label: "label title", line: null }],
      losses_truncated: 0,
      binding_losses: [{ id: "show_level", missing: ["title"] }],
    },
  ],
  unsupported: [
    { severity: "B", message: "widget type 'spinbox' is not supported.",
      path: "lvgl.widgets[4]", line: 31 },
  ],
  unsupported_truncated: 0,
  binding_losses: [{ id: "show_level", missing: ["title"] }],
};

export async function mockApi(page) {
  const mcpClients = [];
  const versions = revisionVersions.map((item) => ({ ...item }));
  // Shared by the resync and the restore handler: both append a version, and
  // a hardcoded id in either would collide once a test does both.
  let nextVersionId = versions.length + 1;
  const control = {
    currentRevision: "sha256:bbb",
    exists: true,
    lastDiff: null,
    sourcePlan: { available: false, reason: "no_source" },
    lastResync: null,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1\//, "");
    const method = route.request().method();
    if (path === "admin/mcp/test" && method === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reachable: true, status: "ok", latency_ms: 4 }) });
      return;
    }
    if (path === "admin/mcp/tokens" && method === "POST") {
      const input = route.request().postDataJSON();
      const client = {
        id: "0123456789abcdef01234567",
        name: input.name,
        scopes: input.scopes,
        created_at: "2026-08-21T10:00:00+00:00",
        expires_at: "2026-09-20T10:00:00+00:00",
        revoked_at: null,
        status: "active",
      };
      mcpClients.push(client);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ client, token: "mcp_one-time-secret" }) });
      return;
    }
    if (path.startsWith("admin/mcp/tokens/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("admin/mcp/tokens/".length));
      const client = mcpClients.find((item) => item.id === id);
      Object.assign(client, { status: "revoked", revoked_at: "2026-08-21T10:05:00+00:00" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ client }) });
      return;
    }
    const sourceMatch = path.match(/^designer\/projects\/([^/]+)\/source(\/apply)?$/);
    if (sourceMatch) {
      if (!sourceMatch[2]) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          name: "display.lvgldesign", revision: control.currentRevision,
          ...control.sourcePlan,
        }) });
        return;
      }
      control.lastResync = route.request().postDataJSON();
      const displaced = versions.find((item) => item.is_current);
      versions.forEach((item) => { item.is_current = false; });
      versions.unshift({
        id: nextVersionId++, revision: "sha256:eee",
        created_at: "2026-08-27T12:00:00+00:00", actor: "ha:smoke",
        origin: "resync", action: "save", byte_size: 950, encoding: "zlib",
        restored_from: null, label: null, locked: false, is_current: true,
        restorable: null,
        details: {
          source: { name: "display.yaml", revision: "sha256:ddd",
                    previous_revision: "sha256:ccc" },
          groups: control.lastResync.groups,
          dropped_bindings: [],
          replaced_revision: displaced?.revision || null,
        },
      });
      if (control.lastResync.lock_previous && displaced) displaced.locked = true;
      control.currentRevision = "sha256:eee";
      control.sourcePlan = { available: true, changed: false, groups: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        name: "display.lvgldesign", revision: "sha256:eee", issues: [],
        groups: control.lastResync.groups,
        dropped_bindings: control.lastResync.groups.includes("layout")
          ? [{ id: "show_level", missing: ["title"] }] : [],
        previous_locked: control.lastResync.lock_previous
          ? { locked: true, id: displaced?.id } : null,
        source: { name: "display.yaml", revision: "sha256:ddd",
                  previous_revision: "sha256:ccc" },
        project: { ...project, widgets: [{ id: "from_source", widget_type: "label",
          x: 10, y: 10, width: 100, height: 20, properties: { text: "Aus der Quelle" },
          style_tree: {}, children: [] }] },
      }) });
      return;
    }
    // Strict on the project name on purpose: a permissive pattern here once
    // masked the dialog asking for "[object PointerEvent]".
    const revisionMatch = path.match(
      /^designer\/projects\/([^/]+)\/revisions(?:\/(\d+))?(\/[a-z]+)?$/,
    );
    if (revisionMatch) {
      const [, projectName, rawId, suffix] = revisionMatch;
      if (decodeURIComponent(projectName) !== "display.lvgldesign") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
          error: "invalid_project_name", message: `unexpected project '${projectName}'`,
        }) });
        return;
      }
      const id = rawId ? Number(rawId) : null;
      const version = versions.find((item) => item.id === id);
      if (!rawId) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          name: "display.lvgldesign", exists: control.exists,
          current_revision: control.currentRevision,
          depth: 10, locked_depth: 5,
          locked_used: versions.filter((item) => item.locked).length,
          versions,
        }) });
        return;
      }
      if (suffix === "/diff") {
        control.lastDiff = {
          id,
          against: new URL(route.request().url()).searchParams.get("against"),
        };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          name: "display.lvgldesign",
          from: { id, revision: version.revision, created_at: version.created_at },
          to: { id: null, revision: "sha256:bbb", created_at: null },
          // Long on purpose: the layout suite needs a diff that actually
          // overflows its pane, which a five-line diff never would.
          diff: longDiff(),
          diff_truncated: false,
        }) });
        return;
      }
      if (suffix === "/lock") {
        version.locked = method === "POST";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(version) });
        return;
      }
      if (suffix === "/restore") {
        versions.forEach((item) => { item.is_current = false; });
        versions.unshift({
          ...version, id: nextVersionId++, origin: "restore", actor: "ha:smoke",
          created_at: "2026-08-27T11:00:00+00:00", restored_from: id,
          // A restore describes itself through restored_from; carrying the
          // restored version's import details along would claim the YAML moved.
          label: null, locked: false, is_current: true, details: null,
        });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          name: "display.lvgldesign", revision: version.revision, issues: [],
          restored_from: { id, revision: version.revision },
        }) });
        return;
      }
      if (method === "PATCH") {
        version.label = route.request().postDataJSON().label;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(version) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...version, issues: [], restorable: true,
        project: { ...project, widgets: [{ id: "old_label", widget_type: "label", x: 10, y: 10, width: 100, height: 20, properties: { text: `Alt ${id}` }, style_tree: {}, children: [] }] } }) });
      return;
    }
    const payloads = {
      health: { status: "ok" },
      system: { access_level: "write", user: { role: "administrator", name: "smoke" } },
      capabilities: { capabilities: { "designer.project": true, "designer.project_write": true, "mcp.manage": true } },
      "designer/schemas": { widgets: [{ type_key: "label", label: "Label", category: "display", default_size: [100, 40], allows_children: false, properties: [] }], grid_cell_properties: [], states: [] },
      "designer/projects": { projects: [{ name: "display.lvgldesign", size: 900, revision: "sha256:bbb", updated_at: "2026-08-27T10:00:00+00:00" }] },
      "designer/revisions": { limit: 50, events: [
        { id: 2, project_name: "display.lvgldesign", revision: "sha256:bbb",
          created_at: "2026-08-27T10:00:00+00:00", actor: "ha:smoke", origin: "ui",
          action: "save", byte_size: 900, encoding: "zlib", restored_from: null,
          label: null, locked: false, project_exists: true },
        { id: 1, project_name: "display.lvgldesign", revision: "sha256:aaa",
          created_at: "2026-08-27T09:00:00+00:00", actor: "mcp:lan:abcdef", origin: "mcp",
          action: "save", byte_size: 880, encoding: "zlib", restored_from: null,
          label: null, locked: false, project_exists: true },
      ] },
      "designer/projects/display.lvgldesign": {
        name: "display.lvgldesign", project, revision: "sha256:bbb", issues: [],
      },
      "viewer/bindings/display.lvgldesign": { bindings: [], revision: null },
      "admin/mcp/tokens": {
        clients: mcpClients,
        allowed_scopes: ["server:read", "project:read", "configuration:read", "device:read", "project:write", "changeset:read", "changeset:apply"],
        maximum: 100,
      },
      "admin/mcp/status": {
        mode: "lan", access: "project_write", port: 8100, path: "/mcp",
        health_path: "/health", allowed_hosts: ["localhost"], configured: true,
      },
    };
    const key = path.startsWith("designer/schemas") ? "designer/schemas" : path;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payloads[key] || {}) });
  });
  return control;
}

export async function openStoredProject(page) {
  await page.locator("#server-projects").evaluate((select) => {
    select.closest("details").open = true;
  });
  await page.locator("#server-projects").selectOption("display.lvgldesign");
  await page.locator("#load-server-project").click();
  await expect(page.locator("#open-revisions")).toBeEnabled();
}

