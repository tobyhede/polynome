import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { buildDistribution, withoutRawTextTerminator } from "../scripts/build.ts";

const projectRoot = new URL("..", import.meta.url);
const artifact = new URL("../dist/polynome.html", import.meta.url);

/**
 * `app.ts` reads the document, wires listeners, and renders the whole interface
 * while its module body evaluates, so the artifact cannot be executed at all
 * without something document-shaped. A recursive proxy answers every property
 * and every call with another proxy, which is all that markup-building code
 * needs, and it keeps this test about the artifact rather than about how
 * faithfully a hand-written DOM behaves.
 */
function browserStub(onSet: (property: string | symbol, value: unknown) => void = () => {}) {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => "";
      if (property === Symbol.iterator) return function* empty() {};
      // A thenable would make an awaited stub hang.
      if (property === "then") return undefined;
      return browserStub();
    },
    set(_target, property, value) {
      onSet(property, value);
      return true;
    },
    has: () => true,
    apply: () => browserStub(),
    construct: () => browserStub(),
  });
}

// The browser surface the application reaches for. Storage is real because the
// application reads it back and parses what it gets.
function browserContext({
  denyStorage = false,
  onBpmRendered = () => {},
}: {
  denyStorage?: boolean;
  onBpmRendered?: (value: unknown) => void;
} = {}) {
  const storage = new Map();
  const bpmInput = browserStub((property, value) => {
    if (property === "value") onBpmRendered(value);
  });
  const document = new Proxy(browserStub(), {
    get(target, property, receiver) {
      if (property === "querySelector") {
        return (selector) => (selector === "#bpm-input" ? bpmInput : browserStub());
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const globals = {
    document,
    window: browserStub(),
    CSS: { escape: String },
    ResizeObserver: browserStub(),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    EventTarget,
    CustomEvent,
    resolveStorage() {
      if (denyStorage) throw new DOMException("Access denied", "SecurityError");
      return {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
      };
    },
  };
  const context = vm.createContext(globals);
  /**
   * The accessor has to be installed on the context's own global rather than on
   * the contextified object. An accessor reached through vm's global proxy has
   * its exception swallowed and the name reported as undeclared, so a denied
   * store would raise `ReferenceError` here and `SecurityError` in a browser —
   * the same guard would pass the test while simulating the wrong failure.
   */
  new vm.Script(`
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => resolveStorage(),
    });
  `).runInContext(context);
  return context;
}

/**
 * The application, as the artifact carries it. The shell has an inline classic
 * script of its own — the one that puts the Accent on the root element before
 * first paint — and it comes first, in the head. So the bundle is the last of
 * them rather than the only one, and saying that here is what keeps these tests
 * exercising the application instead of the few lines above it.
 */
function bundledScript(html) {
  const scripts = Array.from(html.matchAll(/<script>\s*([\s\S]*?)\s*<\/script>/g), (m) => m[1]);
  return scripts.at(-1) ?? "";
}

/**
 * Running the real build writes real output into the gitignored `dist/`, which
 * is deliberate: only the shipped artifact shows what a browser would load.
 */
test("single-file distribution embeds browser-valid JavaScript, CSS, and fonts", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const html = await readFile(artifact, "utf8");
  const script = bundledScript(html);

  assert.ok(script, "Expected an inline classic script");
  assert.match(html, /<style>/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /(?:src|href)="\.\/(?:app\.ts|styles\.css|fonts\/)/);
  assert.doesNotMatch(html, /url\(["']?\.\/fonts\//);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotThrow(() => new vm.Script(script).runInContext(browserContext()));
});

/**
 * The document carries an import map so a browser loading source directly can
 * resolve `preact` and `htm` against the installed packages. Nothing in the
 * artifact needs it — esbuild bundles those modules in — and the paths it names
 * lead into a directory the distribution does not contain, so a map that
 * survived the build would describe a resolution that cannot happen from a file
 * opened off disk. The site target asserts the same thing from the other
 * direction, by resolving every reference it emits against the files it wrote.
 *
 * What is banned is a quoted relative path into `node_modules`, which is the
 * shape the map and every `src` or `href` would take. The bare word is expected
 * to appear: esbuild labels each bundled module with the path it came from, and
 * a comment names a file without asking the browser for it.
 */
test("single-file distribution carries no import map and no fetchable installed-package path", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const html = await readFile(artifact, "utf8");

  assert.doesNotMatch(html, /type=["']importmap["']/);
  assert.doesNotMatch(html, /["']\.\/node_modules\//);
});

/**
 * A browser that refuses storage throws on the `localStorage` property itself,
 * before any method is called, so this is the one storage failure the
 * application cannot notice by checking what it read back. Starting anyway, on
 * defaults, is the behaviour under test.
 */
test("single-file distribution starts with defaults when storage access is denied", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const html = await readFile(artifact, "utf8");
  const script = bundledScript(html);
  const renderedBpms = [];
  const context = browserContext({
    denyStorage: true,
    onBpmRendered: (value) => renderedBpms.push(value),
  });

  assert.ok(script, "Expected an inline classic script");
  assert.doesNotThrow(() => new vm.Script(script).runInContext(context));
  // Written out rather than read back from `configuration.ts`: an expected value
  // the code under test computes agrees with itself no matter what it renders.
  assert.equal(renderedBpms.at(-1), "120", "Expected the default 120 BPM to reach the interface");
});

test("single-file distribution discovers transitive modules and preserves their scopes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body { color: white; }"),
    // The string below is not a template that lost its backticks. It is the
    // source of a fixture module written to disk and then bundled, so the
    // placeholder has to survive as text for the build under test to resolve
    // it. The suppression sits on the argument rather than the call, because
    // the formatter decides which line the string lands on.
    writeFile(
      join(fixture, "app.ts"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, not a template
      'import { left } from "./left.js"; import { right } from "./right.js"; globalThis.fixtureResult = `${left}:${right}`;',
    ),
    writeFile(
      join(fixture, "left.js"),
      'import { suffix } from "./nested.js"; const label = "left"; export const left = label + suffix;',
    ),
    writeFile(join(fixture, "right.js"), 'const label = "right"; export const right = label;'),
    writeFile(join(fixture, "nested.js"), 'export const suffix = "-nested";'),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const script = bundledScript(html);
  const context = vm.createContext({});
  new vm.Script(script).runInContext(context);

  assert.equal(context.fixtureResult, "left-nested:right");
});

test("single-file distribution preserves String.replace tokens in bundled source", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-token-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), 'body::before { content: "$&"; }'),
    writeFile(join(fixture, "app.ts"), 'globalThis.fixtureToken = "$&";'),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const script = bundledScript(html);
  const context = vm.createContext({});
  new vm.Script(script).runInContext(context);

  assert.equal(context.fixtureToken, "$&");
  assert.match(html, /content: "\$&"/);
});

/**
 * Read a raw text element the way an HTML parser does: from the open tag to the
 * first `</name` followed by whitespace, `/` or `>`, matched without regard to
 * case. The tokenizer applies that rule to the character stream alone — it has
 * no notion of a JavaScript string literal or a CSS declaration — so extracting
 * this way is what makes an early termination visible to a test instead of only
 * to a browser. The regexes elsewhere in this file look for a well-formed
 * `</script>`; that would find the closing tag the build wrote and quietly miss
 * a body that had already ended several kilobytes earlier.
 */
function rawTextOf(html, name) {
  return html.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}[\\s/>]`, "i"))?.[1] ?? "";
}

/**
 * Nothing about a `<script>` element's content is parsed as JavaScript before
 * its end is found, so a `</script>` inside a string literal ends the element
 * there and spills the rest of the bundle into the document as markup. The
 * fixture asserts on what the element actually holds, and both cases are here
 * because the tokenizer compares the tag name case-insensitively.
 */
test("single-file distribution keeps a bundled `</script>` inside the inline script", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-script-end-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body { color: white; }"),
    writeFile(
      join(fixture, "app.ts"),
      'globalThis.fixtureLower = "</script>"; globalThis.fixtureUpper = "</SCRIPT>";',
    ),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const script = rawTextOf(html, "script");
  const context = vm.createContext({});
  new vm.Script(script).runInContext(context);

  assert.equal(context.fixtureLower, "</script>");
  assert.equal(context.fixtureUpper, "</SCRIPT>");
});

/**
 * A `<style>` element ends the same way, and a custom property is the reachable
 * route to one: its value is an arbitrary token sequence, so `</style>` is
 * something CSS is required to carry through rather than something a stylesheet
 * has no way to say.
 *
 * The assertions are on the tail of each declaration, because that is what an
 * early end takes away — the value would be cut mid-token and the rest of the
 * stylesheet would leave the element as text on the page.
 */
test("single-file distribution keeps a bundled `</style>` inside the inline stylesheet", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-style-end-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), ":root { --lower: a</style>b; --upper: c</STYLE>d; }"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const style = rawTextOf(html, "style");

  assert.match(style, /--lower:[^;]*b;/);
  assert.match(style, /--upper:[^;]*d;/);
  assert.match(style, /}/, "Expected the rule to reach its closing brace");
});

/**
 * What ends a raw text element is `</` and the name *and* a delimiter after it:
 * whitespace, `/`, or `>`. `</stylex` is none of those, so it is ordinary text
 * that needs no rewriting, and escaping it anyway edits a value the build was
 * only ever meant to pass through — `<` `/` `stylex` becomes `<` `/stylex`,
 * which is a different token sequence carrying the same code points.
 *
 * A custom property is the route to all of this for the same reason it is in
 * the test above: esbuild prints the value's tokens verbatim, so what the
 * assertions see is this build's own escaping and nothing else. The expected
 * text is written out in full rather than matched loosely, because the delimiter
 * is exactly what a wrong pattern would swallow — an escape that ate the `>` of
 * `</style>` would still leave a declaration that parses and a stylesheet that
 * reaches its closing brace.
 *
 * The last case is the one that decides where the delimiter goes. In
 * `i</style</style>j` the first sequence is text, because a `<` follows the
 * name, and the second closes the element; only a match that leaves the name
 * unconsumed is still positioned to find it.
 */
test("single-file distribution escapes an end tag and leaves a longer name alone", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-style-name-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(
      join(fixture, "styles.css"),
      ":root { --gt: a</style>b; --space: c</style d; --slash: e</style/f; --longer: g</stylex h; --twice: i</style</style>j; }",
    ),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const style = rawTextOf(html, "style");

  assert.ok(style.includes("--gt: a<\\/style>b;"), `Unescaped \`</style>\` in ${style}`);
  assert.ok(style.includes("--space: c<\\/style d;"), `Unescaped \`</style \` in ${style}`);
  assert.ok(style.includes("--slash: e<\\/style/f;"), `Unescaped \`</style/\` in ${style}`);
  assert.ok(style.includes("--longer: g</stylex h;"), `Rewrote \`</stylex\` in ${style}`);
  assert.ok(
    style.includes("--twice: i</style<\\/style>j;"),
    `Wrong \`</style\` escaped in ${style}`,
  );
});

/**
 * The one case no artifact can show. This returns a body the caller splices
 * straight in front of its own closing tag, so a `</style` flush against the end
 * of that body is followed by the whitespace of the tag that comes next and
 * closes the element there — the delimiter exists, it just arrives after the
 * string this function was handed. Both bundlers end their output with a
 * newline, which is a delimiter of its own and hides the case, so it is reached
 * by calling directly or not at all.
 */
test("a raw text terminator flush against the end of a body is escaped", () => {
  assert.equal(withoutRawTextTerminator("a</style", "style"), "a<\\/style");
  assert.equal(withoutRawTextTerminator("a</stylex", "style"), "a</stylex");
});

/**
 * Esbuild's warnings are the only static analysis the assembled bundle gets —
 * Biome and `tsc` read the source, neither resolves the module graph — and
 * every one of them describes source that parses but does not do what it says.
 * Refusing the artifact is the difference between finding a duplicate key at
 * build time and finding it in a browser.
 */
test("single-file distribution refuses JavaScript esbuild warns about", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-warning-"));
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
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /Duplicate key "rate" in object literal/,
  );
});

