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

async function workflowFiles() {
  const files = (await readdir(workflows)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, "no workflow files found to check");
  return files;
}

/**
 * A step that runs `actions/checkout`. Anchored to the start of a line, and
 * allowing only indentation and a list item's `- ` before the key, so that a
 * `#` ahead of it rules the line out: a comment can say anything, and
 * `# uses: actions/checkout@v4` beside a step that checks nothing out would
 * otherwise be counted as a checkout — inflating the count that reports how
 * many steps were examined, and asserting the option below against a step that
 * never takes a credential in the first place.
 */
const CHECKOUT_STEP = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*actions\/checkout(?=[@ \t]|$)/m;

/**
 * The `persist-credentials: false` input, as an active property rather than as
 * text somewhere in the step. Written as a comment it reads exactly like the
 * line that switches the option off while switching nothing off at all, which
 * is the one way a step could both persist the token and satisfy this.
 *
 * The value has to end the line, because YAML begins a comment only at a `#`
 * preceded by whitespace: `persist-credentials: false#note` is the string
 * `false#note`, not the boolean, so it is not this option being set and is
 * rejected. A `#` after a space is an ordinary trailing comment and is allowed.
 */
const PERSIST_CREDENTIALS_FALSE = /^[ \t]*persist-credentials:[ \t]*false(?:[ \t]+#.*)?[ \t]*$/m;

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
  let checkouts = 0;
  for (const file of await workflowFiles()) {
    const workflow = await readFile(join(workflows, file), "utf8");
    for (const step of steps(workflow)) {
      if (!CHECKOUT_STEP.test(step)) continue;
      checkouts += 1;
      assert.match(
        step,
        PERSIST_CREDENTIALS_FALSE,
        `${file} checks out without persist-credentials: false in step:\n${step}`,
      );
    }
  }

  assert.ok(checkouts > 0, "no checkout steps found, so nothing was actually checked");
});

/**
 * A release tag is a branch name that moves: whoever can push the tag decides
 * what every future run of this workflow executes, and the deploy job holds
 * `id-token: write`. A commit SHA cannot be moved, so pin to one and leave the
 * release it names in a comment, which is the only part a reader can check.
 * Local actions are paths, not published references, and carry no such risk.
 */
test("every workflow action is pinned to an immutable commit", async () => {
  let references = 0;
  for (const file of await workflowFiles()) {
    const workflow = await readFile(join(workflows, file), "utf8");
    for (const line of workflow.split("\n")) {
      const reference = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/)?.[1];
      if (reference === undefined || reference.startsWith("./")) continue;
      references += 1;
      assert.match(reference, /@[0-9a-f]{40}$/, `${file} uses a mutable reference: ${reference}`);
    }
  }

  assert.ok(references > 0, "no action references found, so nothing was actually checked");
});
