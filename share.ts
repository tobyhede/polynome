import { createConfiguration } from "./configuration.ts";

const SHARE_FRAGMENT_PREFIX = "#share=";
// A fragment is untrusted input and gzip can expand a short URL into far more
// data than the Configuration domain could use. This ceiling bounds the work
// and memory spent before JSON parsing while leaving ample room for the largest
// Configuration the interface can create; see
// [ADR-0021](docs/adr/0021-share-configurations-in-client-only-url-fragments.md).
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

function shareConfigurationShape(configuration) {
  // Cycle and Rhythm-layer identifiers coordinate interface edits; they carry
  // no musical identity across browsers. Omitting them shortens the link and
  // lets Configuration repair issue identifiers owned by the recipient rather
  // than presenting a sender's implementation detail as durable data; see
  // [ADR-0021](docs/adr/0021-share-configurations-in-client-only-url-fragments.md).
  // Every shared field is named below so an undeclared property cannot become
  // part of the wire shape merely because a caller carries it.
  const repaired = createConfiguration(configuration);
  return {
    bpm: repaired.bpm,
    sequence: {
      cycles: repaired.sequence.cycles.map((cycle) => ({
        envelope: { shape: cycle.envelope.shape, amount: cycle.envelope.amount },
        repetitions: cycle.repetitions,
        rhythms: cycle.rhythms.map((rhythm) => ({
          signature: { count: rhythm.signature.count, unit: rhythm.signature.unit },
          subdivision: rhythm.subdivision,
          displayMode: rhythm.displayMode,
          steps: rhythm.steps,
          volume: rhythm.volume,
          pan: rhythm.pan,
          sound: rhythm.sound,
          muted: rhythm.muted,
        })),
      })),
    },
  };
}

export async function encodeShareConfiguration(configuration) {
  const input = new Blob([JSON.stringify(shareConfigurationShape(configuration))]).stream();
  const compressed = input.pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  return bytesToBase64Url(bytes);
}

export async function decodeShareConfiguration(payload: string) {
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

export function isShareConfigurationFragment(fragment: string) {
  return fragment.startsWith(SHARE_FRAGMENT_PREFIX);
}

export async function createShareConfigurationUrl(baseUrl: string, configuration) {
  const payload = await encodeShareConfiguration(configuration);
  return `${baseUrl}${SHARE_FRAGMENT_PREFIX}${payload}`;
}

export function decodeShareConfigurationFragment(fragment: string) {
  if (!isShareConfigurationFragment(fragment)) {
    throw new TypeError("Fragment does not contain a shared Configuration");
  }
  return decodeShareConfiguration(fragment.slice(SHARE_FRAGMENT_PREFIX.length));
}
