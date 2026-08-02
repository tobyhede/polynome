import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [html, cssSource, jetBrainsMono, majorMonoDisplay, model, configuration, sharedTransport, metronome, app] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "fonts", "jetbrains-mono-latin.woff2")),
  readFile(join(root, "fonts", "major-mono-display-latin.woff2")),
  readFile(join(root, "model.js"), "utf8"),
  readFile(join(root, "configuration.js"), "utf8"),
  readFile(join(root, "shared-transport.js"), "utf8"),
  readFile(join(root, "metronome.js"), "utf8"),
  readFile(join(root, "app.js"), "utf8"),
]);

const css = cssSource
  .replaceAll("./fonts/jetbrains-mono-latin.woff2", `data:font/woff2;base64,${jetBrainsMono.toString("base64")}`)
  .replaceAll("./fonts/major-mono-display-latin.woff2", `data:font/woff2;base64,${majorMonoDisplay.toString("base64")}`);

function withoutImports(source) {
  return source.replace(/^import\s+[\s\S]*?;\s*$/gm, "");
}

function withoutExports(source) {
  return source.replace(/\bexport\s+/g, "");
}

const javascript = [
  "'use strict';",
  withoutExports(withoutImports(model)),
  withoutExports(withoutImports(configuration)),
  withoutExports(withoutImports(sharedTransport)),
  withoutExports(withoutImports(metronome)),
  withoutExports(withoutImports(app)),
].join("\n\n");

const bundled = html
  .replace(/\s*<link rel="stylesheet" href="\.\/styles\.css" \/>/, `\n    <style>\n${css}\n    </style>`)
  .replace(
    /\s*<script type="module" src="\.\/app\.js"><\/script>/,
    `\n    <script>\n${javascript}\n    </script>`,
  );

const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
await writeFile(join(dist, "polynome.html"), bundled);
console.log("Created dist/polynome.html");
