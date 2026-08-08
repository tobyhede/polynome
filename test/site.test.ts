import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDistribution, distributionVersion } from "../scripts/build.ts";

const projectRoot = new URL("..", import.meta.url);
const output = new URL("../site/", import.meta.url);

/**
 * The Content-Security-Policy assertions below, and their counterparts in
 * `test/bundle.test.ts`, both need to read an emitted document the way a browser
 * does. The three helpers are written out in each file rather than imported from
 * `scripts/build.ts`, and that is the whole point of them: a test that computed
 * its expectation by calling the build's own hashing would agree with the build
 * about a wrong answer, because the two would move together. What must be proved
 * is that the hash in the policy is the hash of what the element actually holds,
 * so the element's text is read out of the artifact here and the digest is taken
 * here. See [ADR-0022](../docs/adr/0022-compute-the-content-security-policy-at-build-time.md).
 */
const inlineDigest = (body: string) =>
  `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

/**
 * Every inline element of one name, read as the tokenizer reads it: from the
 * open tag to the first `</name` followed by whitespace, `/` or `>`. The scan
 * resumes after that end tag rather than anywhere inside the body, because a
 * bundled `<script` in a string literal is text and not a second open tag —
 * which matters in the single-file artifact, where the body is the whole
 * application.
 *
 * An element carrying `src` is skipped: it holds no text, and what a hash would
 * cover is not what the browser executes.
 */
function inlineBodies(html: string, tagName: string) {
  const open = new RegExp(`<${tagName}(\\s[^>]*)?>`, "gi");
  const close = new RegExp(`</${tagName}(?=[\\t\\n\\f\\r />]|$)`, "gi");
  const bodies = [];
  let index = 0;
  while (index < html.length) {
    open.lastIndex = index;
    const start = open.exec(html);
    if (!start) break;
    const bodyStart = start.index + start[0].length;
    close.lastIndex = bodyStart;
    const end = close.exec(html);
    if (!/\ssrc\s*=/i.test(start[1] ?? "")) {
      bodies.push(html.slice(bodyStart, end ? end.index : html.length));
    }
    index = end ? close.lastIndex : html.length;
  }
  return bodies;
}

/** The policy as a browser would read it off the document, and nothing else. */
function policyOf(html: string) {
  const content = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i,
  )?.[1];
  assert.ok(content, "Expected a Content-Security-Policy meta element");
  return content;
}

/** The policy split the way the parser splits it, so a directive can be held by name. */
function directivesOf(policy: string) {
  return new Map(
    policy.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

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

/**
 * OFL 1.1 §2 lets a Modified Version be redistributed provided each copy carries
 * the copyright notice and the licence, and both faces are Modified Versions
 * because subsetting is modification — the SIL FAQ says so at 2.6. The notice is
 * in the woff2 itself at name ID 0. The licence is only here if something puts
 * it here, and for a year nothing did: the two texts sat in `fonts/` looking
 * like they discharged the obligation while no build read them.
 *
 * Asserted against the source bytes rather than against a length or a first
 * line, because a licence truncated in transit is worse than one absent — it
 * looks discharged. `major-mono-display-OFL.txt` is published by google/fonts
 * with CRLF terminators and is exempt from the LF rule in `.gitattributes` for
 * that reason, so a comparison that normalised newlines would pass over exactly
 * the corruption worth catching.
 */
test("the site ships a licence beside every face it emits", async () => {
  await buildDistribution({ target: "site", projectRoot });
  const emitted = await readdir(output);

  const faces = emitted.filter((name) => name.endsWith(".woff2"));
  assert.ok(
    faces.length > 0,
    "the site build emitted no woff2, so this proved nothing about the licences beside them",
  );

  const licences = await readdir(new URL("fonts/", projectRoot));
  const texts = licences.filter((name) => name.endsWith("-OFL.txt"));
  assert.equal(
    texts.length,
    faces.length,
    `the site emits ${faces.length} faces (${faces.join(", ")}) but fonts/ holds ${texts.length} licence texts (${texts.join(", ")}). Every face redistributed here needs one.`,
  );

  for (const text of texts) {
    const source = await readFile(new URL(`fonts/${text}`, projectRoot));
    const shipped = await readFile(new URL(text, output)).catch(() => null);
    assert.ok(
      shipped !== null,
      `site/${text} was not emitted, so the site redistributes a subset face with no licence accompanying it. OFL 1.1 §2 asks for one.`,
    );
    assert.deepEqual(
      shipped,
      source,
      `site/${text} differs from fonts/${text}. The licence is redistributed verbatim or not at all.`,
    );
  }
});

test("site distribution versions transitive chunks without manual rewrites", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
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
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
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
        '<meta charset="UTF-8" />',
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
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" />',
    ),
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
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
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

/**
 * GitHub Pages serves what is in the directory and sets no response headers, so
 * a `<meta http-equiv>` is the only place a policy can go. The hash is the part
 * that cannot be written by hand: the inline script it covers is the Accent
 * bootstrap, which is source like any other, and a hash that stopped matching
 * would not fail anything — the browser would refuse the script, the stylesheet
 * would paint the default, and the page would look very nearly right. So the
 * expectation here is derived from the emitted document rather than restated,
 * and the whole policy is held as one string: a directive quietly added or
 * dropped is the change this is here to catch.
 */
test("the site policy hashes the inline script the artifact actually ships", async () => {
  await buildDistribution({ target: "site", version: "cspsite", projectRoot });
  const html = await readFile(new URL("index.html", output), "utf8");
  const scripts = inlineBodies(html, "script");

  assert.equal(scripts.length, 1, "Expected the Accent bootstrap to be the only inline script");
  assert.deepEqual(inlineBodies(html, "style"), [], "Expected the site to link its stylesheet");
  assert.equal(
    policyOf(html),
    [
      "default-src 'none'",
      `script-src 'self' ${inlineDigest(scripts[0])}`,
      "style-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
});

/**
 * The regression guard, and the reason the exercise is worth doing at all. A
 * policy is loosened one keyword at a time by whoever is unblocking themselves
 * at the time, and every one of these turns the document back into one where an
 * injected `<script>` runs. `'unsafe-inline'` is the whole policy undone;
 * `'unsafe-eval'` reopens the string-to-code route the bundle has none of; a
 * `default-src` that is not `'none'` silently supplies a fallback to every
 * directive nobody thought to write down.
 */
test("the site policy admits no route to executing injected markup", async () => {
  await buildDistribution({ target: "site", projectRoot });
  const policy = policyOf(await readFile(new URL("index.html", output), "utf8"));
  const directives = directivesOf(policy);

  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  for (const keyword of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    assert.ok(
      !directives.get("script-src")?.includes(keyword),
      `script-src admits ${keyword}: ${policy}`,
    );
  }
  assert.ok(!/'unsafe-/.test(policy), `Policy admits an unsafe keyword: ${policy}`);
});

/**
 * `frame-ancestors` is one of three directives a document-supplied policy is
 * required to ignore, alongside `report-uri` and `sandbox`. Written here it
 * would read as clickjacking protection to everyone who saw it and would do
 * nothing at all, which is worse than the absence: the absence is at least
 * visible to whoever goes looking for it. The header GitHub Pages will not send
 * is the only place it works, so this holds the directive out rather than in.
 */
test("the site policy carries no directive a meta element would ignore", async () => {
  await buildDistribution({ target: "site", projectRoot });
  const policy = policyOf(await readFile(new URL("index.html", output), "utf8"));

  for (const ignored of ["frame-ancestors", "report-uri", "sandbox"]) {
    assert.ok(!policy.includes(ignored), `Policy states ${ignored}, which a meta element ignores`);
  }
});

/**
 * A policy governs what is fetched after the parser reaches it, so a meta
 * element that arrived after the stylesheet link or the bootstrap would leave
 * exactly those two ungoverned while still reading, to anyone auditing the
 * document, as a page with a policy. It sits immediately after the character
 * encoding declaration, which is the one thing that has to come first.
 */
test("the site policy is declared before anything it governs", async () => {
  await buildDistribution({ target: "site", projectRoot });
  const html = await readFile(new URL("index.html", output), "utf8");
  const policyAt = html.search(/<meta\s+http-equiv="Content-Security-Policy"/i);
  const charsetAt = html.search(/<meta\s+charset=/i);

  assert.ok(charsetAt >= 0 && charsetAt < policyAt, "Expected the encoding declaration first");
  assert.ok(policyAt < html.indexOf("<link"), "Expected the policy before the stylesheet link");
  assert.ok(policyAt < html.indexOf("<script"), "Expected the policy before the first script");
});

/**
 * The policy is spliced in after the encoding declaration, so a document without
 * one has nowhere to put it — and the failure would otherwise be an artifact
 * that ships with no policy at all, which no later assertion about a served page
 * would notice. It joins the family of rewrites this build refuses rather than
 * skips.
 */
test("the site build refuses a document with no character encoding declaration", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-site-charset-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await assert.rejects(
    buildDistribution({ target: "site", version: "nocharset", projectRoot: fixture }),
    /index\.html has no character encoding declaration/,
  );
});
