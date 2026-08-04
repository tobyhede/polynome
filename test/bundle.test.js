import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { buildDistribution } from "../scripts/build.mjs";

const projectRoot = new URL("..", import.meta.url);
const artifact = new URL("../dist/polynome.html", import.meta.url);

/**
 * `app.js` reads the document, wires listeners, and renders the whole interface
 * while its module body evaluates, so the artifact cannot be executed at all
 * without something document-shaped. A recursive proxy answers every property
 * and every call with another proxy, which is all that markup-building code
 * needs, and it keeps this test about the artifact rather than about how
 * faithfully a hand-written DOM behaves.
 */
function browserStub(onSet = () => {}) {
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
function browserContext({ denyStorage = false, onBpmRendered = () => {} } = {}) {
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
 * Running the real build writes real output into the gitignored `dist/`, which
 * is deliberate: only the shipped artifact shows what a browser would load.
 */
test("single-file distribution embeds browser-valid JavaScript, CSS, and fonts", async () => {
  await buildDistribution({ target: "single-file", projectRoot });
  const html = await readFile(artifact, "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";

  assert.ok(script, "Expected an inline classic script");
  assert.match(html, /<style>/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /(?:src|href)="\.\/(?:app\.js|styles\.css|fonts\/)/);
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
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";
  const renderedBpms = [];
  const context = browserContext({
    denyStorage: true,
    onBpmRendered: (value) => renderedBpms.push(value),
  });

  assert.ok(script, "Expected an inline classic script");
  assert.doesNotThrow(() => new vm.Script(script).runInContext(context));
  // Written out rather than read back from `configuration.js`: an expected value
  // the code under test computes agrees with itself no matter what it renders.
  assert.equal(renderedBpms.at(-1), "96", "Expected the default 96 BPM to reach the interface");
});

test("single-file distribution discovers transitive modules and preserves their scopes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body { color: white; }"),
    // The string below is not a template that lost its backticks. It is the
    // source of a fixture module written to disk and then bundled, so the
    // placeholder has to survive as text for the build under test to resolve
    // it. The suppression sits on the argument rather than the call, because
    // the formatter decides which line the string lands on.
    writeFile(
      join(fixture, "app.js"),
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
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";
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
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>',
    ),
    writeFile(join(fixture, "styles.css"), 'body::before { content: "$&"; }'),
    writeFile(join(fixture, "app.js"), 'globalThis.fixtureToken = "$&";'),
  ]);

  await buildDistribution({ target: "single-file", projectRoot: fixture });
  const html = await readFile(join(fixture, "dist", "polynome.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";
  const context = vm.createContext({});
  new vm.Script(script).runInContext(context);

  assert.equal(context.fixtureToken, "$&");
  assert.match(html, /content: "\$&"/);
});

/**
 * Esbuild's warnings are the only static analysis this project has beyond
 * `node --check`, and every one of them describes source that parses but does
 * not do what it says. Refusing the artifact is the difference between finding
 * a duplicate key at build time and finding it in a browser.
 */
test("single-file distribution refuses JavaScript esbuild warns about", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-warning-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.js"), "globalThis.fixture = { rate: 1, rate: 2 };"),
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
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body { colr: red; }"),
    writeFile(join(fixture, "app.js"), "globalThis.fixture = 1;"),
  ]);

  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /"colr" is not a known CSS property/,
  );
});

/**
 * The document is the one input esbuild does not read, so a tag that moved or
 * lost an attribute is only ever noticed here. Refusing beats emitting an
 * artifact with a live `./app.js` request in it, which loads nothing from a
 * file opened straight off disk.
 */
test("single-file distribution refuses a document it cannot rewrite", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-document-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, "styles.css"), "body {}");
  await writeFile(join(fixture, "app.js"), "globalThis.fixture = 1;");

  await writeFile(join(fixture, "index.html"), '<script type="module" src="./app.js"></script>');
  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /index\.html has no \.\/styles\.css stylesheet/,
  );

  await writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" />');
  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /index\.html has no \.\/app\.js module script/,
  );
});

test("build diagnostics identify an unresolved transitive module", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-error-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(fixture, "index.html"),
      '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>',
    ),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.js"), 'import "./missing.js";'),
  ]);

  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /Could not resolve ["']\.\/missing\.js["']/,
  );
});
