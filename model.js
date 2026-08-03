export const STEP = Object.freeze({
  OFF: "off",
  QUARTER: "quarter",
  HALF: "half",
  FULL: "full",
});

const STEP_LEVELS = Object.freeze({
  [STEP.OFF]: 0,
  [STEP.QUARTER]: 0.25,
  [STEP.HALF]: 0.5,
  [STEP.FULL]: 1,
});

/**
 * The shared musical vocabulary. `model.js` is the single definition; every
 * other module imports these rather than restating the literals.
 *
 * Tempo is always interpreted as quarter-note BPM, so `60 / bpm` is a quarter
 * note in seconds throughout this module regardless of any meter's unit.
 */
export const NOTE_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);

export const METER_COUNT_LIMIT = Object.freeze({ minimum: 1, maximum: 32 });

export function stepLevel(step) {
  return STEP_LEVELS[step] ?? 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normaliseNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function normaliseUnit(value, fallback = 4) {
  const parsed = Number(value);
  return NOTE_UNITS.includes(parsed) ? parsed : fallback;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function leastCommonMultiple(left, right) {
  return Math.abs(left * right) / greatestCommonDivisor(left, right);
}

export function cycleSpanSeconds(bpm, cycle) {
  const rhythms = Array.isArray(cycle?.rhythms) && cycle.rhythms.length
    ? cycle.rhythms
    : [{ signature: { count: 4, unit: 4 } }];
  const spanInThirtySecondNotes = rhythms
    .map((rhythm) => {
      const count = Math.round(normaliseNumber(
        rhythm.signature?.count,
        4,
        METER_COUNT_LIMIT.minimum,
        METER_COUNT_LIMIT.maximum,
      ));
      const unit = normaliseUnit(rhythm.signature?.unit, 4);
      return count * (32 / unit);
    })
    .reduce(leastCommonMultiple);
  const quarterSeconds = 60 / normaliseNumber(bpm, 96, 1, 1000);
  return spanInThirtySecondNotes * quarterSeconds / 8;
}

export function stepDurationSeconds(bpm, rhythm) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const unit = normaliseUnit(rhythm?.signature?.unit, 4);
  const subdivision = Math.round(
    normaliseNumber(rhythm?.subdivision, 1, 1, 5),
  );
  return (60 / safeBpm) * (4 / unit) / subdivision;
}

const UNIT_NAMES = Object.freeze({
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "sixteenth",
  32: "thirty-second",
});

const SUBDIVISION_HINTS = Object.freeze({
  1: "straight",
  2: "duple",
  3: "triplet",
  4: "even four",
  5: "quintuplet",
});

/**
 * Names a Subdivision for accessible names and tooltips. Both maps are keyed
 * by values the caller supplies, so each side falls back to a readable phrase
 * rather than letting an unmapped value surface as "undefined".
 */
export function subdivisionLabel(subdivision, unit) {
  const unitName = UNIT_NAMES[unit] || "signature";
  const hint = SUBDIVISION_HINTS[subdivision] || `${subdivision}-tuplet`;
  return `${subdivision} per ${unitName} unit · ${hint}`;
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
