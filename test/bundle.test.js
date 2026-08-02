import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

test("the single-file bundle contains valid classic JavaScript", async () => {
  await execFileAsync(process.execPath, ["scripts/bundle.mjs"]);
  const html = await readFile("dist/polynome.html", "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];

  assert.ok(script, "Expected the bundle to contain an inline script");
  assert.doesNotThrow(() => new vm.Script(script));
});
