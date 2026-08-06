import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inMatrixOrder, priorShots } from "../scripts/shots-manifest.ts";

// Real directories rather than a stubbed filesystem: the behaviour under test
// is which read failures are ordinary and which are not, and only the real
// thing raises those with the codes the module discriminates on.
async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), "polynome-shots-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const shot = (state, profile) => ({ state, profile, file: `${state}__${profile}.png` });

async function writeManifest(directory, shots) {
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ shots }, null, 2));
}

test("a filtered run keeps the shots it is not regenerating", async () => {
  await withDirectory(async (directory) => {
    await writeManifest(directory, [
      shot("idle", "iphone-se"),
      shot("idle", "pixel-7"),
      shot("dense", "iphone-se"),
    ]);

    const kept = await priorShots(directory, new Set(["idle__iphone-se"]));

    assert.deepEqual(
      kept.map((entry) => `${entry.state}__${entry.profile}`),
      ["idle__pixel-7", "dense__iphone-se"],
    );
  });
});

test("a first run has no manifest and keeps nothing", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await priorShots(directory, new Set()), []);
  });
});

/**
 * A manifest that exists but cannot be read is not a first run. Treating it as
 * one drops every shot the filtered run was meant to stand on and still emits a
 * contact sheet, so the loss shows up as absence — the hardest thing to notice
 * in a tool whose whole output is a page of images.
 */
test("a manifest that cannot be read is reported, not taken for a first run", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "manifest.json"), '{"shots": [{"state": "idle"');

    await assert.rejects(
      () => priorShots(directory, new Set()),
      (error: Error) => {
        assert.match(error.message, /manifest/i);
        assert.ok(error.cause instanceof SyntaxError, "keeps the parse failure as the cause");
        return true;
      },
    );
  });
});

test("kept and fresh shots interleave into the order the matrix declares", () => {
  const states = ["idle", "dense"];
  const profiles = ["iphone-se", "pixel-7"];

  const ordered = inMatrixOrder(
    [
      shot("dense", "pixel-7"),
      shot("idle", "pixel-7"),
      shot("dense", "iphone-se"),
      shot("idle", "iphone-se"),
    ],
    states,
    profiles,
  );

  assert.deepEqual(
    ordered.map((entry) => `${entry.state}__${entry.profile}`),
    ["idle__iphone-se", "idle__pixel-7", "dense__iphone-se", "dense__pixel-7"],
  );
});
