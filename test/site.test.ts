import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDistribution, distributionVersion } from "../scripts/build.ts";

const projectRoot = new URL("..", import.meta.url);
const output = new URL("../site/", import.meta.url);

test("site distribution versions every emitted asset and its references", async () => {
  await buildDistribution({ target: "site", version: "deadbeefcafebab", projectRoot });
  const emitted = await readdir(output);
  const html = await readFile(new URL("index.html", output), "utf8");
  const cssName = "styles-deadbeefcafe.css";
  const appName = "app-deadbeefcafe.js";
  const css = await readFile(new URL(cssName, output), "utf8");

  assert.ok(emitted.includes(appName));
  assert.ok(emitted.includes(cssName));
  assert.ok(emitted.includes("jetbrains-mono-latin-deadbeefcafe.woff2"));
  assert.ok(emitted.includes("major-mono-display-latin-deadbeefcafe.woff2"));
  assert.match(html, new RegExp(`href="\\./${cssName}"`));
  assert.match(html, new RegExp(`src="\\./${appName}"`));
  assert.match(css, /url\(["']?\.\/jetbrains-mono-latin-deadbeefcafe\.woff2["']?\)/);
  assert.match(css, /url\(["']?\.\/major-mono-display-latin-deadbeefcafe\.woff2["']?\)/);
  assert.ok(emitted.includes(".nojekyll"));
});

/**
 * Esbuild resolves the specifiers inside JavaScript and CSS, but `index.html`
 * is rewritten here by hand, and a reference the rewrite misses is one no
 * build step can notice: the artifact is complete, every assertion above still
 * holds, and the request 404s only against the deployed site. Resolve every
 * relative reference the real document, modules, and stylesheet emit against
 * the files the real build actually wrote.
 */
test("every reference the real site emits resolves to an emitted file", async () => {
  await buildDistribution({ target: "site", projectRoot });
  const emitted = await readdir(output);
  const documents = emitted.filter((name) => /\.(?:css|html|js)$/.test(name));

  assert.ok(
    documents.length >= 3,
    "Expected the site build to emit a document, a module, and a stylesheet",
  );

  for (const name of documents) {
    const source = await readFile(new URL(name, output), "utf8");
    for (const [, reference] of source.matchAll(/["'(]\.\/([^"')]+)["')]/g)) {
      assert.ok(
        emitted.includes(reference),
        `${name} references "./${reference}", which the site build does not emit`,
      );
    }
  }
});

test("site distribution versions transitive chunks without manual rewrites", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), 'globalThis.loadFeature = () => import("./feature.js");'),
    writeFile(join(fixture, "feature.js"), 'export const feature = "discovered";'),
  ]);

  await buildDistribution({ target: "site", version: "fixture1234567", projectRoot: fixture });
  const directory = join(fixture, "site");
  const emitted = await readdir(directory);
  const appName = "app-fixture12345.js";
  const app = await readFile(join(directory, appName), "utf8");
  const imported = app.match(/import\(["']\.\/(.+?)["']\)/)?.[1];

  assert.ok(imported, "Expected a transitive chunk import");
  assert.match(imported, /^feature-fixture12345-[^.]+\.js$/);
  assert.ok(emitted.includes(imported));
});

test("site distribution can write outside the source tree", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-output-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const sourceRoot = join(fixture, "source");
  const outputRoot = join(fixture, "output");
  await mkdir(join(sourceRoot, "site"), { recursive: true });
  await Promise.all([
    writeFile(
      join(sourceRoot, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(sourceRoot, "styles.css"), "body {}"),
    writeFile(join(sourceRoot, "app.ts"), "globalThis.fixture = 1;"),
    writeFile(join(sourceRoot, "site", "sentinel"), "source output stays untouched"),
  ]);

  const result = await buildDistribution({
    target: "site",
    version: "isolated",
    projectRoot: sourceRoot,
    outputRoot,
  });

  assert.equal(result.output, join(outputRoot, "site"));
  assert.ok((await readdir(result.output)).includes("app-isolated.js"));
  assert.equal(
    await readFile(join(sourceRoot, "site", "sentinel"), "utf8"),
    "source output stays untouched",
  );
});

/**
 * A revision that is present but empty is the case worth pinning: it reads as
 * a supplied value, so a nullish fallback keeps it and every asset ships as
 * `app-.js`. Naming the fallback separately also keeps the builds below from
 * having to mutate the environment to reach each branch.
 */
test("the distribution version falls back through request, environment, and local", () => {
  const cases = [
    { requested: "abc123", sha: "0123456789abcdef", want: "abc123" },
    { requested: undefined, sha: "0123456789abcdef", want: "0123456789ab" },
    { requested: undefined, sha: undefined, want: "local" },
    { requested: undefined, sha: "", want: "local" },
    { requested: "", sha: "0123456789abcdef", want: "0123456789ab" },
    { requested: "", sha: "", want: "local" },
    { requested: "0123456789abcdef", sha: undefined, want: "0123456789ab" },
  ];

  for (const { requested, sha, want } of cases) {
    assert.equal(
      distributionVersion(requested, sha),
      want,
      `requested ${JSON.stringify(requested)} with GITHUB_SHA ${JSON.stringify(sha)}`,
    );
  }
});

/**
 * The version reaches both an output path and an HTML attribute, so a
 * separator writes outside `site/` and a quote ends the attribute early. Only
 * the truncated value is ever used, so a version that is safe once shortened
 * stays acceptable however it started.
 */
test("the distribution version refuses characters a filename or attribute cannot hold", () => {
  for (const unsafe of ['a"b', "a'b", "a/b", "a\\b", "a<b", "a b"]) {
    assert.throws(
      () => distributionVersion(unsafe, undefined),
      /Distribution version is not filename-safe/,
      `expected ${JSON.stringify(unsafe)} to be refused`,
    );
  }

  assert.equal(distributionVersion(`0123456789ab"><script>`, undefined), "0123456789ab");
});

/**
 * The fallback itself is pinned above, so what is left to prove is the wiring:
 * the build reads the revision from the environment rather than from anywhere
 * else. This is the only test that needs the environment, and it restores what
 * it found so whatever runs next sees the same process it would have.
 */
test("site distribution reads its version from the GitHub revision", async (t) => {
  const previousSha = process.env.GITHUB_SHA;
  t.after(() => {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
  });
  process.env.GITHUB_SHA = "0123456789abcdef";

  const result = await buildDistribution({ target: "site", projectRoot });
  const emitted = await readdir(output);

  assert.equal(result.version, "0123456789ab");
  assert.ok(emitted.includes("app-0123456789ab.js"));
  assert.ok(emitted.includes("styles-0123456789ab.css"));
});

/**
 * A document may name the same asset more than once — a preload hint beside
 * the tag that uses it. Rewriting only the first leaves the rest pointing at
 * names the build never emits, and nothing here can see that: the artifact is
 * written, the tests pass, and the 404 appears only once a browser loads the
 * deployed site.
 */
test("site distribution versions every reference in the document", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-reference-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      [
        '<link rel="modulepreload" href="./app.ts" />',
        '<link rel="preload" href="./styles.css" as="style" />',
        '<link rel="stylesheet" href="./styles.css" />',
        '<script type="module" src="./app.ts"></script>',
      ].join(""),
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await buildDistribution({ target: "site", version: "everyref", projectRoot: fixture });
  const html = await readFile(join(fixture, "site", "index.html"), "utf8");

  assert.doesNotMatch(html, /["']\.\/app\.ts["']/);
  assert.doesNotMatch(html, /["']\.\/styles\.css["']/);
  assert.equal(html.match(/\.\/app-everyref\.js/g)?.length, 2);
  assert.equal(html.match(/\.\/styles-everyref\.css/g)?.length, 2);
});

test("site distribution refuses a document it cannot rewrite", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-document-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" />'),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await assert.rejects(
    buildDistribution({ target: "site", version: "nodoc", projectRoot: fixture }),
    /index\.html has no \.\/app\.ts reference/,
  );
});

test("site distribution refuses JavaScript esbuild warns about", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-warning-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = { rate: 1, rate: 2 };"),
  ]);

  await assert.rejects(
    buildDistribution({ target: "site", version: "warned", projectRoot: fixture }),
    /Duplicate key "rate" in object literal/,
  );
});

/**
 * The two overloads name the two targets, so a third cannot be written through
 * them at all — and `build.ts` says as much where it declares them: the caller
 * its `TypeError` protects against reads a target from an argument vector or an
 * environment variable, where TypeScript never sees the value. That caller is
 * what this widening stands in for, and it is the implementation signature it
 * widens to rather than anything looser.
 */
const buildAnyTarget = buildDistribution as (options: {
  target: string;
  version?: string;
  projectRoot?: string | URL;
}) => Promise<unknown>;

test("unknown distribution target fails with a useful diagnostic", async () => {
  await assert.rejects(
    buildAnyTarget({ target: "archive", projectRoot }),
    /Unknown distribution target: archive/,
  );
});
