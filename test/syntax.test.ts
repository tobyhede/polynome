import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { formatMessages, transform } from "esbuild";

const run = promisify(execFile);

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * This check replaces a hand-written list of `node --check` calls in the
 * `check` script, which named seven files and silently ignored the rest:
 * `server.ts`, `playwright.config.ts`, and three of the five build scripts
 * were never checked at all, and a new source file joined them by default. A
 * list that must be remembered is a list that goes stale, so derive it.
 *
 * The repository is enumerated through git rather than walked, because a walk
 * needs its own list — of directories to skip — and that list goes stale the
 * same way. `node_modules`, `dist`, `site`, and any worktree under `.claude`
 * all hold source this project did not write. Tracked files are exactly the
 * files the repository ships, and a new one joins the set by being committed
 * rather than by being named here.
 *
 * Declaration files are enumerated with the rest. Esbuild parses one as it
 * parses any other, and `types/globals.d.ts` is source this repository wrote,
 * so leaving it out would be leaving a file nothing checks.
 */
async function trackedScripts() {
  const { stdout } = await run("git", ["ls-files", "-z", "*.ts"], { cwd: root });
  return stdout.split("\0").filter((name) => name !== "");
}

/**
 * Esbuild parses these rather than `node --check`, which no longer says
 * anything about them: it accepts a `.ts` file whatever is inside it, because
 * Node strips types without parsing what it strips. `node --check` on a file
 * whose annotations are malformed exits zero, so keeping it would have left a
 * test that cannot fail — worse than no test, because the suite still reports
 * a check that happened.
 *
 * Esbuild is the parser the browser distributions and the development server
 * both already go through, so a file that fails here is a file `npm run
 * bundle` would have refused anyway, only reported now instead of at deploy
 * time. This is a syntax check and nothing more; `npm run types` is what
 * checks the types, and it covers the source tree rather than this wider set.
 */
async function parseFailure(name) {
  const source = await readFile(join(root, name), "utf8");
  try {
    await transform(source, { loader: "ts", sourcefile: name });
    return null;
  } catch (error) {
    const reported = await formatMessages(error.errors ?? [], { kind: "error", color: false });
    return `${name}\n${(reported.join("") || String(error)).trim()}`;
  }
}

/**
 * Most of these files are imported by some other test, and importing a file
 * proves it parses. The ones that are not — `app.ts` runs only in a browser,
 * and the build scripts only under `npm run site` and `npm run bundle` — are
 * exactly the ones worth checking here, because a syntax error in them
 * surfaces at deploy time rather than at test time.
 */
test("every tracked script parses", async () => {
  const scripts = await trackedScripts();
  assert.ok(scripts.length > 0, "no tracked scripts found, so nothing was actually checked");
  assert.ok(
    scripts.includes("app.ts"),
    `app.ts is tracked but was not enumerated, so the file list is wrong: ${scripts.join(", ")}`,
  );

  const failures = (await Promise.all(scripts.map(parseFailure))).filter((failure) => failure);

  assert.ok(
    failures.length === 0,
    `${failures.length} tracked ${
      failures.length === 1 ? "script does" : "scripts do"
    } not parse:\n\n${failures.join("\n\n")}`,
  );
});
