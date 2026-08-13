import { expect, test } from "@playwright/test";

const project = {
  format_version: 2,
  canvas: { width: 320, height: 240 },
  widgets: [], pages: [], top_layer: [], bottom_layer: [],
  styles: [], colors: [], fonts: [], images: [], msgboxes: [], glow_strokes: [],
  background: {}, extra_lvgl: {}, extra: {},
};

async function mockApi(page) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1\//, "");
    const payloads = {
      health: { status: "ok" },
      system: { access_level: "write", user: { role: "administrator", name: "smoke" } },
      capabilities: { capabilities: { "designer.project": true, "designer.project_write": true } },
      "designer/schemas": { widgets: [{ type_key: "label", label: "Label", category: "display", default_size: [100, 40], allows_children: false, properties: [] }], grid_cell_properties: [], states: [] },
      "designer/projects": { projects: [] },
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
