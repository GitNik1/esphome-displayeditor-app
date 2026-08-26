import { expect, test } from "@playwright/test";

const project = {
  format_version: 2,
  canvas: { width: 320, height: 240 },
  widgets: [], pages: [], top_layer: [], bottom_layer: [],
  styles: [], colors: [], fonts: [], images: [], msgboxes: [], glow_strokes: [],
  background: {}, extra_lvgl: {}, extra: {},
};

async function mockApi(page) {
  const mcpClients = [];
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
    const payloads = {
      health: { status: "ok" },
      system: { access_level: "write", user: { role: "administrator", name: "smoke" } },
      capabilities: { capabilities: { "designer.project": true, "designer.project_write": true, "mcp.manage": true } },
      "designer/schemas": { widgets: [{ type_key: "label", label: "Label", category: "display", default_size: [100, 40], allows_children: false, properties: [] }], grid_cell_properties: [], states: [] },
      "designer/projects": { projects: [] },
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
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);
});

test("starts and switches primary views", async ({ page }) => {
  await expect(page.getByText("ESPHome Display Editor", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator("#system")).toHaveClass(/active/);
});

test("administrator creates, receives and revokes a scoped MCP credential", async ({ page }) => {
  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator("#mcp-token-card")).toBeVisible();
  await page.locator("#test-mcp-listener").click();
  await expect(page.locator("#mcp-listener-status.ok")).toBeVisible();
  await page.locator("#create-mcp-token").click();
  await page.locator("#mcp-token-name").fill("Claude Code Notebook");
  await expect(page.locator('#mcp-token-scopes input:checked')).toHaveCount(4);
  await page.locator("#submit-mcp-token").click();

  await expect(page.locator("#mcp-token-secret-dialog")).toBeVisible();
  await expect(page.locator("#mcp-token-secret")).toHaveValue("mcp_one-time-secret");
  await expect(page.locator("#mcp-client-endpoint")).toHaveValue("http://127.0.0.1:8100/mcp");
  await expect(page.locator("#mcp-claude-command")).toHaveValue(/Authorization: Bearer mcp_one-time-secret/);
  await expect(page.locator("#mcp-project-json")).toHaveValue(/ESPHOME_EDITOR_MCP_TOKEN/);
  await page.locator("#close-mcp-token-secret").click();
  await expect(page.locator("#mcp-token-secret")).toHaveValue("");
  await expect(page.locator("#mcp-claude-command")).toHaveValue("");
  await expect(page.locator("#mcp-token-list")).toContainText("Claude Code Notebook");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#mcp-token-list .button.danger").click();
  await expect(page.locator("#mcp-token-list .mcp-token-status.revoked")).toBeVisible();
  await expect(page.locator("#mcp-token-list .button.danger")).toHaveCount(0);
});

test("adds a widget and supports undo and redo", async ({ page }) => {
  await page.getByRole("button", { name: /Label/ }).click();
  await expect(page.locator("#canvas .canvas-widget")).toHaveCount(1);
  await page.locator("#undo").click();
  await expect(page.locator("#canvas .canvas-widget")).toHaveCount(0);
  await page.locator("#redo").click();
  await expect(page.locator("#canvas .canvas-widget")).toHaveCount(1);
});

test("creates a fresh project", async ({ page }) => {
  await page.evaluate((nextProject) => { window.__appState.project = nextProject; }, { ...project, widgets: [{ id: "old", widget_type: "label", children: [], properties: {}, style_tree: {} }] });
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#new-project").click();
  await expect(page.locator("#canvas .canvas-widget")).toHaveCount(0);
});

test("viewer remains switchable between HTML and complete LVGL WASM", async ({ page }) => {
  await page.evaluate((nextProject) => {
    window.__appState.project = nextProject;
  }, {
    ...project,
    canvas: { width: 320, height: 240 },
    widgets: [
      { id: "title", widget_type: "label", x: 15, y: 15, width: 160, height: 28, properties: { text: "Dual renderer" }, style_tree: {}, children: [] },
      { id: "toggle", widget_type: "switch", x: 20, y: 70, width: 54, height: 28, properties: { state_checked: true }, style_tree: {}, children: [] },
      { id: "action", widget_type: "button", x: 100, y: 70, width: 120, height: 42, properties: { text: "Update" }, style_tree: {}, children: [], events: { on_click: [{ "lvgl.label.update": { id: "title", text: "Native action" } }] } },
    ],
  });
  await page.locator("#open-viewer").click();
  await expect(page.locator("#viewer-dialog")).toBeVisible();
  await expect(page.locator("#viewer-display .viewer-widget")).toHaveCount(3);
  await page.locator("#viewer-renderer").selectOption("wasm");
  await expect(page.locator("#viewer-display canvas.viewer-wasm-canvas")).toBeVisible();
  await expect(page.locator("#viewer-status")).toContainText("LVGL v9.2.2 / WASM");
  const box = await page.locator("#viewer-display canvas").boundingBox();
  await page.mouse.click(box.x + box.width * 160 / 320, box.y + box.height * 91 / 240);
  await page.locator("#viewer-renderer").selectOption("html");
  await expect(page.locator("#viewer-display .viewer-widget")).toHaveCount(3);
  await expect(page.locator('[data-widget-id="title"] .viewer-widget-text')).toHaveText("Native action");
});
