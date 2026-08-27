import { expect, test } from "@playwright/test";

import { mockApi, openStoredProject, project } from "./mock-api.mjs";

let apiControl;

test.beforeEach(async ({ page }) => {
  apiControl = await mockApi(page);
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

test("inspects, names, locks and restores an earlier version", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  // The project toolbar lives in a collapsed <details>.
  await page.locator("#server-projects").evaluate((select) => {
    select.closest("details").open = true;
  });
  await page.locator("#server-projects").selectOption("display.lvgldesign");
  await page.locator("#open-revisions").click();
  await expect(page.locator("#revisions-dialog")).toBeVisible();

  // Newest first, and the version on disk is marked as such.
  await expect(page.locator("#revisions-list .revision-row")).toHaveCount(2);
  const rows = page.locator("#revisions-list .revision-row");
  await expect(rows.first()).toHaveClass(/selected/);
  await expect(rows.first().locator(".revision-chip.current")).toBeVisible();
  await expect(rows.nth(1).locator(".revision-chip.mcp")).toBeVisible();
  // The current version cannot be restored onto itself.
  await expect(page.locator("#restore-revision")).toBeDisabled();

  // Selecting the older MCP-authored version shows the diff.
  await rows.nth(1).click();
  await expect(page.locator("#revisions-diff .diff-line")).not.toHaveCount(0);
  // The shared renderer pairs an adjacent -/+ run into changed-old/changed-new.
  await expect(page.locator("#revisions-diff .diff-changed-old")).toBeVisible();
  await expect(page.locator("#revisions-diff .diff-changed-new")).toBeVisible();
  await expect(page.locator("#restore-revision")).toBeEnabled();

  // Naming and locking are independent actions.
  await page.locator("#revision-label").fill("vor dem Umbau");
  await page.locator("#save-revision-label").click();
  await expect(rows.nth(1).locator("strong")).toHaveText("vor dem Umbau");
  await expect(rows.nth(1)).not.toHaveClass(/locked/);
  await page.locator("#toggle-revision-lock").click();
  await expect(rows.nth(1)).toHaveClass(/locked/);
  await expect(rows.nth(1).locator(".revision-chip.locked")).toBeVisible();

  // Restoring adds a new entry on top; the displaced version stays put.
  await page.locator("#restore-revision").click();
  await expect(page.locator("#revisions-list .revision-row")).toHaveCount(3);
  await expect(rows.first().locator(".revision-chip.restore")).toBeVisible();
  await expect(rows.first().locator(".revision-chip.current")).toBeVisible();
  await expect(rows.nth(1).locator(".revision-chip.ui")).toBeVisible();
});

test("a feed entry opens the version it refers to", async ({ page }) => {
  await page.getByRole("button", { name: "System" }).click();
  const feedRows = page.locator("#revision-feed .revision-row");
  await expect(feedRows).toHaveCount(2);

  // The older, MCP-authored entry - the dialog must preselect exactly it.
  await feedRows.nth(1).click();

  await expect(page.locator("#revisions-dialog")).toBeVisible();
  const rows = page.locator("#revisions-list .revision-row");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(rows.nth(1).locator(".revision-chip.mcp")).toBeVisible();
});

test("a change made elsewhere raises a banner that leads to the versions", async ({ page }) => {
  await openStoredProject(page);
  await expect(page.locator("#external-change-banner")).toBeHidden();

  // Someone else - another session or the MCP server - writes the project.
  apiControl.currentRevision = "sha256:ccc";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  const banner = page.locator("#external-change-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("display.lvgldesign");

  await page.locator("#external-change-open").click();
  await expect(page.locator("#revisions-dialog")).toBeVisible();
  await expect(banner).toBeHidden();
});

test("a dismissed banner stays dismissed until the next change", async ({ page }) => {
  await openStoredProject(page);
  apiControl.currentRevision = "sha256:ccc";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#external-change-banner")).toBeVisible();

  await page.locator("#external-change-dismiss").click();
  await expect(page.locator("#external-change-banner")).toBeHidden();

  // Polling again on the same revision must not nag.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  await expect(page.locator("#external-change-banner")).toBeHidden();

  // A further change is a new fact and shows again.
  apiControl.currentRevision = "sha256:ddd";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#external-change-banner")).toBeVisible();
});

test("a project deleted elsewhere is reported as deleted", async ({ page }) => {
  await openStoredProject(page);
  apiControl.exists = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator("#external-change-banner")).toBeVisible();
  // The suite runs in whichever locale the browser reports, so match both.
  await expect(page.locator("#external-change-message")).toContainText(/deleted|gelöscht/);
});

test("an earlier version can be viewed and compared against the current state", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  const rows = page.locator("#revisions-list .revision-row");
  await rows.nth(1).click();

  await page.locator("#preview-revision").click();

  // The viewer takes over from the dialog and says what is on screen.
  await expect(page.locator("#viewer-dialog")).toBeVisible();
  await expect(page.locator("#revisions-dialog")).toBeHidden();
  const bar = page.locator("#viewer-history-bar");
  await expect(bar).toBeVisible();
  await expect(page.locator("#viewer-history-version")).toHaveClass(/active/);
  await expect(page.locator("#viewer-title")).toContainText("display.lvgldesign");
  await expect(page.locator("#viewer-display")).toContainText("Alt");

  // Flipping to the current state swaps what is rendered, in place.
  await page.locator("#viewer-history-compare").click();
  await expect(page.locator("#viewer-history-compare")).toHaveClass(/active/);
  await expect(page.locator("#viewer-history-version")).not.toHaveClass(/active/);
  await expect(page.locator("#viewer-display")).not.toContainText("Alt");

  // And back to the history, with the same version still selected.
  await page.locator("#viewer-history-back").click();
  await expect(page.locator("#viewer-dialog")).toBeHidden();
  await expect(page.locator("#revisions-dialog")).toBeVisible();
  await expect(rows.nth(1)).toHaveClass(/selected/);
});

