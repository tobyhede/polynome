import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * This check replaces a hand-written list of `node --check` calls in the
 * `check` script, which named seven files and silently ignored the rest:
 * `server.mjs`, `playwright.config.js`, and three of the five build scripts
 * were never checked at all, and a new source file joined them by default. A
 * list that must be remembered is a list that goes stale, so derive it.
 *
 * The repository is enumerated through git rather than walked, because a walk
 * needs its own list — of directories to skip — and that list goes stale the
 * same way. `node_modules`, `dist`, `site`, and any worktree under `.claude`
 * all hold JavaScript this project did not write. Tracked files are exactly
 * the files the repository ships, and a new one joins the set by being
 * committed rather than by being named here.
 */
async function trackedScripts() {
  const { stdout } = await run("git", ["ls-files", "-z", "*.js", "*.mjs"], { cwd: root });
  return stdout.split("\0").filter((name) => name !== "");
}

/**
 * Most of these files are imported by some other test, and importing a file
 * proves it parses. The ones that are not — `app.js` runs only in a browser,
 * and the build scripts only under `npm run site` and `npm run bundle` — are
 * exactly the ones worth checking here, because a syntax error in them
 * surfaces at deploy time rather than at test time.
 */
test("every tracked script parses", async () => {
  const scripts = await trackedScripts();
  assert.ok(scripts.length > 0, "no tracked scripts found, so nothing was actually checked");
  assert.ok(
    scripts.includes("app.js"),
    `app.js is tracked but was not enumerated, so the file list is wrong: ${scripts.join(", ")}`,
  );

  const failures = [];
  await Promise.all(
    scripts.map(async (name) => {
      try {
        await run(process.execPath, ["--check", name], { cwd: root });
      } catch (error) {
        failures.push(`${name}\n${error.stderr.trim()}`);
      }
    }),
  );

  assert.ok(
    failures.length === 0,
    `${failures.length} tracked ${
      failures.length === 1 ? "script does" : "scripts do"
    } not parse:\n\n${failures.join("\n\n")}`,
  );
});
