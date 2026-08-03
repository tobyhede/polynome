import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const workflows = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/**
 * Steps are recovered by indentation rather than parsed as YAML, because the
 * project carries no runtime or development dependency that could parse it and
 * a workflow file is not worth one. Only the shape this repository writes is
 * understood: a `steps:` key whose list items each begin with `- ` at one
 * consistent indent. A step keeps every following deeper-indented line, so a
 * `uses:` on its own line is read as part of the step that owns it.
 */
function steps(workflow) {
  const lines = workflow.split("\n");
  const collected = [];
  let stepsIndent = null;
  let itemIndent = null;
  let current = null;

  const indentOf = (line) => line.length - line.trimStart().length;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = indentOf(line);

    if (stepsIndent !== null && indent <= stepsIndent) {
      stepsIndent = null;
      itemIndent = null;
      current = null;
    }

    if (/^\s*steps:\s*$/.test(line)) {
      stepsIndent = indent;
      itemIndent = null;
      current = null;
      continue;
    }

    if (stepsIndent === null) continue;

    if (itemIndent === null && line.trimStart().startsWith("- ")) {
      itemIndent = indent;
    }

    if (indent === itemIndent && line.trimStart().startsWith("- ")) {
      current = [line];
      collected.push(current);
      continue;
    }

    if (current !== null) current.push(line);
  }

  return collected.map((step) => step.join("\n"));
}

/**
 * `actions/checkout` writes the workflow token into `.git/config` as an auth
 * header unless told not to. Neither job here pushes anything — the deploy job
 * authenticates to Pages through its own OIDC token — but the test job runs
 * `npm ci` and installs a browser, so third-party code executes beside a
 * credential nothing in the workflow needs. A workflow that starts persisting
 * it again still passes every other check in this suite and fails nowhere
 * visible, so assert the option here.
 */
test("every workflow checkout step refuses to persist credentials", async () => {
  const files = (await readdir(workflows)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, "no workflow files found to check");

  let checkouts = 0;
  for (const file of files) {
    const workflow = await readFile(join(workflows, file), "utf8");
    for (const step of steps(workflow)) {
      if (!/uses:\s*actions\/checkout[@\s]/.test(step)) continue;
      checkouts += 1;
      assert.match(
        step,
        /persist-credentials:\s*false/,
        `${file} checks out without persist-credentials: false in step:\n${step}`,
      );
    }
  }

  assert.ok(checkouts > 0, "no checkout steps found, so nothing was actually checked");
});
