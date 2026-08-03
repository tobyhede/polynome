import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { buildDistribution } from "../scripts/build.mjs";

const projectRoot = new URL("..", import.meta.url);
const artifact = new URL("../dist/polynome.html", import.meta.url);

function browserStub() {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => "";
      if (property === Symbol.iterator) return function* empty() {};
      if (property === "then") return undefined;
      return browserStub();
    },
    set: () => true,
    has: () => true,
    apply: () => browserStub(),
    construct: () => browserStub(),
  });
}

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

test("single-file distribution discovers transitive modules and preserves their scopes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "dist"));
  await Promise.all([
    writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>'),
    writeFile(join(fixture, "styles.css"), "body { color: white; }"),
    writeFile(join(fixture, "app.js"), 'import { left } from "./left.js"; import { right } from "./right.js"; globalThis.fixtureResult = `${left}:${right}`;'),
    writeFile(join(fixture, "left.js"), 'import { suffix } from "./nested.js"; const label = "left"; export const left = label + suffix;'),
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
    writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>'),
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

test("build diagnostics identify an unresolved transitive module", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "polynome-build-error-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(fixture, "index.html"), '<link rel="stylesheet" href="./styles.css" /><script type="module" src="./app.js"></script>'),
    writeFile(join(fixture, "styles.css"), "body {}"),
    writeFile(join(fixture, "app.js"), 'import "./missing.js";'),
  ]);

  await assert.rejects(
    buildDistribution({ target: "single-file", projectRoot: fixture }),
    /Could not resolve ["']\.\/missing\.js["']/,
  );
});
