import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = "./app.js";

/**
 * The rewrite and the dependency graph read the same pattern, so a statement
 * the bundle rewrites can never be missing from the graph that orders the
 * modules. Anchoring to a whole statement also keeps the words `import` and
 * `from` inside a string or a comment from being read as a dependency.
 */
const IMPORT_STATEMENT = /^import\s+\{([\s\S]*?)\}\s+from\s+["'](.+?)["'];\s*$/gm;

/**
 * `export` is only a keyword where a statement begins. Stripping every
 * occurrence of the word would also rewrite it inside a string, a comment, or a
 * property name, and the result would still be valid JavaScript — a silently
 * wrong bundle that no syntax check can catch. Match the statement position
 * instead, the same position the exported-name pattern reads.
 */
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm;
const EXPORTED_NAME = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

function importedSpecifiers(source) {
  return Array.from(source.matchAll(IMPORT_STATEMENT), (match) => match[2]);
}

function withBundledImports(source) {
  return source.replace(
    IMPORT_STATEMENT,
    (_statement, bindings, specifier) => (
      `const {${bindings.replace(/\bas\b/g, ":")}} = modules[${JSON.stringify(specifier)}];`
    ),
  );
}

function withoutExports(source) {
  return source.replace(EXPORT_KEYWORD, "");
}

export function bundledModule(specifier, source) {
  const exports = Array.from(source.matchAll(EXPORTED_NAME), (match) => match[1]);
  const exposed = exports.length ? `\nreturn { ${exports.join(", ")} };` : "";
  return `modules[${JSON.stringify(specifier)}] = (() => {\n${withoutExports(withBundledImports(source))}${exposed}\n})();`;
}

/**
 * Every rewritten import reads `modules["./x"]` as soon as its wrapping IIFE
 * runs, so a module emitted ahead of one it imports throws while the page is
 * loading rather than while the bundle is being built. Deriving the order from
 * the imports themselves, depth first and dependency last, means a hand-written
 * list can never disagree with what the modules actually need. Sorting each
 * module's own imports keeps the emitted order stable however the import
 * statements happen to be arranged in the source.
 */
export function bundleOrder(sources, entry = ENTRY) {
  const order = [];
  const settled = new Set();
  const open = new Set();

  function visit(specifier) {
    if (settled.has(specifier)) return;
    if (open.has(specifier)) {
      throw new Error(`${specifier} imports itself through a cycle and cannot be ordered`);
    }
    const source = sources.get(specifier);
    if (source === undefined) throw new Error(`${specifier} is imported but was never read`);
    open.add(specifier);
    for (const dependency of importedSpecifiers(source).sort()) visit(dependency);
    open.delete(specifier);
    settled.add(specifier);
    order.push(specifier);
  }

  visit(entry);
  return order;
}

function bundledScript(sources, entry = ENTRY) {
  return [
    "'use strict';",
    "(() => {",
    "const modules = Object.create(null);",
    ...bundleOrder(sources, entry).map(
      (specifier) => bundledModule(specifier, sources.get(specifier)),
    ),
    "})();",
  ].join("\n\n");
}

/**
 * Reading through the import graph rather than from a list means a new module
 * joins the bundle by being imported, with nothing left to remember to add.
 */
async function readModules(entry) {
  const sources = new Map();
  const pending = [entry];
  while (pending.length) {
    const specifier = pending.pop();
    if (sources.has(specifier)) continue;
    const source = await readFile(join(root, specifier), "utf8");
    sources.set(specifier, source);
    pending.push(...importedSpecifiers(source));
  }
  return sources;
}

async function build() {
  const [html, cssSource, jetBrainsMono, majorMonoDisplay, sources] = await Promise.all([
    readFile(join(root, "index.html"), "utf8"),
    readFile(join(root, "styles.css"), "utf8"),
    readFile(join(root, "fonts", "jetbrains-mono-latin.woff2")),
    readFile(join(root, "fonts", "major-mono-display-latin.woff2")),
    readModules(ENTRY),
  ]);

  const css = cssSource
    .replaceAll("./fonts/jetbrains-mono-latin.woff2", `data:font/woff2;base64,${jetBrainsMono.toString("base64")}`)
    .replaceAll("./fonts/major-mono-display-latin.woff2", `data:font/woff2;base64,${majorMonoDisplay.toString("base64")}`);

  const bundled = html
    .replace(/\s*<link rel="stylesheet" href="\.\/styles\.css" \/>/, `\n    <style>\n${css}\n    </style>`)
    .replace(
      /\s*<script type="module" src="\.\/app\.js"><\/script>/,
      `\n    <script>\n${bundledScript(sources)}\n    </script>`,
    );

  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "polynome.html"), bundled);
  console.log("Created dist/polynome.html");
}

// The tests import `bundledModule` and `bundleOrder` to exercise them on
// sources of their own, so only a direct run may write build output.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await build();
}
