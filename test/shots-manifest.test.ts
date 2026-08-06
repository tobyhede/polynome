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

// The matrix the tests below are declared against. Named once so a test about
// what is no longer in it does not have to restate what is.
const STATE_NAMES = ["idle", "dense"];
const PROFILE_NAMES = ["iphone-se", "pixel-7"];

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

    const kept = await priorShots(
      directory,
      new Set(["idle__iphone-se"]),
      STATE_NAMES,
      PROFILE_NAMES,
    );

    assert.deepEqual(
      kept.map((entry) => `${entry.state}__${entry.profile}`),
      ["idle__pixel-7", "dense__iphone-se"],
    );
  });
});

/**
 * A filtered run never clears the directory, so the manifest it reads can still
 * name a state or a profile the matrix has since been renamed or emptied of.
 * Keeping such a shot is not merely showing something stale: nothing downstream
 * knows it is stale, so it is folded in as an equal.
 */
test("a shot the matrix no longer declares is dropped rather than kept", async () => {
  await withDirectory(async (directory) => {
    await writeManifest(directory, [
      shot("idle", "pixel-7"),
      shot("idle", "nexus-5"),
      shot("colour", "pixel-7"),
    ]);

    const kept = await priorShots(directory, new Set(), STATE_NAMES, PROFILE_NAMES);

    assert.deepEqual(
      kept.map((entry) => `${entry.state}__${entry.profile}`),
      ["idle__pixel-7"],
    );
  });
});

/**
 * The damage a retired shot does is to the reading order rather than to any one
 * card. `inMatrixOrder` ranks by `indexOf`, which answers -1 for a name the
 * matrix does not hold, so a single undeclared profile sorts ahead of the whole
 * sheet and the failure arrives as a contact sheet nobody can read in rows.
 */
test("a shot the matrix no longer declares cannot displace the reading order", async () => {
  await withDirectory(async (directory) => {
    await writeManifest(directory, [shot("dense", "pixel-7"), shot("idle", "nexus-5")]);

    const kept = await priorShots(
      directory,
      new Set(["idle__iphone-se"]),
      STATE_NAMES,
      PROFILE_NAMES,
    );
    const all = inMatrixOrder([...kept, shot("idle", "iphone-se")], STATE_NAMES, PROFILE_NAMES);

    assert.deepEqual(
      all.map((entry) => `${entry.state}__${entry.profile}`),
      ["idle__iphone-se", "dense__pixel-7"],
    );
  });
});

test("a first run has no manifest and keeps nothing", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await priorShots(directory, new Set(), STATE_NAMES, PROFILE_NAMES), []);
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
      () => priorShots(directory, new Set(), STATE_NAMES, PROFILE_NAMES),
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
