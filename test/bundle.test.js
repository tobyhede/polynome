import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

import { bundleOrder, bundledModule } from "../scripts/bundle.mjs";

const execFileAsync = promisify(execFile);

// Resolving against this file rather than the working directory lets the tests
// run from anywhere, not only from the repository root.
const builder = fileURLToPath(new URL("../scripts/bundle.mjs", import.meta.url));
const artifact = fileURLToPath(new URL("../dist/polynome.html", import.meta.url));

/**
 * Running the real build writes real output into the gitignored `dist/`, which
 * is deliberate: only the shipped artifact shows what a browser would load.
 * Build once and share it, because the build rereads and rewrites every module.
 */
let inlineScript = null;
async function bundledInlineScript() {
  if (inlineScript === null) {
    await execFileAsync(process.execPath, [builder]);
    const html = await readFile(artifact, "utf8");
    inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";
  }
  assert.ok(inlineScript, "Expected the bundle to contain an inline script");
  return inlineScript;
}

/**
 * `app.js` reads the document, wires listeners, and renders the whole interface
 * while its module body evaluates, so the bundle cannot be executed at all
 * without something document-shaped. A recursive proxy answers every property
 * and every call with another proxy, which is all that markup-building code
 * needs, and it keeps this test about the bundle rather than about how
 * faithfully a hand-written DOM behaves.
 */
function browserStub() {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => "";
      if (property === Symbol.iterator) return function* empty() {};
      // A thenable would make an awaited stub hang.
      if (property === "then") return undefined;
      return browserStub();
    },
    set: () => true,
    has: () => true,
    apply: () => browserStub(),
    construct: () => browserStub(),
  });
}

// The browser surface the application reaches for. Storage is real because the
// application reads it back and parses what it gets.
function browserContext() {
  const storage = new Map();
  return vm.createContext({
    document: browserStub(),
    window: browserStub(),
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    CSS: { escape: String },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    EventTarget,
    CustomEvent,
  });
}

/**
 * The modules arrive entry first, which is the one order they cannot be
 * evaluated in, so an order that works can only have been derived from the
 * imports. `left` and `right` share `base` to keep a repeated dependency from
 * being emitted twice or, worse, only the second time.
 */
const diamond = new Map([
  ["./app.js", 'import { right } from "./right.js";\nimport { left } from "./left.js";\nexport const pair = left + right;\n'],
  ["./right.js", 'import { base } from "./base.js";\nexport const right = base + 1;\n'],
  ["./left.js", 'import { base } from "./base.js";\nexport const left = base - 1;\n'],
  ["./base.js", "export const base = 21;\n"],
]);

test("the single-file bundle contains valid classic JavaScript", async () => {
  const script = await bundledInlineScript();
  assert.doesNotThrow(() => new vm.Script(script));
});

/**
 * Every rewritten import destructures `modules["./x"]` as its wrapping IIFE is
 * defined, so an emission order that contradicts the import graph throws on the
 * first line a browser reaches. Parsing the bundle cannot see that, so execute
 * it: this is the closest a test gets to opening the file.
 */
test("the bundled application evaluates in a browser-shaped context", async () => {
  const script = await bundledInlineScript();
  assert.doesNotThrow(() => new vm.Script(script).runInContext(browserContext()));
});

test("every module is emitted after the modules it imports", () => {
  const order = bundleOrder(diamond, "./app.js");

  assert.deepEqual(new Set(order), new Set(diamond.keys()));
  assert.equal(order.length, diamond.size);
  for (const [specifier, source] of diamond) {
    for (const [, dependency] of source.matchAll(/from "(.+?)"/g)) {
      assert.ok(
        order.indexOf(dependency) < order.indexOf(specifier),
        `${specifier} is emitted before ${dependency}, which it imports`,
      );
    }
  }
});

/**
 * Both refusals stand where the alternative is a bundle that looks built. A
 * cycle has no order to emit, and a specifier that was never read would be
 * emitted as an empty module whose importers read `undefined`.
 */
test("a cyclic import graph cannot be ordered", () => {
  const cyclic = new Map([
    ["./app.js", 'import { loop } from "./loop.js";\nexport const app = loop;\n'],
    ["./loop.js", 'import { app } from "./app.js";\nexport const loop = app;\n'],
  ]);

  assert.throws(() => bundleOrder(cyclic, "./app.js"), /cycle/);
});

test("an import of a module that was never read cannot be ordered", () => {
  const absent = new Map([
    ["./app.js", 'import { gone } from "./gone.js";\nexport const app = gone;\n'],
  ]);

  assert.throws(() => bundleOrder(absent, "./app.js"), /never read/);
});

/**
 * Keeps the execution test above from becoming a formality. A bundle that emits
 * a module ahead of one it imports is perfectly valid JavaScript, so parsing it
 * reports nothing and only running it finds the fault.
 */
test("a module emitted before the module it imports parses but cannot run", () => {
  const misordered = [
    "'use strict';",
    "(() => {",
    "const modules = Object.create(null);",
    ...["./app.js", "./left.js", "./right.js", "./base.js"]
      .map((specifier) => bundledModule(specifier, diamond.get(specifier))),
    "})();",
  ].join("\n\n");

  assert.doesNotThrow(() => new vm.Script(misordered));
  // A context has its own realm, so match the fault rather than its constructor.
  assert.throws(
    () => new vm.Script(misordered).runInContext(vm.createContext({})),
    /Cannot destructure property 'right'/,
  );
});

/**
 * Nothing in the application writes `export` outside a declaration today, which
 * is exactly why this needs a test: stripping the word from a string or a
 * comment leaves valid JavaScript behind, so the syntax check above would pass
 * a bundle whose content had quietly changed.
 */
test("bundling leaves the word export alone outside a declaration", () => {
  const source = [
    'const hint = "Press export to save";',
    "// Bundling removes the export keyword from a declaration.",
    'const markup = `<button data-action="export cycle"></button>`;',
    "export const label = hint;",
    "export function describe() {",
    "  return markup;",
    "}",
  ].join("\n");

  const bundled = bundledModule("./decoy.js", source);

  assert.match(bundled, /"Press export to save"/);
  assert.match(bundled, /\/\/ Bundling removes the export keyword from a declaration\./);
  assert.match(bundled, /data-action="export cycle"/);
  assert.doesNotMatch(bundled, /^export\s/m);
  assert.match(bundled, /return \{ label, describe \};/);
});
