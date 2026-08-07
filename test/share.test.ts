import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createConfiguration } from "../configuration.ts";
import {
  createShareConfigurationUrl,
  decodeShareConfiguration,
  decodeShareConfigurationFragment,
  encodeShareConfiguration,
  isShareConfigurationFragment,
} from "../share.ts";

function untrustedSharePayload(value) {
  return gzipSync(JSON.stringify(value)).toString("base64url");
}

test("a Share link owns its URL fragment grammar", async () => {
  const url = await createShareConfigurationUrl(
    "https://polynome.example/metronome",
    createConfiguration({ bpm: 135 }),
  );
  const fragment = new URL(url).hash;

  assert.match(url, /^https:\/\/polynome\.example\/metronome#share=[A-Za-z0-9_-]+$/);
  assert.equal(isShareConfigurationFragment(fragment), true);
  assert.equal((await decodeShareConfigurationFragment(fragment)).bpm, 135);
  assert.equal(isShareConfigurationFragment("#help"), false);
});

test("a Share payload carries the Configuration without generated identifiers", async () => {
  const original = createConfiguration({
    bpm: 135,
    sequence: {
      cycles: [
        {
          repetitions: 2,
          rhythms: [{ signature: { count: 7, unit: 8 }, subdivision: 3, pan: -0.4 }],
        },
      ],
    },
  });

  const payload = await encodeShareConfiguration(original);
  const shared = await decodeShareConfiguration(payload);

  assert.equal(shared.bpm, 135);
  assert.equal(shared.sequence.cycles[0].repetitions, 2);
  assert.deepEqual(shared.sequence.cycles[0].rhythms[0].signature, { count: 7, unit: 8 });
  assert.equal(shared.sequence.cycles[0].rhythms[0].subdivision, 3);
  assert.equal(shared.sequence.cycles[0].rhythms[0].pan, -0.4);
  assert.notEqual(shared.sequence.cycles[0].id, original.sequence.cycles[0].id);
  assert.notEqual(
    shared.sequence.cycles[0].rhythms[0].id,
    original.sequence.cycles[0].rhythms[0].id,
  );
});

test("a Share payload excludes undeclared Configuration properties", async () => {
  const configuration = createConfiguration({
    bpm: 135,
    sequence: { cycles: [{ rhythms: [{ subdivision: 3 }] }] },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const withExtras = {
    ...configuration,
    configurationExtra: "not shared",
    sequence: {
      cycles: [
        {
          ...cycle,
          cycleExtra: "not shared",
          rhythms: [{ ...rhythm, rhythmExtra: "not shared" }],
        },
      ],
    },
  };

  assert.equal(
    await encodeShareConfiguration(withExtras),
    await encodeShareConfiguration(configuration),
  );
});

test("a Share payload rejects JSON that is not recognizably a Configuration", async () => {
  const payload = untrustedSharePayload({ sequence: { cycles: [] } });

  await assert.rejects(decodeShareConfiguration(payload), /not a Configuration/);
});

test("a Share payload rejects malformed gzip data", async () => {
  await assert.rejects(decodeShareConfiguration("bm90LWd6aXA"));
});

test("a Share payload stops decompression beyond 64 KiB", async () => {
  const payload = untrustedSharePayload({
    ...createConfiguration(),
    padding: "x".repeat(70 * 1024),
  });

  await assert.rejects(decodeShareConfiguration(payload), /64 KiB/);
});
