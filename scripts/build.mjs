import { build, formatMessages } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function rootPath(projectRoot) {
  if (projectRoot instanceof URL) return fileURLToPath(projectRoot);
  return resolve(projectRoot ?? defaultProjectRoot);
}

/**
 * Esbuild warns about source that parses but cannot mean what it says: a
 * duplicate key, an unknown CSS property, a `typeof` comparison no value
 * satisfies. Every build here runs silent so the console stays quiet, which
 * would also make those warnings vanish — and this project has no linter, so
 * they are the only analysis it gets beyond `node --check`. Refuse the
 * artifact instead, because a warning that merely prints is one a green build
 * hides.
 */
async function refuseWarnings(description, results) {
  const warnings = results.flatMap((result) => result.warnings);
  if (!warnings.length) return;
  const reported = await formatMessages(warnings, { kind: "warning", color: false });
  throw new Error(
    `Cannot build ${description}: esbuild reported ${
      warnings.length === 1 ? "a warning" : `${warnings.length} warnings`
    }\n${reported.join("")}`,
  );
}

/**
 * Counting the replacements rather than testing first keeps a global pattern
 * honest: `RegExp.test` leaves `lastIndex` behind it, and the replacement is
 * supplied as a function so a `$&` or `$1` inside bundled source cannot be
 * read as a substitution token.
 */
function replaceRequired(source, pattern, replacement, description) {
  let replaced = 0;
  const result = source.replace(pattern, () => {
    replaced += 1;
    return replacement;
  });
  if (!replaced) {
    throw new Error(`Cannot build distribution: index.html has no ${description}`);
  }
  return result;
}

/**
 * A document may name one asset several times — a preload hint beside the tag
 * that uses it — so every occurrence is rewritten, not the first. Anchoring
 * between the quotes keeps `./app.js` from matching part of a longer path and
 * leaves the quote characters alone, so one pattern serves `href` and `src`.
 */
function referenceTo(specifier) {
  return new RegExp(`(?<=["'])\\./${specifier.replaceAll(".", "\\.")}(?=["'])`, "g");
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

  await refuseWarnings("single-file distribution", [javascriptResult, cssResult]);

  const javascript = javascriptResult.outputFiles[0]?.text;
  const css = cssResult.outputFiles[0]?.text;
  if (!javascript || !css)
    throw new Error(
      "Cannot build single-file distribution: esbuild emitted an incomplete artifact",
    );

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

/**
 * Every emitted filename carries this string, so an empty one is not a version
 * at all — it ships `app-.js`. A revision read from the environment is present
 * and empty often enough (an unset expansion, a shell that exports the name
 * anyway) that emptiness has to fall through rather than win.
 *
 * The resolved value is spliced into output paths and into the shell's asset
 * references, so it is restricted to characters that mean the same thing in a
 * filename and inside an HTML attribute: a separator would write outside the
 * output directory, and a quote would end the attribute early.
 */
export function distributionVersion(requestedVersion, environmentRevision) {
  const version = String(requestedVersion || environmentRevision || "local").slice(0, 12);
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new TypeError(`Distribution version is not filename-safe: ${version}`);
  }
  return version;
}

async function buildSite(root, requestedVersion) {
  const version = distributionVersion(requestedVersion, process.env.GITHUB_SHA);
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

  await refuseWarnings("site distribution", [result]);

  const expectedOutputs = [
    join(output, `app-${version}.js`),
    join(output, `styles-${version}.css`),
  ];
  if (
    !expectedOutputs.every((expected) => result.outputFiles.some((file) => file.path === expected))
  ) {
    throw new Error("Cannot build site distribution: esbuild emitted an incomplete artifact");
  }

  let siteHtml = replaceRequired(
    html,
    referenceTo("styles.css"),
    `./styles-${version}.css`,
    "./styles.css reference",
  );
  siteHtml = replaceRequired(
    siteHtml,
    referenceTo("app.js"),
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
 *
 * @param {object} [options]
 * @param {"single-file" | "site"} [options.target]
 * @param {string} [options.version]
 * @param {string | URL} [options.projectRoot]
 */
export async function buildDistribution({ target, version, projectRoot } = {}) {
  const root = rootPath(projectRoot);
  if (target === "single-file") return buildSingleFile(root);
  if (target === "site") return buildSite(root, version);
  throw new TypeError(`Unknown distribution target: ${target}`);
}
