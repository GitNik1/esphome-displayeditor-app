import { expect, test } from "@playwright/test";

import { STRINGS } from "../../frontend/i18n.js";
import { mockApi } from "./mock-api.mjs";

// The configuration workspace end to end against the mocked backend: open a
// file, edit, save a draft, check, compare, merge, publish, and follow
// Device Builder jobs. Assertions avoid UI text where they can - the
// browser's language decides between the German and English tables.

let config;

test.beforeEach(async ({ page }) => {
  config = (await mockApi(page, { configurations: true })).configurations;
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);
  await page.locator('.tab[data-tab="configurations"]').click();
  await page.locator("#config-list .config-item").filter({ hasText: "display.yaml" }).click();
  await expect(page.locator("#yaml-editor")).toHaveValue(config.active);
});

test("edits, saves, checks, compares and publishes a draft", async ({ page }) => {
  const editor = page.locator("#yaml-editor");
  await expect(page.locator("#config-title")).toHaveText("display.yaml");
  await expect(page.locator("#revision")).toHaveText("c1");
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/active-state/);
  expect(await page.locator("#yaml-line-numbers").textContent()).toBe("1\n2\n3\n4\n5\n6");
  await expect(page.locator("#publish")).toBeDisabled();
  await expect(page.locator("#show-diff")).toBeDisabled();

  await editor.fill(config.active.replace("name: display", "name: kitchen"));
  await expect(page.locator("#yaml-dirty-status")).toHaveClass(/dirty/);
  await page.locator("#save-draft").click();
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/draft-state/);
  await expect(page.locator("#yaml-dirty-status")).not.toHaveClass(/dirty/);
  expect(config.draft.content).toContain("name: kitchen");
  // The first draft is saved against "there is no draft yet".
  expect(config.writes.at(-1)).toMatchObject({ method: "PUT", body: { expected_draft_revision: null } });
  await expect(page.locator("#config-list .config-item.active small")).toHaveClass(/draft-dot/);

  await page.locator("#check-yaml").click();
  await expect(page.locator("#config-output")).toContainText("sha256:d1");
  await page.locator("#show-diff").click();
  await expect(page.locator("#config-output")).toHaveClass(/diff-output/);
  await expect(page.locator("#config-output .diff-changed-new")).toHaveText("+  name: kitchen");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#publish").click();
  await expect(page.locator("#revision")).toHaveText("c2");
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/active-state/);
  await expect(page.locator("#publish")).toBeDisabled();
  expect(config.writes.at(-1)).toMatchObject({
    path: "configurations/display.yaml/publish",
    body: { expected_revision: "sha256:c1", expected_draft_revision: "sha256:d1" },
  });
  expect(config.active).toContain("name: kitchen");
});

test("a syntax error moves the cursor to the reported position", async ({ page }) => {
  await page.locator("#yaml-editor").fill("esphome:\n  name: display\nbroken: [\n");
  await page.locator("#save-draft").click();
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/draft-state/);
  await page.locator("#check-yaml").click();
  await expect(page.locator("#config-output")).toContainText("mapping values are not allowed here");
  await expect(page.locator("#yaml-cursor-status")).toHaveText(/3\D+3/);
  const caret = await page.locator("#yaml-editor").evaluate((editor) => editor.selectionStart);
  expect(caret).toBe("esphome:\n  name: display\n".length + 2);
});