test("single-file distribution refuses CSS esbuild warns about", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-css-warning-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body { colr: red; }"),
    writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;"),
  ]);

  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /"colr" is not a known CSS property/,
  );
});

/**
 * The document is the one input esbuild does not read, so a tag that moved or
 * lost an attribute is only ever noticed here. Refusing beats emitting an
 * artifact with a live `./app.ts` request in it, which loads nothing from a
 * file opened straight off disk.
 */
test("single-file distribution refuses a document it cannot rewrite", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-document-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, "styles.css"), "body {}");
  await writeFile(join(fixture, "app.ts"), "globalThis.fixture = 1;");

  await writeFile(
    join(fixture, "index.html"),
    '<meta charset="UTF-8" /><script type="module" src="./app.ts"></script>',
  );
  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /index\.html has no \.\/styles\.css stylesheet/,
  );

  await writeFile(
    join(fixture, "index.html"),
    '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" />',
  );
  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /index\.html has no \.\/app\.ts module script/,
  );
});

test("build diagnostics identify an unresolved transitive module", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-error-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.ts"), 'import "./missing.js";'),
  ]);

  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /Could not resolve ["']\.\/missing\.js["']/,
  );
});

/**
 * The Content-Security-Policy helpers, written out here rather than imported
 * from `scripts/build.ts` for the reason `test/site.test.ts` states at length: a
 * test that hashed through the build's own helper would agree with the build
 * about a wrong answer. `rawTextOf` above already reads one element the way the
 * tokenizer does; this reads every element of a name, and resumes the scan after
 * each end tag rather than anywhere inside a body — which is what this artifact
 * makes necessary, since one of its bodies is the whole bundled application and
 * a `<script` inside a string literal there is text, not a second open tag.
 */
