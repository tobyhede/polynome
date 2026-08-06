import { createConfiguration } from "./configuration.ts";

const MAX_DECOMPRESSED_BYTES = 64 * 1024;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(payload: string) {
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function withoutIdentifiers(configuration) {
  return {
    ...configuration,
    sequence: {
      ...configuration.sequence,
      cycles: configuration.sequence.cycles.map(({ id: _cycleId, rhythms, ...cycle }) => ({
        ...cycle,
        rhythms: rhythms.map(({ id: _rhythmId, ...rhythm }) => rhythm),
      })),
    },
  };
}

export async function encodeShareConfiguration(configuration) {
  const input = new Blob([JSON.stringify(withoutIdentifiers(configuration))]).stream();
  const compressed = input.pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  return bytesToBase64Url(bytes);
}

export async function decodeSharePayload(payload: string) {
  const compressed = new Blob([base64UrlToBytes(payload)]).stream();
  const decompressed = compressed.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_DECOMPRESSED_BYTES) {
      await reader.cancel();
      throw new RangeError("Share payload exceeds 64 KiB");
    }
    json += decoder.decode(value, { stream: true });
  }
  json += decoder.decode();
  const candidate = JSON.parse(json);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.bpm !== "number" ||
    !candidate.sequence ||
    typeof candidate.sequence !== "object" ||
    !Array.isArray(candidate.sequence.cycles)
  ) {
    throw new TypeError("Share payload is not a Configuration");
  }
  return createConfiguration(candidate);
}
