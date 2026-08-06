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
 * would also make those warnings vanish. Biome and `tsc` read the source, but
 * neither resolves the module graph or the stylesheet, so these are the only
 * analysis the assembled bundle gets. Refuse the
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
 * The import map exists for the browser that loads source directly; neither
 * artifact wants it, because esbuild resolves `preact` and `htm` into the
 * bundle and `node_modules/` ships with neither target. The comment above the
 * tag goes with it, since it documents a tag that is no longer there.
 *
 * This one is removed rather than required. A document with no map is a
 * document with nothing to strip, which is what every build fixture is, and a
 * map that survived would be inert rather than broken — the artifact still
 * runs, it just carries a path into a directory that was never shipped. That
 * `./node_modules/` reference is the thing that must not survive, and both
 * distributions have a test asserting on the emitted artifact that it doesn't.
 */
function withoutImportMap(source) {
  return source.replace(
    /(?:\s*<!--[\s\S]*?-->)?\s*<script\s+type=["']importmap["']\s*>[\s\S]*?<\/script>/,
    "",
  );
}

/**
 * A `<script>` or `<style>` element holds raw text, and the tokenizer ends that
 * text at the first `</script` or `</style` whose name is followed by
 * whitespace, `/`, or `>` — an ASCII case-insensitive match, decided on the
 * character stream alone, with no notion of the JavaScript string literal or
 * CSS declaration the sequence might sit inside. Inlining a bundle is the one
 * place in this build where the bundle's own bytes can close the element around
 * them and spill the remainder into the document as markup.
 * Escaping the solidus breaks the match while denoting the same character in
 * both languages: `\/` is an identity escape in a JavaScript string, and CSS
 * treats a reverse solidus before anything but a newline as a valid escape
 * whose escaped code point is the character that follows it. The HTML standard
 * recommends escaping for the same reason, under "restrictions for contents of
 * script elements".
 *
 * Esbuild covers most of this already, so applying it changes neither artifact
 * as they stand. It is here because the cover is partial and conditional in
 * ways nothing in this repository records or tests. On the JavaScript side the
 * escaping is tied to `platform: "browser"` and to esbuild's `inline-script`
 * feature, either of which turns it off, and it does not reach the path comment
 * esbuild prints above each bundled module — a module under a directory whose
 * name ends in `<` ends the element from a comment. On the CSS side it reaches
 * string tokens only: a custom property's value is an arbitrary token sequence
 * that esbuild passes through verbatim, so `--raw: a</style>b` survives the
 * bundler intact and ends the element, which is what the test for this holds.
 *
 * The alternatives are worse, for reasons worth recording. Escaping the `<` as
 * `\<` does not work at all: it leaves the `<` standing immediately before
 * `/style`, and the tokenizer reads characters, not escapes. The hex form `\3c`
 * does break the sequence, but how much of the input it consumes depends on
 * what follows — up to six hex digits, then one whitespace code point swallowed
 * as its terminator — and esbuild rewrites it to `\<`, which puts the sequence
 * back. Escaping a letter of the name instead, as `</st\yle`, is the one form
 * that leaves the token stream untouched, and it is also the least durable: an
 * escape a name does not need is dropped wherever the CSS is printed again, as
 * esbuild's own printer does, and dropping it restores the sequence. `\/`
 * survives that round trip because an ident beginning with a solidus has to be
 * serialised with the solidus escaped.
 *
 * So the escape is not free of context. Inside a string or a url token `\/`
 * denotes the solidus and the value is unchanged; in a bare token sequence it
 * begins an ident instead, so `<` `/` `style` becomes `<` `/style`. The code
 * points survive and the declaration still parses; the boundary between the
 * solidus and the name does not. Nor does this make an inline script safe in
 * general — the standard names `<!--` and `<script` alongside `</script`, and
 * neither esbuild nor this escapes those.
 *
 * Because the escape is not free of context, the delimiter after the name is
 * part of what is matched rather than an afterthought: `</stylex` ends nothing,
 * so escaping it would edit a value that was never dangerous. The delimiter is
 * matched in a lookahead so the replacement cannot consume it, which is what
 * keeps a `>` from being swallowed and what leaves the scan positioned to find
 * the second sequence in `</style</style>`, where the first is text and the
 * second is the one that closes the element.
 *
 * End of input counts as a delimiter too, because it is not the end of the
 * stream the tokenizer will read: this returns a body the caller splices in
 * front of its own closing tag, so a `</style` flush against the end is
 * followed by that tag's leading whitespace and closes the element there.
 * Nothing here can see what comes next, so it escapes rather than assumes. Both
 * bundlers end their output with a newline, which is a delimiter of its own and
 * hides that case from every artifact, so it is exported for the one test that
 * can reach it by calling directly.
 */
export function withoutRawTextTerminator(body, tagName) {
  return body.replace(new RegExp(`</(?=${tagName}(?:[\\t\\n\\f\\r />]|$))`, "gi"), "<\\/");
}

/**
 * A document may name one asset several times — a preload hint beside the tag
 * that uses it — so every occurrence is rewritten, not the first. Anchoring
 * between the quotes keeps `./app.ts` from matching part of a longer path and
 * leaves the quote characters alone, so one pattern serves `href` and `src`.
 */
function referenceTo(specifier) {
  return new RegExp(`(?<=["'])\\./${specifier.replaceAll(".", "\\.")}(?=["'])`, "g");
}

async function buildSingleFile(
  root,
  outputRoot,
): Promise<{ target: "single-file"; output: string }> {
  const cssSource = await readFile(join(root, "styles.css"), "utf8");
  const [html, javascriptResult, cssResult] = await Promise.all([
    readFile(join(root, "index.html"), "utf8"),
    build({
      absWorkingDir: root,
      entryPoints: ["app.ts"],
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
    withoutImportMap(html),
    /\s*<link\s+rel=["']stylesheet["']\s+href=["']\.\/styles\.css["']\s*\/?\s*>/,
    `\n    <style>\n${withoutRawTextTerminator(css, "style")}    </style>`,
    "./styles.css stylesheet",
  );
  artifact = replaceRequired(
    artifact,
    /\s*<script\s+type=["']module["']\s+src=["']\.\/app\.ts["']\s*>\s*<\/script>/,
    `\n    <script>\n${withoutRawTextTerminator(javascript, "script")}    </script>`,
    "./app.ts module script",
  );

  const output = join(outputRoot, "dist");
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

async function buildSite(
  root,
  outputRoot,
  requestedVersion,
): Promise<{ target: "site"; version: string; output: string }> {
  const version = distributionVersion(requestedVersion, process.env.GITHUB_SHA);
  const output = join(outputRoot, "site");
  const html = await readFile(join(root, "index.html"), "utf8");

  await rm(output, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["app.ts", "styles.css"],
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
    withoutImportMap(html),
    referenceTo("styles.css"),
    `./styles-${version}.css`,
    "./styles.css reference",
  );
  siteHtml = replaceRequired(
    siteHtml,
    referenceTo("app.ts"),
    `./app-${version}.js`,
    "./app.ts reference",
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
 * The two targets are separate signatures because they answer with different
 * things: only the site carries a version, and a caller that asked for one
 * artifact should not have to narrow away the other. The implementation still
 * admits any string, so the `TypeError` below keeps a reachable case — the
 * caller it protects against reads its target from an argument vector or an
 * environment variable, where TypeScript cannot see it.
 */
export async function buildDistribution(options: {
  target: "single-file";
  version?: string;
  projectRoot?: string | URL;
  outputRoot?: string | URL;
}): Promise<{ target: "single-file"; output: string }>;
export async function buildDistribution(options: {
  target: "site";
  version?: string;
  projectRoot?: string | URL;
  outputRoot?: string | URL;
}): Promise<{ target: "site"; version: string; output: string }>;
export async function buildDistribution({
  target,
  version,
  projectRoot,
  outputRoot,
}: {
  target?: string;
  version?: string;
  projectRoot?: string | URL;
  outputRoot?: string | URL;
} = {}) {
  const root = rootPath(projectRoot);
  const destinationRoot = outputRoot === undefined ? root : rootPath(outputRoot);
  if (target === "single-file") return buildSingleFile(root, destinationRoot);
  if (target === "site") return buildSite(root, destinationRoot, version);
  throw new TypeError(`Unknown distribution target: ${target}`);
}
