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
    is_current: true, restorable: null,
  },
  {
    id: 1, revision: "sha256:aaa", created_at: "2026-08-27T09:00:00+00:00",
    actor: "mcp:lan:abcdef", origin: "mcp", action: "save", byte_size: 880,
    encoding: "zlib", restored_from: null, label: null, locked: false,
    is_current: false, restorable: null,
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

export async function mockApi(page) {
  const mcpClients = [];
  const versions = revisionVersions.map((item) => ({ ...item }));
  const control = { currentRevision: "sha256:bbb", exists: true, lastDiff: null };
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
          ...version, id: 3, origin: "restore", actor: "ha:smoke",
          created_at: "2026-08-27T11:00:00+00:00", restored_from: id,
          label: null, locked: false, is_current: true,
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

