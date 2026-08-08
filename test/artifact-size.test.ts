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
   * This is the first figure here that has ever fallen, and it fell 27,348
   * bytes, from 295,311 to 267,963. Both embedded faces were re-cut from
   * upstream at the glyph set the interface draws — 48,944 bytes of woff2 became
   * 28,436 — and this artifact carries them base64-encoded, so removing 20,508
   * bytes of font took 27,348 bytes off the file. Nothing about the script or
   * the markup moved.
   *
   * The two site figures below did not move at all, which is worth stating
   * because the reasoning that produced this change expected all three to. The
   * site build emits the faces as their own files rather than inlining them, so
   * neither the script nor the stylesheet has ever contained a font byte: what
   * a first visit saves is two smaller requests, and no budget here counts
   * those. See
   * [ADR-0024](../docs/adr/0024-set-a-redline-the-artifact-ratchet-cannot-raise.md),
   * which names this subset as the reserve its redline is drawn against.
   *
   * The last raise before this fall drew the tempo band as one element per
   * stretch travelled rather than as a single pseudo-element across all of
   * them, which is what a Flat between two ramps needs to be stated at all,
   * measuring 295,311 bytes after rebase. Almost all of it is prose: the
   * derivation explaining why touching stretches merge, and the drawing
   * explaining why the bands are elements. The raise before it added the Help
   * entry explaining what Polymeter and Polyrhythm count, measuring 294,757
   * bytes. The one before that carried that refusal past the unchanged-edit
   * short circuit, so a denominator a ratio layer already stores is refused by
   * name rather than reported as an ordinary no-op, measuring 294,471 bytes
   * after rebase. The raise
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
  "dist/polynome.html": { raw: 268_000 },
  /**
   * The bundled script alone, which is the half that grows from source, and the
   * one figure the redline in ADR-0024 is about. Measured 174,711 raw and 42,537
   * gzipped after rebase — the same figures the tempo band raise took, because
   * the site build emits the faces as files and the font cut never touched this.
   */
  "site/app-local.js": { raw: 174_750, gzip: 42_600 },
  /**
   * The stylesheet, which the tempo band change left 23 bytes smaller than it
   * found it — one rule for the band elements says what a pseudo-element and
   * its `content` did — and which the font cut left alone at 30,867. Not
   * re-taken on a fall: this is a ceiling, and lowering one is a decision of its
   * own rather than the tail of somebody else's.
   */
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
 * roughly 38 KB of it is base64-encoded woff2 — 65 KB before the faces were
 * re-cut from upstream — and woff2 is already Brotli-compressed, so gzip takes
 * back base64's expansion and nothing beyond it. Those 37,916 characters cost
 * 29,514 bytes of the 83,675-byte gzipped artifact, against the 28,436 the two
 * faces weigh on disk. A gzip budget would therefore carry 35% of itself as a
 * floor no source change can move, and script growth measured against so
 * diluted a total reads smaller than it is. The last test below holds that.
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

/**
 * The base64 body of a woff2 data URL, matched without its `data:` prefix so
 * that excising it leaves the rest of the declaration standing and the
 * difference measures the payload and nothing around it. The class is base64's
 * own alphabet, which is what stops the match at the `)` closing the `url()`.
 */
const FONT_PAYLOAD = /(?<=data:font\/woff2;base64,)[A-Za-z0-9+/=]+/g;

/**
 * What the difference is allowed to run over the woff2 bytes themselves. It
 * measures 1,084: 120 of that is deflate's own overhead on input it cannot
 * improve, and the remaining 964 is the other 229,207 bytes coding better once
 * 37,916 characters of high-entropy base64 leave the window. The larger term is
 * a property of the document around the faces rather than of the faces, so this
 * is stated in bytes rather than as a ratio of them.
 */
const INCOMPRESSIBLE_SLACK = 1_500;

/** Below this share of the gzipped total, the dilution argument stops holding. */
const FLOOR_SHARE = 0.3;

/**
 * The figures the comment on `GZIP_LEVEL` rests on, taken from the artifact
 * rather than asserted about it, because that comment once said the opposite of
 * what the build does and nothing here caught it.
 *
 * The contribution is measured as a difference — gzip the artifact, gzip it
 * again with the two payloads excised, subtract — because that is the number a
 * gzip budget would carry. Compressing the payloads on their own answers a
 * narrower question and gives 28,556; gzip's window spans the whole file, so
 * what the faces cost in place is not what they cost alone.
 */
test("the embedded faces are a floor under the gzipped artifact that gzip cannot lift", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "polynome-font-payload-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await buildDistribution({ target: "single-file", projectRoot, outputRoot });

  const artifact = await artifactContents("dist/polynome.html", outputRoot);
  const html = artifact.toString("utf8");
  const payloads = html.match(FONT_PAYLOAD) ?? [];
  // A pattern that matched nothing would report a contribution of zero, which
  // satisfies both bounds on it and leaves only the share to fail, reported as
  // growth in the script rather than as the broken pattern it is.
  assert.equal(
    payloads.length,
    2,
    `dist/polynome.html carries ${payloads.length} base64 woff2 payloads, not the two @font-face rules styles.css declares. If the faces stopped being inlined, the raw-only budget on this artifact is no longer justified by anything here.`,
  );

  const decoded = payloads.reduce((total, p) => total + Buffer.from(p, "base64").byteLength, 0);
  const gzipped = gzipSync(artifact, { level: GZIP_LEVEL }).byteLength;
  const withoutPayloads = gzipSync(Buffer.from(html.replace(FONT_PAYLOAD, ""), "utf8"), {
    level: GZIP_LEVEL,
  }).byteLength;
  const contribution = gzipped - withoutPayloads;
  const share = contribution / gzipped;

  // woff2 is Brotli-compressed and base64 is a 4:3 expansion of it, so gzip
  // takes the expansion back and stops there, landing within slack of what the
  // faces weigh on disk. Both edges are held: the lower one is the claim, and
  // the upper one is what keeps the claim from being satisfied by an accident
  // that inflated the difference.
  assert.ok(
    contribution >= decoded,
    `The ${decoded} bytes of woff2 in dist/polynome.html cost only ${contribution} bytes of the ${gzipped}-byte gzipped artifact, so gzip found compression in a Brotli-compressed payload. Something upstream is no longer emitting woff2. Re-take the figures on GZIP_LEVEL before that comment is trusted again.`,
  );
  assert.ok(
    contribution <= decoded + INCOMPRESSIBLE_SLACK,
    `The base64 faces cost ${contribution - decoded} bytes more gzipped than the ${decoded} they weigh on disk, over the ${INCOMPRESSIBLE_SLACK} this allows. The difference is measured by excising the payloads, so anything else that moved with them is being counted as font. Check FONT_PAYLOAD still matches only the two data URLs.`,
  );
  assert.ok(
    share >= FLOOR_SHARE,
    `The faces are ${(share * 100).toFixed(1)}% of the ${gzipped}-byte gzipped artifact, under the ${FLOOR_SHARE * 100}% that makes them a floor worth budgeting around. Measured 35.4%. Everything but the faces has to grow for this to fall, so read dist/polynome.html against its raw budget before relaxing this.`,
  );

  console.log(
    `dist/polynome.html: ${contribution} of ${gzipped} gzip-${GZIP_LEVEL} bytes are ${decoded} bytes of woff2 (${(share * 100).toFixed(1)}%)`,
  );
});