const inlineDigest = (body: string) =>
  `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

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

function policyOf(html: string) {
  const content = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i,
  )?.[1];
  assert.ok(content, "Expected a Content-Security-Policy meta element");
  return content;
}

function directivesOf(policy: string) {
  return new Map(
    policy.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

/**
 * Everything this artifact loads, it carries: an inline stylesheet, the Accent
 * bootstrap, and the bundled application as a second inline script, with both
 * woff2 faces as `data:` URIs. So every source in its policy is a hash or a
 * scheme, and there are three hashes to get right rather than one — a wrong one
 * refuses its element in silence and leaves a page that still renders.
 *
 * The order the hashes are stated in is the document order the artifact writes
 * them in, which is what makes this an equality rather than a set comparison.
 */
test("the single-file policy hashes every inline element the artifact carries", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const html = await readFile(artifact, "utf8");
  const scripts = inlineBodies(html, "script");
  const styles = inlineBodies(html, "style");

  assert.equal(scripts.length, 2, "Expected the Accent bootstrap and the bundled application");
  assert.equal(styles.length, 1, "Expected the inlined stylesheet");
  assert.equal(
    policyOf(html),
    [
      "default-src 'none'",
      `script-src ${scripts.map(inlineDigest).join(" ")}`,
      `style-src ${inlineDigest(styles[0])}`,
      "font-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
});

/**
 * This artifact is one file, and one file is opened from `file://` as often as
 * it is served. There `'self'` matches nothing — an opaque origin is not equal
 * to itself — so a policy carrying it would refuse the bundle, the stylesheet
 * and the bootstrap together, and the page would still lay out: the markup is
 * static, so what a reader gets is an unstyled shell rather than a blank tab or
 * an error. Measured rather than reasoned about: with `script-src 'self'` a
 * Chromium loading the artifact off disk reports `script-src-elem` and
 * `style-src-elem` violations for all three, renders no Cycles, and falls back
 * to Times. Hashes match on any origin, so hashes are the whole policy here.
 */
