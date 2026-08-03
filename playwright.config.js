import { defineConfig, devices } from "@playwright/test";

const port = 4174;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // A `test.only` left in a spec narrows the run to that one test and still
  // exits zero, so it reads as a green suite while asserting almost nothing.
  // Local runs keep it, because focusing a test is how it gets debugged.
  forbidOnly: !!process.env.CI,
  timeout: 15_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm start",
    env: { PORT: String(port) },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 500 },
    stdout: "pipe",
    stderr: "pipe",
  },
});
