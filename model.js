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

export const TEMPO_LIMIT = Object.freeze({ minimum: 30, maximum: 300 });

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
  const beatSeconds = 60 / normaliseNumber(bpm, 120, 1, 1000);
  return spanInBeats * beatSeconds;
}

export function stepDurationSeconds(bpm, rhythm) {
  const safeBpm = normaliseNumber(bpm, 120, 1, 1000);
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

/**
 * The tempo marks a drag stops on. A drag that lands within `tolerance` of a
 * mark takes the mark exactly, so the round tempos musicians actually name are
 * the easy ones to hit. `app.js` draws the tick row from this interval and
 * `TEMPO_LIMIT` rather than from its own tenth, because the marks a reader aims
 * at and the marks a drag stops on are one set or the snap lands nowhere
 * visible. Both ends of the range are marks themselves, which is what keeps the
 * tolerance from pulling a tempo past a bound; `test/model.test.js` holds that.
 *
 * This restores what the browser used to do for free: a `<datalist>` on the
 * slider snapped the thumb to its ticks, and it was dropped when the slider
 * moved above `.bpm-ticks`, where the browser's own marks duplicated the row.
 * The behaviour was the datalist's, not the tick row's, so drawing the marks
 * ourselves did not carry it over.
 *
 * The tolerance leaves each mark's neighbours ±1 and ±2 unreachable by drag.
 * They are reachable by typing and by the arrow keys, which is why only a
 * pointer drag snaps: a keyboard step of one from a mark would be pulled
 * straight back to it, and the slider would never move at all.
 */
export const TEMPO_SNAP = Object.freeze({ interval: 10, tolerance: 2, scale: 1 });

/**
 * The Level marks, counted in the percent its own readout speaks rather than in
 * the 0-to-1 the slider carries. Every ten percent, with the tolerance the tempo
 * uses in its units — so the two controls are sticky to the same degree, a fifth
 * of the gap on either side of every mark, and a reader who has learned one has
 * learned the other.
 *
 * `scale` is what those units cost: the marks are whole percent while the value
 * is a fraction, so the arithmetic below counts in percent and divides once at
 * the end. Rounding `0.3` out of `Math.round(0.3 / 0.1) * 0.1` gives
 * `0.30000000000000004`, and a Level carrying that reads as a Configuration
 * that has moved from the Preset holding `0.3` — an unsaved change nobody made,
 * offered by a control that only looks like it landed on a mark.
 */
export const LEVEL_SNAP = Object.freeze({ interval: 10, tolerance: 2, scale: 100 });

/**
 * The Balance marks: hard left, half left, centre, half right, hard right. A
 * quarter is the coarsest interval that still holds the position a stereo
 * placement is usually described by, and centre is the one that has to be
 * exactly reachable — `panLabel` already calls anything inside four percent
 * "Centre", which was a reading a drag could not make true. Inside the five
 * percent here it now is: a dragged Balance that reads Centre is centred.
 *
 * Double-clicking the slider still returns it to centre outright. That serves
 * the pointer that is nowhere near the middle; this serves the one that is.
 */
export const BALANCE_SNAP = Object.freeze({ interval: 25, tolerance: 5, scale: 100 });

/**
 * Returns a number for anything numeric and the caller's own value untouched
 * for everything else — the slider's string, an empty field, a `null` read back
 * from storage. Repairing those here would decide what an unusable value means
 * in the one place that cannot report it; the Configuration refuses them and
 * says why, which is where every form value already goes.
 */
export function snapToMark(value, { interval, tolerance, scale }) {
  const parsed = numericValue(value);
  if (!Number.isFinite(parsed)) return value;
  const counted = parsed * scale;
  const mark = Math.round(counted / interval) * interval;
  // The count is a product, so a value sitting exactly on the tolerance can
  // arrive a hair outside it: `0.58 * 100` is `57.99999999999999`, which stands
  // two and a hundred-billionth from the mark at sixty rather than the two that
  // mark is meant to catch, and the slider passes over it without stopping. The
  // margin below is orders beneath the hundredth these controls can hold and the
  // one bpm the tempo can, so it separates dust from a value genuinely outside
  // the tolerance rather than widening the tolerance.
  if (Math.abs(counted - mark) > tolerance + 1e-9) return parsed;
  // A Balance approached from the left rounds to `-0`, which is the centre by
  // every comparison the application makes and a different value to `Object.is`
  // and to anything that prints it. It reaches storage, the Preset snapshot and
  // the readout, so it is worth the one line here rather than a footnote in each
  // of them.
  const snapped = mark / scale;
  return snapped === 0 ? 0 : snapped;
}

export function snapTempo(value) {
  return snapToMark(value, TEMPO_SNAP);
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
