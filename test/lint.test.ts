import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Runs a command and reports its status rather than throwing on a failing one,
 * because both tests below assert the status the lint entry point returned and
 * a rejection would take the output with it.
 */
async function status(command: string, args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await run(command, args, { cwd, maxBuffer: 1024 * 1024 * 16 });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, output: (error.stdout ?? "") + (error.stderr ?? "") };
  }
}

/**
 * The files Biome reports it actually opened, taken from its own `--verbose`
 * output rather than from anything this repository computed. A count derived
 * here would agree with a broken enumeration about a wrong answer; Biome's list
 * is the only account of what was really examined.
 *
 * The list runs from the `Files processed:` heading to the rule that opens the
 * next section, and an empty one is reported as `The list is empty.` rather
 * than as no lines at all, so a marker line ends the run too.
 */
function processedFiles(output: string) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.includes("Files processed:"));

  assert.notEqual(start, -1, `Biome printed no processed-file list:\n\n${output}`);

  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = line.match(/^\s*- (\S.*?)\s*$/);
    if (entry) files.push(entry[1]);
    else if (line.trim() !== "") break;
  }
  return files;
}

/**
 * The paths git tracks, read the way `scripts/lint.ts` reads them, because the
 * test below asserts what the entry point examined against what the repository
 * holds and the two have to be talking about the same names.
 */
async function trackedFiles() {
  const { stdout } = await run("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
  });
  return new Set(stdout.split("\0").filter((entry) => entry !== ""));
}

/**
 * A checkout of the working tree at a path under `.claude/worktrees/`, which is
 * where agent worktrees of this repository live and the one place the lint
 * entry point was broken. It is built by copying rather than by
 * `git worktree add`, because a worktree carries the committed tree and what
 * has to be exercised is the entry point as it stands in the working tree,
 * uncommitted changes included — a fix that had to be committed before its own
 * test could see it is a fix nobody can develop test-first.
 *
 * Enumeration is `git ls-files`, for the reason `test/syntax.test.ts` gives,
 * widened to the untracked-but-not-ignored files so that a script added and not
 * yet committed is copied too. Only regular files are copied: `.claude/skills`
 * holds symlinks to directories, and copying one either follows it out of the
 * tree or fails outright.
 *
 * `node_modules` is linked rather than installed. The fixture needs Biome and
 * nothing else, and an install here would cost more than every other test in
 * this suite put together.
 */
async function checkoutUnderWorktrees() {
  const worktrees = join(root, ".claude", "worktrees");
  await mkdir(worktrees, { recursive: true });
  const fixture = await mkdtemp(join(worktrees, "lint-fixture-"));

  const { stdout } = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      maxBuffer: 1024 * 1024 * 8,
    },
  );

  for (const path of stdout.split("\0").filter((entry) => entry !== "")) {
    const source = join(root, path);
    if (!(await lstat(source)).isFile()) continue;
    const destination = join(fixture, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await run("git", ["init", "--quiet"], { cwd: fixture });
  await run("git", ["add", "--all"], { cwd: fixture });
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");

  return fixture;
}

/**
 * `biome check .` processed nothing at all from a checkout under
 * `.claude/worktrees/`: the exclusions that stop the primary checkout linting
 * copies of itself match the path the checkout is at, so `.` is refused and the
 * whole tree with it. That failure is loud, but the shape is not — a lint whose
 * file set comes from scanning a directory can quietly shrink to a subset, and
 * a green result over an empty set reads exactly like a green result over the
 * repository.
 *
 * So this asserts what was examined and not only that nothing was wrong. The
 * status alone would have passed on `main` for a config that exited zero over
 * no files, which is the failure the issue warns about rather than the one it
 * reports.
 */
test("the lint entry point checks the tracked files from a checkout under .claude/worktrees", async (t) => {
  const fixture = await checkoutUnderWorktrees();
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const { code, output } = await status(
    "npm",
    ["--silent", "run", "lint", "--", "--verbose"],
    fixture,
  );
  const files = processedFiles(output);

  assert.ok(files.length > 0, `the lint entry point examined no files at all:\n\n${output}`);
  assert.ok(
    files.includes("app.ts"),
    `app.ts is tracked but was not examined, so the lint set is wrong: ${files.join(", ")}`,
  );
  assert.equal(code, 0, `the lint entry point failed from a worktree checkout:\n\n${output}`);
});

/**
 * What the entry point examines from the repository root, which is where it
 * runs day to day and where the fixture above cannot speak for it: that fixture
 * is a copy and a copy carries no symlinks, while `.claude/skills` is a
 * directory of them and Biome scans through one it is handed.
 *
 * The subset assertion is the other half of the exclusions this replaced.
 * `.claude/worktrees/` holds full checkouts of this repository, each with its
 * own source and its own Biome configuration, and none of it is this
 * repository's to lint. Nothing there is tracked, so enumerating rather than
 * scanning leaves it out by construction — which is the claim being made here,
 * and it is worth making against the real tree, since a developer working from
 * an agent worktree has one of those checkouts sitting inside another.
 */
test("the lint entry point checks the repository's own tracked files and nothing else", async () => {
  const { code, output } = await status(
    "npm",
    ["--silent", "run", "lint", "--", "--verbose"],
    root,
  );
  const files = processedFiles(output);
  const tracked = await trackedFiles();

  assert.ok(files.length > 0, `the lint entry point examined no files at all:\n\n${output}`);
  for (const name of ["app.ts", "styles.css", "index.html"]) {
    assert.ok(
      files.includes(name),
      `${name} is tracked but was not examined, so the lint set is wrong: ${files.join(", ")}`,
    );
  }

  const untracked = files.filter((name) => !tracked.has(name));

  assert.deepEqual(
    untracked,
    [],
    `${untracked.length} examined ${
      untracked.length === 1 ? "file is" : "files are"
    } not tracked by git, so the lint reached beyond this repository:\n\n${untracked.join("\n")}`,
  );
  assert.equal(code, 0, `the lint entry point failed from the repository root:\n\n${output}`);
});
