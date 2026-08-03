import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function rootPath(projectRoot) {
  if (projectRoot instanceof URL) return fileURLToPath(projectRoot);
  return resolve(projectRoot ?? defaultProjectRoot);
}

function replaceRequired(source, pattern, replacement, description) {
  if (!pattern.test(source)) {
    throw new Error(`Cannot build distribution: index.html has no ${description}`);
  }
  return source.replace(pattern, () => replacement);
}

async function buildSingleFile(root) {
  const cssSource = await readFile(join(root, "styles.css"), "utf8");
  const [html, javascriptResult, cssResult] = await Promise.all([
    readFile(join(root, "index.html"), "utf8"),
    build({
      absWorkingDir: root,
      entryPoints: ["app.js"],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2020"],
      write: false,
      legalComments: "none",
      banner: { js: '"use strict";' },
      logLevel: "silent",
    }),
    build({
      absWorkingDir: root,
      stdin: {
        contents: cssSource,
        loader: "css",
        resolveDir: root,
        sourcefile: "styles.css",
      },
      bundle: true,
      loader: { ".woff2": "dataurl" },
      write: false,
      legalComments: "none",
      logLevel: "silent",
    }),
  ]);

  const javascript = javascriptResult.outputFiles[0]?.text;
  const css = cssResult.outputFiles[0]?.text;
  if (!javascript || !css) throw new Error("Cannot build single-file distribution: esbuild emitted an incomplete artifact");

  let artifact = replaceRequired(
    html,
    /\s*<link\s+rel=["']stylesheet["']\s+href=["']\.\/styles\.css["']\s*\/?\s*>/,
    `\n    <style>\n${css}    </style>`,
    "./styles.css stylesheet",
  );
  artifact = replaceRequired(
    artifact,
    /\s*<script\s+type=["']module["']\s+src=["']\.\/app\.js["']\s*>\s*<\/script>/,
    `\n    <script>\n${javascript}    </script>`,
    "./app.js module script",
  );

  const output = join(root, "dist");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "polynome.html"), artifact);
  return { target: "single-file", output: join(output, "polynome.html") };
}

async function buildSite(root, requestedVersion) {
  const version = String(requestedVersion ?? process.env.GITHUB_SHA ?? "local").slice(0, 12);
  const output = join(root, "site");
  const html = await readFile(join(root, "index.html"), "utf8");

  await rm(output, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["app.js", "styles.css"],
    outdir: output,
    bundle: true,
    format: "esm",
    splitting: true,
    platform: "browser",
    target: ["es2020"],
    entryNames: `[name]-${version}`,
    chunkNames: `[name]-${version}-[hash]`,
    assetNames: `[name]-${version}`,
    loader: { ".woff2": "file" },
    legalComments: "none",
    logLevel: "silent",
    write: false,
  });

  const expectedOutputs = [
    join(output, `app-${version}.js`),
    join(output, `styles-${version}.css`),
  ];
  if (!expectedOutputs.every((expected) => (
    result.outputFiles.some((file) => file.path === expected)
  ))) {
    throw new Error("Cannot build site distribution: esbuild emitted an incomplete artifact");
  }

  let siteHtml = replaceRequired(
    html,
    /\.\/styles\.css/,
    `./styles-${version}.css`,
    "./styles.css reference",
  );
  siteHtml = replaceRequired(
    siteHtml,
    /\.\/app\.js/,
    `./app-${version}.js`,
    "./app.js reference",
  );
  await mkdir(output, { recursive: true });
  await Promise.all([
    ...result.outputFiles.map(async (file) => {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }),
    writeFile(join(output, "index.html"), siteHtml),
    writeFile(join(output, ".nojekyll"), ""),
  ]);
  return { target: "site", version, output };
}

/**
 * Build one browser distribution from the native-module source tree. Esbuild
 * owns dependency discovery and JavaScript/CSS/asset rewriting for both
 * targets; callers only choose the artifact they need.
 */
export async function buildDistribution({ target, version, projectRoot } = {}) {
  const root = rootPath(projectRoot);
  if (target === "single-file") return buildSingleFile(root);
  if (target === "site") return buildSite(root, version);
  throw new TypeError(`Unknown distribution target: ${target}`);
}
