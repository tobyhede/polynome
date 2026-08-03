import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const builder = fileURLToPath(new URL("../scripts/site.mjs", import.meta.url));
const output = fileURLToPath(new URL("../site", import.meta.url));

/**
 * The site build renames every module to a cache-safe versioned filename and
 * rewrites import specifiers to match by hand. A module that gains an import
 * without a matching rewrite still bundles and still passes `node --test`, and
 * only fails once a browser requests the unversioned name from the deployed
 * site. Resolve every emitted specifier against the emitted files instead.
 *
 * Running the real build writes real output into the gitignored `site/`, which
 * is deliberate: only the deployed filenames can show what a browser requests.
 */
test("every site import specifier resolves to an emitted file", async () => {
  await execFileAsync(process.execPath, [builder]);
  const emitted = await readdir(output);
  const scripts = emitted.filter((name) => name.endsWith(".js"));

  assert.ok(scripts.length, "Expected the site build to emit modules");

  for (const name of scripts) {
    const source = await readFile(join(output, name), "utf8");
    const specifiers = Array.from(
      source.matchAll(/from\s+["'](\.\/.+?)["']/g),
      (match) => match[1].slice(2),
    );
    for (const specifier of specifiers) {
      assert.ok(
        emitted.includes(specifier),
        `${name} imports "./${specifier}", which the site build does not emit`,
      );
    }
  }
});
