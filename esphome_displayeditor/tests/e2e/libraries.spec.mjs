import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.mjs";

// The project libraries in the designer's side panel. Widget references are
// set and read through window.__appState, the read-only debug handle app.js
// keeps for automated checks: the point here is what the library does to
// them, not how a property field writes them.

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);
});

/** @param {import("@playwright/test").Page} page */
const textColor = (page) => page.evaluate(
  () => window.__appState.project.widgets[0].style_tree.text_color,
);

test("the colour library adds, renames and deletes colours and keeps their references", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator(".color-library-details summary").click();
  const entries = page.locator("#color-library-list .color-library-item");
  const error = page.locator("#color-library-error");
  await expect(page.locator("#color-library-list .color-library-empty")).toBeVisible();

  await page.locator("#color-library-id").fill("status_ok");
  await page.locator("#color-library-hex").fill("zz");
  await page.locator("#save-color-library-entry").click();
  await expect(error).toBeVisible();
  await page.locator("#color-library-hex").fill("0a0");
  await expect(page.locator("#color-library-picker")).toHaveValue("#00aa00");
  await page.locator("#save-color-library-entry").click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText("status_ok");
  await expect(entries.first()).toContainText("#00AA00");
  await expect(error).toBeHidden();
  await expect(page.locator("#project-color-options option")).toHaveCount(1);
  await expect(page.locator("#color-library-id")).toHaveValue("");

  // A widget refers to the colour by its id; renaming the colour follows it.
  await page.getByRole("button", { name: /Label/ }).click();
  await page.evaluate(() => {
    window.__appState.project.widgets[0].style_tree = { text_color: "status_ok" };
  });
  await entries.first().getByRole("button").first().click();
  await expect(page.locator("#color-library-id")).toHaveValue("status_ok");
  await expect(page.locator("#cancel-color-library-edit")).toBeVisible();
  await page.locator("#color-library-id").fill("state_good");
  await page.locator("#save-color-library-entry").click();
  await expect(entries.first()).toContainText("state_good");
  await expect(page.locator("#cancel-color-library-edit")).toBeHidden();
  expect(await textColor(page)).toBe("state_good");

  // Ids share one namespace with widgets and the other libraries.
  const widgetId = await page.evaluate(() => window.__appState.project.widgets[0].id);
  await page.locator("#color-library-id").fill(widgetId);
  await page.locator("#color-library-hex").fill("FF0000");
  await page.locator("#save-color-library-entry").click();
  await expect(error).toContainText(widgetId);
  await expect(entries).toHaveCount(1);

  // Deleting a colour in use writes its value where it was used; undo
  // brings both back.
  await entries.first().getByRole("button").nth(1).click();
  await expect(page.locator("#color-library-list .color-library-empty")).toBeVisible();
  expect(await textColor(page)).toBe("00AA00");
  await page.locator("#undo").click();
  await expect(entries).toHaveCount(1);
  expect(await textColor(page)).toBe("state_good");
});
