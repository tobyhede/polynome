import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

// Resolving against this file rather than the working directory lets the entry
// point run from anywhere, not only from the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The repository is enumerated through git rather than handed to Biome as a
 * directory to scan, for the reason `test/syntax.test.ts` and
 * `test/line-endings.test.ts` both give: tracked files are exactly the files
 * this repository ships, `node_modules`, `dist` and `site` are absent by
 * construction rather than by a list that goes stale, and a new file joins the
 * set by being committed.
 *
 * Here it also settles which files get checked at all. `biome check .` returned
 * a different count from one run to the next in this tree — 51 files, or 115,
 * or something between — and from a checkout under `.claude/worktrees/` it
 * returned none, because the exclusion that stops the primary checkout linting
 * copies of itself matched the path the checkout was at and the root path was
 * refused along with it. A scan that reports a green result over a subset it
 * chose by itself is the worse half of that: nothing says which subset, so
 * nothing says what was not checked. An explicit list has one answer.
 *
 * Every tracked file is passed, not a filtered selection of the extensions
 * Biome understands. Biome skips what it cannot handle when it is named
 * alongside files it can, so keeping a list of extensions here would only be
 * one more thing to forget when Biome learns a new one.
 *
 * The mode is read alongside the path because `.claude/skills` holds symlinks
 * to skill directories kept elsewhere on disk. Only regular files are kept:
 * handing Biome a symlink to a directory sets it scanning whatever is on the
 * other end, which is the directory scan this whole entry point exists to stop
 * doing, aimed somewhere outside the repository.
 */
async function trackedFiles() {
  const { stdout } = await run("git", ["ls-files", "-z", "--stage"], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
  });

  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [meta, path] = entry.split("\t");
      return { mode: meta.split(" ")[0], path };
    })
    .filter(({ mode }) => mode === "100644" || mode === "100755")
    .map(({ path }) => path);
}

/**
 * Biome ships a Node shim ahead of its platform binary, so it is resolved as a
 * module and run under this same Node rather than looked up on `PATH`. What is
 * on `PATH` depends on who invoked the entry point — npm puts the local
 * `node_modules/.bin` there and a bare `node scripts/lint.ts` does not — and a
 * lint that silently runs a different Biome, or none, is the same class of
 * problem as one that silently checks a different set of files.
 */
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

const paths = await trackedFiles();

// Nothing enumerated means nothing checked, and nothing checked reads exactly
// like nothing being wrong. Biome would say so itself here, but only by
// accident of having been given no paths; say it deliberately instead.
if (paths.length === 0) {
  console.error("git tracks no files here, so there is nothing to check.");
  process.exit(1);
}

/**
 * One invocation, with the paths as arguments, rather than `git ls-files -z |
 * xargs -0 biome check`. A pipeline reports the status of its last command, so
 * a `git ls-files` that failed would be read as a lint that passed; and xargs
 * splits a long list across several invocations, which turns one summary and
 * one exit status into several of each. Both are the failure this entry point
 * is here to prevent, arriving by a different door.
 *
 * Arguments are forwarded ahead of the paths so that `npm run format` is this
 * same command with `--write`, checking the same files by the same route. An
 * argument list too long for the platform raises `E2BIG` from the spawn, which
 * fails loudly; there is no quiet mode where it checks part of the tree.
 */
const child = spawn(process.execPath, [biome, "check", ...process.argv.slice(2), "--", ...paths], {
  cwd: root,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not run Biome: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    console.error(`Biome was terminated by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