test("a deleted project falls back to comparing two of its versions", async ({ page }) => {
  await openStoredProject(page);
  apiControl.exists = false;
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();

  // There is no current state to offer, so only the other version remains.
  const options = page.locator("#revision-compare option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).not.toHaveValue("current");

  await page.locator("#preview-revision").click();
  await expect(page.locator("#viewer-history-bar")).toBeVisible();
  // Still comparable - just against a sibling version rather than "current".
  await expect(page.locator("#viewer-history-compare")).toBeEnabled();
  await expect(page.locator('#viewer-history-compare option[value="current"]')).toHaveCount(0);
});

test("the ordinary live preview never inherits the history bar", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();
  await page.locator("#preview-revision").click();
  await expect(page.locator("#viewer-history-bar")).toBeVisible();

  await page.locator("#viewer-history-back").click();
  await page.locator("#close-revisions").click();
  await page.locator("#open-viewer").click();

  await expect(page.locator("#viewer-dialog")).toBeVisible();
  await expect(page.locator("#viewer-history-bar")).toBeHidden();
});

test("compares two earlier versions, not only against the current state", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  const rows = page.locator("#revisions-list .revision-row");
  await rows.nth(1).click();

  // Default target is the current state, and the selected version is not
  // offered as a target for itself.
  await expect(page.locator("#revision-compare")).toHaveValue("current");
  await expect(page.locator("#revision-compare option")).toHaveCount(2);
  await expect(page.locator('#revision-compare option[value="1"]')).toHaveCount(0);

  // Pick the other version as the comparison target.
  await page.locator("#revision-compare").selectOption("2");
  await expect.poll(() => apiControl.lastDiff).toEqual({ id: 1, against: "2" });

  // The viewer inherits that choice instead of falling back to "current".
  await page.locator("#preview-revision").click();
  await expect(page.locator("#viewer-history-compare")).toHaveValue("2");
  await page.locator("#viewer-history-compare").click();
  await expect(page.locator("#viewer-history-compare")).toHaveClass(/active/);
  await expect(page.locator("#viewer-display")).toContainText("Alt");
});

test("a target that becomes the selection gives way", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  const rows = page.locator("#revisions-list .revision-row");
  await rows.nth(1).click();
  await page.locator("#revision-compare").selectOption("2");

  // Selecting the version that was the target must not compare it with itself.
  await rows.nth(0).click();
  await expect(page.locator("#revision-compare")).toHaveValue("current");
  await expect(page.locator('#revision-compare option[value="2"]')).toHaveCount(0);
});

test("the comparison target can be changed inside the viewer", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();
  await page.locator("#preview-revision").click();

  // Inherited from the dialog, and the inspected version is not offered as a
  // target for itself.
  await expect(page.locator("#viewer-history-compare")).toHaveValue("current");
  await expect(page.locator('#viewer-history-compare option[value="1"]')).toHaveCount(0);

  // Choosing a target shows it straight away - no second click needed.
  await page.locator("#viewer-history-compare").selectOption("2");
  await expect(page.locator("#viewer-history-compare")).toHaveClass(/active/);
  await expect(page.locator("#viewer-history-version")).not.toHaveClass(/active/);
  await expect(page.locator("#viewer-display")).toContainText("Alt");

  // And the dialog picks the choice back up on the way out.
  await page.locator("#viewer-history-back").click();
  await expect(page.locator("#revision-compare")).toHaveValue("2");
});

test("the graph lays out every version oldest-first and navigates between them", async ({ page }) => {
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();
  await page.locator("#preview-revision").click();

  const nodes = page.locator("#revision-graph-nodes .revision-node");
  await expect(nodes).toHaveCount(2);
  // Oldest on the left, so the graph reads in the direction time runs.
  await expect(nodes.first()).toHaveAttribute("data-revision-id", "1");
  await expect(nodes.last()).toHaveAttribute("data-revision-id", "2");
  await expect(nodes.first()).toHaveClass(/showing/);
  await expect(page.locator("#viewer-display")).toContainText("Alt 1");

  // Clicking a node moves the inspected version without leaving the viewer.
  await nodes.last().click();
  await expect(nodes.last()).toHaveClass(/showing/);
  await expect(nodes.first()).not.toHaveClass(/showing/);
  await expect(page.locator("#viewer-display")).toContainText("Alt 2");
  // And it becomes the version the bar names, so the target list drops it.
  await expect(page.locator('#viewer-history-compare option[value="2"]')).toHaveCount(0);
});

test("a restore is drawn as an edge back to the version it came from", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  const rows = page.locator("#revisions-list .revision-row");
  await rows.nth(1).click();
  await page.locator("#restore-revision").click();
  await expect(rows).toHaveCount(3);

  // The restored version sits on top and points back at its source.
  await rows.first().click();
  await page.locator("#preview-revision").click();
  await expect(page.locator("#revision-graph-nodes .revision-node")).toHaveCount(3);
  await expect(page.locator("#revision-graph-edges path")).toHaveCount(1);
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
