import { STEP } from "./model.ts";

const STEP_VOICES = Object.freeze(Object.values(STEP));

/**
 * The two Display modes. They differ in one thing — how many pattern positions
 * a Grid control runs across — and everything else about a control is the same
 * in both, which is why the run length is the only place this module branches
 * on the mode.
 */
export const DISPLAY_MODES = Object.freeze(["beat", "subdivision"]);

function normaliseVoice(voice) {
  return STEP_VOICES.includes(voice) ? voice : STEP.SECONDARY;
}

/**
 * The pattern a grid of this shape holds when nobody has said otherwise: the
 * downbeat, a `secondary` on every later signature unit, and the pulses
 * Subdivision adds within a unit beneath both. A Meter or Subdivision edit
 * writes it outright; repair fills the positions a stored pattern leaves.
 *
 * It takes the meter count and the subdivision rather than a length, because
 * the two cannot be recovered from their product: four units of one and one
 * unit of four are the same length and different music.
 */
export function canonicalPattern(count, subdivision) {
  return Array.from({ length: count * subdivision }, (_, position) => {
    if (position % subdivision !== 0) return STEP.TERTIARY;
    return position === 0 ? STEP.PRIMARY : STEP.SECONDARY;
  });
}

/**
 * A stored pattern decides every position it supplies, and nothing else. What it
 * is missing — because it is short, or because the grid it was saved against was
 * smaller — falls to the canonical pattern, which is the same one an edit to
 * this grid shape would have written.
 */
export function repairPattern(steps, count, subdivision) {
  const source = Array.isArray(steps) ? steps.map(normaliseVoice) : [];
  return canonicalPattern(count, subdivision).map((voice, position) => source[position] || voice);
}

/**
 * How many pattern positions one Grid control runs across. This is the whole of
 * what a Display mode decides: Beat Mode runs a control across a signature
 * unit, Subdivision Mode across a single pattern position, and every other
 * property of a control follows from that one number.
 */
function runLength(rhythm) {
  return rhythm.displayMode === "beat" ? rhythm.subdivision : 1;
}

/**
 * The Grid controls a rhythm layer's Display mode offers, in the order they are
 * shown. Each is a contiguous run of pattern positions: `positions` is the run,
 * `voice` is the Step voice it shows — the voice of the position the run begins
 * on — and `signatureUnit` is the signature unit it falls in, which is what
 * lets a caller group controls a signature unit at a time without restating
 * the arithmetic.
 *
 * The rhythm layer must be repaired. A subdivision of zero would not terminate,
 * and `createRhythm` is what rules that out; nothing here checks it, for the
 * same reason `sameConfiguration` does not check its inputs.
 */
export function controls(rhythm) {
  const length = runLength(rhythm);
  const result = [];
  for (let first = 0; first < rhythm.steps.length; first += length) {
    result.push({
      positions: Array.from({ length }, (_, offset) => first + offset),
      voice: rhythm.steps[first],
      signatureUnit: Math.floor(first / rhythm.subdivision),
    });
  }
  return result;
}

/**
 * Which Grid control a pattern position falls on, which is the inverse of the
 * runs `controls` lays out and the one thing the visual playhead needs. A
 * layer with no position under the transport has no control under it either.
 */
export function controlIndexAt(rhythm, patternPosition) {
  if (patternPosition === null || patternPosition === undefined) return null;
  return Math.floor(patternPosition / runLength(rhythm));
}

/**
 * The two counts a row layout needs: how many signature units the grid holds,
 * and how many Grid controls sit in each. The second is derived from the run
 * length rather than branched on the mode a second time — a control that runs a
 * whole unit leaves one per unit, and a control that runs one position leaves
 * as many as the Subdivision made.
 */
export function controlCounts(rhythm) {
  return {
    signatureUnits: rhythm.signature.count,
    controlsPerSignatureUnit: rhythm.subdivision / runLength(rhythm),
  };
}