test("search selects each match in turn and Tab indents", async ({ page }) => {
  const editor = page.locator("#yaml-editor");
  const result = page.locator("#yaml-search-result");
  await editor.fill("name: a\nname: b\nother: c\n");
  await page.locator("#yaml-search").fill("name");
  await expect(result).toHaveText(/1\D+2/);
  await page.locator("#yaml-search-next").click();
  await expect(result).toHaveText(/2\D+2/);
  expect(await editor.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([8, 12]);
  await page.locator("#yaml-search").press("Enter");
  await expect(result).toHaveText(/1\D+2/);
  await page.locator("#yaml-search-previous").click();
  await expect(result).toHaveText(/2\D+2/);
  await page.locator("#yaml-search").fill("absent");
  await expect(result).not.toHaveText(/\d/);

  await editor.evaluate((node) => node.setSelectionRange(0, 0));
  await editor.press("Tab");
  await expect(editor).toHaveValue("  name: a\nname: b\nother: c\n");
  await expect(page.locator("#yaml-dirty-status")).toHaveClass(/dirty/);
});

test("a draft changed elsewhere is refused instead of overwritten", async ({ page }) => {
  const editor = page.locator("#yaml-editor");
  await editor.fill(`${config.active}# mine\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/draft-state/);
  // An MCP client or a second tab saves its own draft meanwhile.
  config.draft = { content: "esphome:\n  name: theirs\n", revision: "sha256:mcp" };

  await editor.fill(`${config.active}# mine again\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#toast")).toContainText(/elsewhere|anderer Stelle/);
  expect(config.draft.revision).toBe("sha256:mcp");
  await expect(page.locator("#yaml-dirty-status")).toHaveClass(/dirty/);
});

test("publishing waits until the editor's edits are saved", async ({ page }) => {
  const editor = page.locator("#yaml-editor");
  await editor.fill(`${config.active}# first\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#publish")).toBeEnabled();

  // The server would publish the saved draft, not what is on screen.
  await editor.fill(`${config.active}# second, not saved\n`);
  await expect(page.locator("#publish")).toBeDisabled();
  await expect(page.locator("#publish")).toHaveAttribute("title", /save|speichern/i);
  await page.locator("#save-draft").click();
  await expect(page.locator("#publish")).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#publish").click();
  await expect(page.locator("#revision")).toHaveText("c2");
  expect(config.active).toContain("# second, not saved");
  await expect(page.locator("#yaml-dirty-status")).not.toHaveClass(/dirty/);
});

test("cancelling the merge dialog does not hide a draft changed elsewhere", async ({ page }) => {
  const editor = page.locator("#yaml-editor");
  await editor.fill(`${config.active}# mine\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#merge-draft")).toBeEnabled();
  config.draft = { content: "esphome:\n  name: theirs\n", revision: "sha256:mcp" };

  // The dialog shows their draft; the editor still holds one based on mine.
  await page.locator("#merge-draft").click();
  await expect(page.locator("#merge-draft-source")).toHaveValue(/theirs/);
  await page.locator("#cancel-merge").click();
  await editor.fill(`${config.active}# mine, edited\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#toast")).toContainText(/elsewhere|anderer Stelle/);
  expect(config.draft.revision).toBe("sha256:mcp");
});

test("the merge dialog saves the merged text as the draft", async ({ page }) => {
  await page.locator("#yaml-editor").fill(config.active.replace("display", "kitchen"));
  await page.locator("#save-draft").click();
  await expect(page.locator("#merge-draft")).toBeEnabled();
  await page.locator("#merge-draft").click();
  await expect(page.locator("#merge-dialog")).toBeVisible();
  await expect(page.locator("#merge-active")).toHaveValue(config.active);
  await expect(page.locator("#merge-draft-source")).toHaveValue(/kitchen/);
  await expect(page.locator("#merge-result")).toHaveValue(/kitchen/);

  await page.locator("#merge-result").fill("esphome:\n  name: merged\n");
  await page.locator("#save-merge").click();
  await expect(page.locator("#merge-dialog")).toBeHidden();
  await expect(page.locator("#yaml-editor")).toHaveValue("esphome:\n  name: merged\n");
  expect(config.draft).toEqual({ content: "esphome:\n  name: merged\n", revision: "sha256:d2" });
  expect(config.writes.at(-1).body.expected_draft_revision).toBe("sha256:d1");
});

test("builder actions wait for a published configuration and say why", async ({ page }) => {
  await page.locator("#yaml-editor").fill(`${config.active}# draft\n`);
  await page.locator("#save-draft").click();
  await expect(page.locator("#yaml-state-badge")).toHaveClass(/draft-state/);
  for (const id of ["#validate-esphome", "#compile-config", "#install-config"]) {
    await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator(id)).toHaveAttribute("title", /publish|veröffentlichen/i);
  }
});

test("validates, compiles, follows and cancels firmware jobs", async ({ page }) => {
  await expect(page.locator("#builder-jobs")).toBeVisible();
  await expect.poll(() => config.socket).not.toBeNull();

  await page.locator("#validate-esphome").click();
  await expect(page.locator("#config-output")).toContainText("INFO Configuration is valid!");

  await page.locator("#compile-config").click();
  const job = page.locator("#builder-job-list .builder-job").filter({ hasText: "job-1" });
  await expect(job).toContainText("queued");
  expect(config.writes.at(-1).headers["idempotency-key"]).toBeTruthy();
  await expect(page.locator("#compile-config")).toBeEnabled();

  config.socket.send(JSON.stringify({
    type: "builder_job", event: "job_output", data: { job_id: "job-1", line: "Compiling main.cpp" },
  }));
  await expect(job.locator(".builder-job-output")).toHaveText("Compiling main.cpp");
  config.socket.send(JSON.stringify({
    type: "builder_job", event: "job_status", data: { job_id: "job-1", status: "running", progress: 40 },
  }));
  await expect(job).toContainText("running · 40%");
  await job.getByRole("button").click();
  await expect(job).toContainText("cancelled");
  await expect(job.getByRole("button")).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#install-config").click();
  const language = await page.evaluate(() => document.documentElement.lang);
  await expect(page.locator("#toast")).toContainText(
    STRINGS[language]["toast.builder.otaStarted"].replace("{id}", "job-2"));
  expect(config.writes.at(-1)).toMatchObject({
    path: "configurations/display.yaml/install", body: { port: "OTA", confirmed: true },
  });
  await expect(page.locator("#builder-job-list .builder-job")).toHaveCount(2);
});
