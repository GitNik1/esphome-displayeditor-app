import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  // The single static test server stalls when a machine with many cores
  // lets Playwright open ~10 pages at once, each pulling ~40 ES modules;
  // boots then time out at random. Four is stable and still fast.
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "python -m http.server 4173 --directory frontend",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