test("the single-file policy names no origin a file:// document cannot match", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const policy = policyOf(await readFile(artifact, "utf8"));

  assert.ok(
    !policy.includes("'self'"),
    `Policy relies on an origin file:// has none of: ${policy}`,
  );
  assert.ok(!/https?:/.test(policy), `Policy names a network origin: ${policy}`);
});

/**
 * The same regression guard `test/site.test.ts` holds over the site policy, and
 * it is repeated rather than shared because the two policies are built
 * separately and either one can be loosened without the other.
 */
test("the single-file policy admits no route to executing injected markup", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const policy = policyOf(await readFile(artifact, "utf8"));
  const directives = directivesOf(policy);

  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  for (const keyword of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    assert.ok(
      !directives.get("script-src")?.includes(keyword),
      `script-src admits ${keyword}: ${policy}`,
    );
  }
  assert.ok(!/'unsafe-/.test(policy), `Policy admits an unsafe keyword: ${policy}`);
  for (const ignored of ["frame-ancestors", "report-uri", "sandbox"]) {
    assert.ok(!policy.includes(ignored), `Policy states ${ignored}, which a meta element ignores`);
  }
});

/**
 * A hash is over the exact text the parser hands the element, so the build has
 * to hash what it wrote and not what it was about to write. The escaping of a
 * raw text terminator happens on the way into the element, and a policy computed
 * before it would name the digest of a body no browser ever sees. The fixture
 * puts a `</script>` in a string literal, which is the one thing that moves
 * between the two.
 */
test("the single-file policy hashes the escaped body, not the source before it", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-csp-escape-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<meta charset="UTF-8" /><link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.ts"></script>',
    ),
    writeFile(join(fixture, "styles.css"), ":root { --raw: a</style>b; }"),
    writeFile(join(fixture, "app.ts"), 'globalThis.fixture = "</script>";'),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const directives = directivesOf(policyOf(html));

  assert.deepEqual(directives.get("script-src"), inlineBodies(html, "script").map(inlineDigest));
  assert.deepEqual(directives.get("style-src"), inlineBodies(html, "style").map(inlineDigest));
  assert.ok(html.includes("<\\/script>"), "Expected the terminator to have been escaped");
});

test("the single-file build refuses a document with no character encoding declaration", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-charset-"));
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
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /index\.html has no character encoding declaration/,
  );
});
