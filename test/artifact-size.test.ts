import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { buildDistribution } from "../scripts/build.ts";

const projectRoot = new URL("..", import.meta.url);

/**
 * A ratchet on what a browser downloads, in the spirit of the coverage and
 * TypeScript ratchets: set where the artifact stands today, raised deliberately
 * when the real figure rises, never lowered to make a change fit.
 *
 * It exists because nothing else records the number.
 * [ADR-0009](../docs/adr/0009-adopt-preact-as-the-renderer.md) measured the
 * single-file distribution growing from 194,762 to 211,773 bytes when Preact
 * was adopted, and named the 8.7% as a cost worth weighing. It has grown a
 * further 27% since, in changes that each looked free. A budget is the only
 * thing that turns that into a decision somebody makes rather than a number
 * nobody watches.
 *
 * The build is byte-deterministic — repeated runs produce identical digests —
 * so these are equalities in everything but name, and the headroom is there to
 * absorb an ordinary change rather than to hide a trend.
 *
 * Every figure is taken against `main`, which is the only tree a budget can
 * honestly describe: measured on a feature branch instead, these came out 4 KB
 * lower on the script and 3 KB higher on the stylesheet, and a budget carrying
 * one branch's shape would read as a regression the moment another merged.
 * Re-take them here, on `main`, whenever one is raised.
 */
type Budget = { raw: number; gzip?: number };
type ArtifactSize = { raw: number; gzip: number };

const BUDGETS: Readonly<Record<string, Budget>> = Object.freeze({
  /**
   * The whole application as one file: markup, styles, script, and base64 woff2.
   *
   * The last raise carried that refusal past the unchanged-edit short circuit,
   * so a denominator a ratio layer already stores is refused by name rather
   * than reported as an ordinary no-op, measuring 294,471 bytes after rebase.
   * The raise
   * before it refused a denominator edit against a layer whose notation
   * carries no denominator, measuring 293,965 bytes after rebase. The one
   * before that added the matched Polymeter and Polyrhythm Presets,
   * measuring 293,415 bytes after rebase. The preceding raise added per-Cycle
   * Polyrhythm timing and its truthful visible and accessible descriptions,
   * measuring 292,707 bytes after rebase. Before that, focus restoration after
   * an asynchronous Share load combined with the editing-state playback changes
   * already on main measured 288,495 bytes after rebase. The preceding
   * Content-Security-Policy meta element was 317 bytes of
   * the 285,156 measured there — three SHA-256 digests and their
   * directives, since this artifact admits its inline elements by hash and has
   * no origin to name. It is the one growth in this file that does not scale
   * with the source: a fourth inline element would add a digest, and nothing
   * else will move it. See
   * [ADR-0022](../docs/adr/0022-compute-the-content-security-policy-at-build-time.md).
   */
  "dist/polynome.html": { raw: 294_500 },
  /** The bundled script alone, which is the half that grows from source. */
  "site/app-local.js": { raw: 174_250, gzip: 42_400 },
  "site/styles-local.css": { raw: 30_900 },
});

/**
 * Node's zlib and the system `gzip` disagree by tens of bytes on identical
 * input at the same nominal level — 37,035 against 36,936 on one measurement of
 * `app-local.js` — so a compressed budget is only meaningful with its
 * compressor named. This one is Node's, at level 9, and nothing should compare
 * a figure from here against one from a shell.
 *
 * Raw bytes carry the budget wherever only one is stated. They are the portable
 * number, and for the single-file distribution they are also the honest one:
 * roughly 65 KB of it is base64-encoded woff2, which compresses to nothing and
 * would mask real script growth behind a flattering total.
 */
const GZIP_LEVEL = 9;

const artifactContents = (relativePath: string, root: URL | string = projectRoot) =>
  readFile(root instanceof URL ? new URL(relativePath, root) : join(root, relativePath));

const bytesOf = async (
  relativePath: string,
  root: URL | string = projectRoot,
): Promise<ArtifactSize> => {
  const contents = await artifactContents(relativePath, root);
  return { raw: contents.byteLength, gzip: gzipSync(contents, { level: GZIP_LEVEL }).byteLength };
};

test("both distributions stay inside their byte budgets", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "polynome-artifact-budget-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  // Both targets, because the site build emits the script and stylesheet
  // separately and the single-file build inlines them: neither total contains
  // the other, and a change can move one without moving the other.
  await buildDistribution({ target: "single-file", projectRoot, outputRoot });
  await buildDistribution({ target: "site", version: "local", projectRoot, outputRoot });

  const measured: Record<string, ArtifactSize> = {};
  for (const [path, budget] of Object.entries(BUDGETS)) {
    const size = await bytesOf(path, outputRoot);
    measured[path] = size;
    assert.ok(
      size.raw <= budget.raw,
      `${path} is ${size.raw} raw bytes, over its ${budget.raw} budget. Raise the budget deliberately, or find the growth.`,
    );
    if (budget.gzip === undefined) continue;
    assert.ok(
      size.gzip <= budget.gzip,
      `${path} is ${size.gzip} bytes gzipped at level ${GZIP_LEVEL}, over its ${budget.gzip} budget.`,
    );
  }

  // A budget nobody can see the slack in is a budget that gets raised without
  // anyone noticing how close it already was.
  for (const [path, size] of Object.entries(measured)) {
    const budget = BUDGETS[path];
    const headroom = (((budget.raw - size.raw) / budget.raw) * 100).toFixed(1);
    console.log(
      `${path}: ${size.raw} raw (${headroom}% headroom), ${size.gzip} gzip-${GZIP_LEVEL}`,
    );
  }
});

/**
 * The budgets above are only assertions if the build is reproducible. It is,
 * and this is what says so: two runs of the same target from the same source
 * must produce the same bytes. A build that varied run to run would make every
 * figure in this file a sample rather than a measurement.
 */
test("the build is byte-reproducible, which is what makes a budget an assertion", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "polynome-artifact-reproducibility-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await buildDistribution({ target: "single-file", projectRoot, outputRoot });
  const first = await artifactContents("dist/polynome.html", outputRoot);
  await buildDistribution({ target: "single-file", projectRoot, outputRoot });
  const second = await artifactContents("dist/polynome.html", outputRoot);

  assert.deepEqual(first, second);
});
