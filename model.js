export const STEP = Object.freeze({
  OFF: "off",
  TERTIARY: "tertiary",
  SECONDARY: "secondary",
  PRIMARY: "primary",
});

/**
 * Which click a rhythm layer plays. The name is the vocabulary and lives here;
 * what each one is tuned to — frequency, waveform, duration — is `metronome.js`
 * and its `SOUND_PROFILES`, keyed by these values.
 *
 * The split is the same one `STEP` and `STEP_PITCH_RATIOS` make: a name a
 * listener chose and a stored Configuration carries has to survive being read
 * by a module that knows nothing about oscillators.
 */
export const SOUND = Object.freeze({
  HIGH: "high",
  LOW: "low",
  WOOD: "wood",
});

/**
 * A table keyed by a value a caller supplies. The null prototype keeps an
 * inherited name such as `constructor` or `toString` from answering as though
 * it were a mapping this module wrote, and it makes a miss `undefined` rather
 * than a function that survives a truthiness check and turns arithmetic into
 * `NaN` further downstream.
 *
 * Exported because the rule is the vocabulary's, not this module's: any table
 * keyed by a `STEP`, a meter unit, or a subdivision is reached with whatever a
 * caller passes, wherever it lives.
 */
export function lookup(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

/**
 * The shared musical vocabulary. `model.js` is the single definition; every
 * other module imports these rather than restating the literals.
 *
 * Tempo names the shared primary beat rate. Every rhythm layer receives one
 * signature-unit beat per `60 / bpm` seconds; Subdivision alone divides that
 * duration into Pattern positions.
 */
export const METER_COUNT_LIMIT = Object.freeze({ minimum: 1, maximum: 16 });

export const METER_UNITS = Object.freeze([1, 2, 4, 8]);

export const SUBDIVISION_LIMIT = Object.freeze({ minimum: 1, maximum: 5 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The shared numeric guard for values arriving from storage and from form
 * controls. Only a number or a numeric string is a value; everything else is a
 * missing one, because `Number` reads `null`, `""`, and `[]` as zero and a
 * layer that simply had nothing saved for it would come back silent rather
 * than at its default. Callers decide what a missing value means: a Meter
 * count is clamped into range, a Meter denominator is refused outright.
 */
function numericValue(value) {
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  return numeric ? Number(value) : Number.NaN;
}

export function normaliseNumber(value, fallback, min, max) {
  const parsed = numericValue(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

/**
 * A Meter denominator is one of the conventional written units the interface
 * offers. Stored values outside that finite vocabulary fall back rather than
 * being coerced into a different Meter.
 */
export function normaliseMeterUnit(value, fallback = 4) {
  const parsed = numericValue(value);
  return METER_UNITS.includes(parsed) ? parsed : fallback;
}

/**
 * A Cycle span is the least common multiple of its Meter counts. Those counts
 * are whole numbers the count range clamps, so every value and intermediate
 * product here is an exact integer and only the conversion to seconds is a
 * floating-point division. `test/model.test.js` holds the widest span the range
 * permits and the margin it leaves.
 */
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
  const rhythms =
    Array.isArray(cycle?.rhythms) && cycle.rhythms.length
      ? cycle.rhythms
      : [{ signature: { count: 4, unit: 4 } }];
  const spanInBeats = rhythms
    .map((rhythm) =>
      Math.round(
        normaliseNumber(
          rhythm.signature?.count,
          4,
          METER_COUNT_LIMIT.minimum,
          METER_COUNT_LIMIT.maximum,
        ),
      ),
    )
    .reduce(leastCommonMultiple);
  const beatSeconds = 60 / normaliseNumber(bpm, 96, 1, 1000);
  return spanInBeats * beatSeconds;
}

export function stepDurationSeconds(bpm, rhythm) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const subdivision = Math.round(
    normaliseNumber(rhythm?.subdivision, 1, SUBDIVISION_LIMIT.minimum, SUBDIVISION_LIMIT.maximum),
  );
  return 60 / safeBpm / subdivision;
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
 *
 * Every denominator the interface offers has a conventional note-value name, so
 * the fallback is a guard against a caller's mistake rather than a Meter a
 * musician can reach.
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
