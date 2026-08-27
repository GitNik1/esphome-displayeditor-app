import { expect, test } from "@playwright/test";

import { mockApi, openStoredProject } from "./mock-api.mjs";

// Geometry, not behaviour. Every case here encodes a layout bug that shipped
// past the behavioural suite because nothing asserted where things sit:
// a bar that took the stage's grid row, action buttons pushed below the fold
// on a short window, a closed <dialog> forced back into the layout by a bare
// display rule, and a segmented control whose label wrapped.

/** @param {import("@playwright/test").Page} page @param {string} selector */
function boxOf(page, selector) {
  return page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      viewport: window.innerHeight,
      scrolls: node.scrollHeight > node.clientHeight + 1,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

// 620 is below any real laptop; if the layout holds there it holds anywhere.
for (const height of [620, 768, 900]) {
  test(`the version dialog keeps its actions reachable at ${height}px`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height });
    await page.goto("/");
    await expect(page.locator("#health")).toHaveClass(/ok/);
    await openStoredProject(page);
    await page.locator("#open-revisions").click();
    await page.locator("#revisions-list .revision-row").nth(1).click();
    await expect(page.locator("#revisions-diff .diff-line")).not.toHaveCount(0);

    const actions = await boxOf(page, "#revisions-dialog .dialog-actions");
    const dialog = await boxOf(page, "#revisions-dialog");
    const diff = await boxOf(page, "#revisions-diff");

    // The whole point: the primary actions must be on screen without scrolling.
    expect(actions.top).toBeGreaterThanOrEqual(0);
    expect(actions.bottom).toBeLessThanOrEqual(actions.viewport);
    // The dialog constrains itself instead of growing past the window...
    expect(dialog.scrolls).toBe(false);
    expect(dialog.height).toBeLessThanOrEqual(height);
    // ...which only works because the diff pane takes the squeeze.
    expect(diff.scrolls).toBe(true);
  });
}

test("the viewer stacks toolbar, history bar and stage without gaps", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();
  await page.locator("#preview-revision").click();
  await expect(page.locator("#viewer-history-bar")).toBeVisible();

  const toolbar = await boxOf(page, ".viewer-toolbar");
  const bar = await boxOf(page, "#viewer-history-bar");
  const stage = await boxOf(page, "#viewer-stage");
  const statusline = await boxOf(page, ".viewer-statusline");

  // Contiguous rows, in this order, with no gap for the bar to float in.
  expect(bar.top).toBe(toolbar.bottom);
  expect(stage.top).toBe(bar.bottom);
  expect(statusline.top).toBe(stage.bottom);
  // The stage keeps the flexible row: it must dominate, not be squeezed to
  // whatever is left after an oversized bar.
  expect(stage.height).toBeGreaterThan(bar.height + toolbar.height + statusline.height);
});

test("closed dialogs stay out of the layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);

  // A bare `display` rule on a dialog overrides the UA's display:none and
  // leaves it permanently on screen, which is easy to do and easy to miss.
  const visible = await page.evaluate(() => [...document.querySelectorAll("dialog")]
    .filter((node) => !node.open && node.getBoundingClientRect().height > 0)
    .map((node) => node.id));
  expect(visible).toEqual([]);
});

test("the comparison switch stays on one line", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator("#health")).toHaveClass(/ok/);
  await openStoredProject(page);
  await page.locator("#open-revisions").click();
  await page.locator("#revisions-list .revision-row").nth(1).click();
  await page.locator("#preview-revision").click();
  await expect(page.locator("#viewer-history-bar")).toBeVisible();

  const segments = await page.evaluate(() => {
    const read = (selector) => {
      const node = document.querySelector(selector);
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        wrap: getComputedStyle(node).whiteSpace,
      };
    };
    return { button: read("#viewer-history-version"), select: read("#viewer-history-compare") };
  });

  // Side by side, not stacked, and neither label may break across lines.
  expect(segments.button.top).toBe(segments.select.top);
  expect(segments.button.height).toBe(segments.select.height);
  expect(segments.button.wrap).toBe("nowrap");
  expect(segments.select.wrap).toBe("nowrap");
});
