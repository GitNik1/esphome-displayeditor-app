import { expect, test } from "@playwright/test";

test("LVGL 9 WASM artifact initializes, renders and reports metrics", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/viewer-wasm/harness.html");
  await page.waitForFunction(() => window.__lvglWasmAcceptance !== undefined);
  const acceptance = await page.evaluate(() => window.__lvglWasmAcceptance);
  expect(acceptance, acceptance.error).toMatchObject({ ready: true });
  const result = await page.evaluate(() => {
    const canvas = document.querySelector("#display");
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] || pixels[index + 1] || pixels[index + 2]) colored += 1;
    }
    return { metrics: window.__lvglWasmAcceptance.metrics, colored };
  });
  expect(result.metrics.manifest.lvgl_version).toBe("v9.2.2");
  expect(result.metrics.wasmBytes).toBeGreaterThan(100_000);
  expect(result.metrics.wasmBytes).toBeLessThan(1_000_000);
  expect(result.metrics.startupMs).toBeLessThan(2_000);
  expect(result.metrics.memoryBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(result.metrics.supportedObjects).toBe(23);
  expect(result.metrics.unsupported).toEqual([]);
  expect(result.colored).toBeGreaterThan(10_000);
  expect(errors).toEqual([]);
  const canvas = page.locator("#display");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 187 / 800, box.y + box.height * 79 / 600);
  await expect.poll(() => page.evaluate(() => window.__lvglWasmAcceptance.events.some((event) => event.id === "enabled"))).toBe(true);
});
