export const STEP = Object.freeze({
  OFF: "off",
  QUARTER: "quarter",
  HALF: "half",
  FULL: "full",
});

/**
 * Every lookup below is keyed by a value a caller supplies, so a null prototype
 * keeps an inherited name such as `constructor` or `toString` from answering as
 * though it were a mapping this module wrote.
 */
function lookup(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

const STEP_LEVELS = lookup({
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

export const SUBDIVISION_LIMIT = Object.freeze({ minimum: 1, maximum: 5 });

export function stepLevel(step) {
  return STEP_LEVELS[step] ?? 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The shared numeric guard for values arriving from storage and from form
 * controls. Only a number or a numeric string is a value; everything else is a
 * missing one, because `Number` reads `null`, `""`, and `[]` as zero and a
 * layer that simply had nothing saved for it would come back silent rather
 * than at its default.
 */
export function normaliseNumber(value, fallback, min, max) {
  const numeric = typeof value === "number"
    || (typeof value === "string" && value.trim() !== "");
  const parsed = numeric ? Number(value) : Number.NaN;
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
  const subdivision = Math.round(normaliseNumber(
    rhythm?.subdivision,
    1,
    SUBDIVISION_LIMIT.minimum,
    SUBDIVISION_LIMIT.maximum,
  ));
  return (60 / safeBpm) * (4 / unit) / subdivision;
}

const UNIT_NAMES = lookup({
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "sixteenth",
  32: "thirty-second",
});

const SUBDIVISION_HINTS = lookup({
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
