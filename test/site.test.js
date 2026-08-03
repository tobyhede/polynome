import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDistribution } from "../scripts/build.mjs";

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

test("site distribution versions transitive chunks without manual rewrites", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>'),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.js"), 'globalThis.loadFeature = () => import("./feature.js");'),
    writeFile(join(fixture, "feature.js"), 'export const feature = "discovered";'),
  ]);

  await buildDistribution({ target: "site", version: "fixture1234567", projectRoot: fixture });
  const directory = join(fixture, "site");
  const emitted = await readdir(directory);
  const appName = "app-fixture12345.js";
  const app = await readFile(join(directory, appName), "utf8");
  const imported = app.match(/import\(["']\.\/(.+?)["']\)/)?.[1];

  assert.ok(imported, "Expected a transitive chunk import");
  assert.match(imported, /^feature-fixture12345-[A-Z0-9]+\.js$/);
  assert.ok(emitted.includes(imported));
});

test("site distribution defaults to the local version", async () => {
  const previousSha = process.env.GITHUB_SHA;
  delete process.env.GITHUB_SHA;
  try {
    await buildDistribution({ target: "site", projectRoot });
    const emitted = await readdir(output);
    assert.ok(emitted.includes("app-local.js"));
    assert.ok(emitted.includes("styles-local.css"));
  } finally {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
  }
});

test("site distribution uses the GitHub revision prefix", async () => {
  const previousSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = "0123456789abcdef";
  try {
    const result = await buildDistribution({ target: "site", projectRoot });
    const emitted = await readdir(output);
    assert.equal(result.version, "0123456789ab");
    assert.ok(emitted.includes("app-0123456789ab.js"));
  } finally {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
  }
});

test("unknown distribution target fails with a useful diagnostic", async () => {
  await assert.rejects(
    buildDistribution({ target: "archive", projectRoot }),
    /Unknown distribution target: archive/,
  );
});
