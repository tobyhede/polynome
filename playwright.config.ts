import { randomInt } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// Each run chooses its own port so concurrent checkouts neither collide nor
// need a distinct shell command (and therefore a distinct agent permission).
// The explicit override remains for reproducing a run on a known port.
// `POLYNOME_TEST_PORT` rather than `PORT` because `PORT` is handed to the server
// process, and a value exported for some other reason must not move this suite.
const requestedPort = process.env.POLYNOME_TEST_PORT;
const port = requestedPort === undefined ? randomInt(49_152, 65_536) : Number(requestedPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError(
    `POLYNOME_TEST_PORT must be an integer from 1 to 65535; got ${requestedPort}`,
  );
}
// Playwright loads this config again in worker processes. Preserve the first
// choice so every process in one run addresses the server the runner started.
process.env.POLYNOME_TEST_PORT = String(port);
console.log(`POLYNOME_TEST_PORT=${port}`);

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
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
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
