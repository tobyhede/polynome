import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguration } from "../configuration.ts";
import { decodeSharePayload, encodeShareConfiguration } from "../share.ts";

async function gzipPayload(text: string) {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

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
  const shared = await decodeSharePayload(payload);

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

test("a Share payload rejects JSON that is not recognizably a Configuration", async () => {
  const payload = await gzipPayload(JSON.stringify({ unrelated: true }));

  await assert.rejects(decodeSharePayload(payload), /not a Configuration/);
});

test("a Share payload rejects malformed compressed JSON", async () => {
  await assert.rejects(decodeSharePayload(await gzipPayload('{"bpm":120')));
});

test("a Share payload rejects malformed gzip data", async () => {
  await assert.rejects(decodeSharePayload("bm90LWd6aXA"));
});

test("a Share payload stops decompression beyond 64 KiB", async () => {
  const payload = await encodeShareConfiguration({
    ...createConfiguration(),
    padding: "x".repeat(70 * 1024),
  });

  await assert.rejects(decodeSharePayload(payload), /64 KiB/);
});
