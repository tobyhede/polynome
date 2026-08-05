import { defineConfig, devices } from "@playwright/test";

// Deliberately not the 4173 `npm start` uses or the 4175 `npm run shots` takes,
// so a run collides with neither. The override is for the case those three
// numbers cannot help with: a second checkout of this repo running its own
// browser suite at the same time, which wants the same 4174 and, because reuse
// is disabled below, fails outright rather than attaching to the first one's
// server. `POLYNOME_TEST_PORT` rather than `PORT` because `PORT` is what gets
// handed to the server process, and a value already exported for some other
// reason would move this suite without anyone asking it to.
const port = Number(process.env.POLYNOME_TEST_PORT || 4174);

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
