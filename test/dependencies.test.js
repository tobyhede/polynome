import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const manifest = fileURLToPath(new URL("../package.json", import.meta.url));

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A runtime dependency's code is copied into both distributions, so its version
 * is part of what ships and a range means two builds of the same commit can
 * disagree. esbuild is pinned for the same reason from the other side — it
 * decides the bytes rather than supplies them — and Playwright is left to float
 * because nothing it does reaches a user.
 *
 * The lockfile already makes an install reproducible; this is about the version
 * the manifest itself asks for, which is what a fresh `npm install`, a bot
 * bumping a range, or a reader deciding what is deployed all go by.
 */
test("every runtime dependency is pinned to an exact version", async () => {
  const { dependencies = {} } = JSON.parse(await readFile(manifest, "utf8"));

  assert.ok(
    Object.keys(dependencies).length,
    "Expected the manifest to declare the runtime dependencies this asserts on",
  );
  assert.deepEqual(
    Object.entries(dependencies).filter(([, range]) => !EXACT.test(range)),
    [],
  );
});
