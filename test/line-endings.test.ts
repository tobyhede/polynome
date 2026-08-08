import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Git decides whether a file is text by looking for a NUL byte in its opening
 * 8000, and this reads the same window rather than keeping a list of binary
 * extensions. A list would have to be remembered, and the cost of forgetting is
 * silent: a `.png` nobody added to it is read as text, found to contain no line
 * endings at all, and passes.
 */
const SNIFF = 8000;

/**
 * The repository is enumerated through git rather than walked, for the reason
 * `test/syntax.test.ts` gives: a walk needs its own list of directories to
 * skip, and that list goes stale. Tracked files are exactly the files this
 * repository ships, so `node_modules`, `dist`, `site` and `test-results` are
 * absent by construction rather than by being named here, and a new file joins
 * the set by being committed.
 *
 * The mode is read alongside the path because `.claude/skills` holds symlinks
 * to skill directories kept elsewhere on disk. Only regular files are kept: a
 * symlink's content is a path rather than text this repository wrote, and
 * reading one follows it out of the tree — onto a directory, in every case
 * here, which is an error rather than a verdict.
 */
async function trackedFiles() {
  const { stdout } = await run("git", ["ls-files", "-z", "--stage"], { cwd: root });

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
 * `.gitattributes` is where an exception to LF is declared, so it is where this
 * reads one from. Keeping a second list here instead would let the two
 * disagree, and the disagreement that matters is the silent one: git converting
 * a file on checkout that this test then reports, or refuses to report.
 *
 * `-text` marks bytes git must not convert in either direction. The only files
 * carrying it are the two OFL texts, which are redistributed exactly as their
 * upstreams publish them — and Google Fonts publishes
 * `ofl/majormonodisplay/OFL.txt` with CRLF terminators. Normalising a licence
 * this repository did not write is not this guard's business.
 */
async function unnormalised(paths: string[]) {
  const { stdout } = await run("git", ["check-attr", "-z", "text", "--"].concat(paths), {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
  });
  const fields = stdout.split("\0");
  const exempt = new Set<string>();

  // `check-attr -z` emits a flat path/attribute/value triple per file.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "unset") exempt.add(fields[index]);
  }
  return exempt;
}

/**
 * Any carriage return is refused, not only the CRLF pair, because a lone CR is
 * no more an LF than a pair is and there is no reason for either to be here.
 * The line number is counted in LF terminators so it names the line a reader's
 * editor will show.
 */
function carriageReturns(contents: Buffer) {
  const first = contents.indexOf("\r");

  if (first === -1) return null;

  let count = 0;
  for (let index = first; index !== -1; index = contents.indexOf("\r", index + 1)) count += 1;

  let line = 1;
  for (let index = contents.indexOf("\n"); index !== -1 && index < first; ) {
    line += 1;
    index = contents.indexOf("\n", index + 1);
  }
  return { count, line };
}

/**
 * Nothing in this repository looked for a line ending until a re-cut of the two
 * embedded faces re-copied their licence files and one of them arrived with
 * CRLF terminators on all 93 lines. It reached review as a diff in which every
 * line was changed and none of the words were, which is the shape that gets
 * waved through — `--ignore-all-space` reported nothing, so the eye had nothing
 * to catch on.
 *
 * That file turned out to be verbatim upstream and is exempt below, but the
 * hazard it demonstrated is general and points the other way too: an editor
 * configured for CRLF, or a clone on Windows without the `eol=lf` that now sits
 * in `.gitattributes`, rewrites whole files invisibly. The distributions are
 * built by concatenating this source, so a stray CR ends up in shipped bytes,
 * and `test/artifact-size.test.ts` measures a budget those bytes count against.
 *
 * The check is cheap and the enumeration is shared with the two other
 * repository-hygiene tests, so it costs one traversal to close a hole that no
 * amount of reading diffs reliably closes.
 */
test("every tracked text file uses LF line endings", async () => {
  const tracked = await trackedFiles();

  assert.ok(tracked.length > 0, "no tracked files found, so nothing was actually checked");
  assert.ok(
    tracked.includes("styles.css"),
    `styles.css is tracked but was not enumerated, so the file list is wrong: ${tracked.join(", ")}`,
  );

  const exempt = await unnormalised(tracked);
  const offenders: string[] = [];
  let examined = 0;

  for (const path of tracked) {
    if (exempt.has(path)) continue;

    const contents = await readFile(join(root, path));

    if (contents.subarray(0, SNIFF).includes(0)) continue;
    examined += 1;

    const found = carriageReturns(contents);

    if (found) {
      offenders.push(
        `  ${path} holds ${found.count} carriage return${
          found.count === 1 ? "" : "s"
        }, the first on line ${found.line}`,
      );
    }
  }

  // Every file being exempt or binary reads exactly like every file being
  // clean, and one `* -text` in `.gitattributes` is all it takes to get there.
  assert.ok(
    examined > 0,
    `${tracked.length} tracked files were enumerated but none were examined, so this check proved nothing: ${exempt.size} are marked -text in .gitattributes and the rest read as binary`,
  );

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} tracked ${
      offenders.length === 1 ? "file carries a carriage return" : "files carry carriage returns"
    }:\n\n${offenders.join(
      "\n",
    )}\n\nRewrite each with LF terminators. If instead the bytes are an upstream's and have to stay verbatim, declare the path \`-text\` in \`.gitattributes\` beside the two OFL texts, which is what exempts them here.`,
  );
});
