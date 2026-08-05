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

/**
 * What each stepped control moves by, and so which values it can hold at all.
 * A `step` reads like a detail of how a slider is drawn, and it is not one:
 * `<input type="range">` runs a value sanitization algorithm that rounds a value
 * off the step onto the nearest value on it — silently, firing no event — so a
 * default that misses the grid leaves the thumb somewhere the application's own
 * readout disagrees with, and the first arrow key from there moves by whatever
 * the mismatch left rather than by the step.
 *
 * That is not hypothetical. A default Level of 0.72 rendered at 0.70 while the
 * readout said 72% and the audio graph played 0.72, and nothing could catch it
 * while the step existed only as a string in the markup with no name for a test
 * to reach for. The grid is domain vocabulary for that reason, and
 * `test/model.test.js` holds every default the application ships against it.
 *
 * `index.html` cannot import, so the tempo slider's `step="5"` is still written
 * there as a literal; the same test reads the shell and holds the two together.
 */
export const TEMPO_STEP = 5;

/** Level and Balance share one grid: a twentieth, five percent of either. */
export const MIX_STEP = 0.05;

export const TEMPO_ENVELOPE_SHAPE = Object.freeze({
  FLAT: "flat",
  UP: "up",
  DOWN: "down",
  PEAK: "peak",
});

export const TEMPO_ENVELOPE_CHANGE_LIMIT = Object.freeze({ minimum: 1, maximum: 120 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createTempoCurve(incomingBpm, envelope, beatLength) {
  const inheritedBpm = clamp(incomingBpm, TEMPO_LIMIT.minimum, TEMPO_LIMIT.maximum);
  const length = Math.max(0, beatLength);
  const shape = envelope?.shape;
  const direction =
    shape === "up" || shape === "peak" || shape === "flat" ? 1 : shape === "down" ? -1 : 0;
  const targetBpm = clamp(
    inheritedBpm + direction * (envelope?.amount || 0),
    TEMPO_LIMIT.minimum,
    TEMPO_LIMIT.maximum,
  );
  const startBpm = shape === "flat" ? targetBpm : inheritedBpm;

  return Object.freeze({ shape, inheritedBpm, startBpm, targetBpm, beatLength: length });
}

export function tempoAtBeat(curve, beat) {
  if (curve.beatLength === 0) return curve.targetBpm;
  let progress = clamp(beat, 0, curve.beatLength) / curve.beatLength;
  if (curve.shape === "peak") progress = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
  return curve.startBpm + (curve.targetBpm - curve.startBpm) * progress;
}

export function secondsAtBeat(curve, beat) {
  const boundedBeat = clamp(beat, 0, curve.beatLength);
  if (curve.shape === "peak") {
    const midpoint = curve.beatLength / 2;
    const rise = createTempoCurve(
      curve.startBpm,
      { shape: "up", amount: curve.targetBpm - curve.startBpm },
      midpoint,
    );
    if (boundedBeat <= midpoint) return secondsAtBeat(rise, boundedBeat);
    const fall = createTempoCurve(
      curve.targetBpm,
      { shape: "down", amount: curve.targetBpm - curve.startBpm },
      midpoint,
    );
    return secondsAtBeat(rise, midpoint) + secondsAtBeat(fall, boundedBeat - midpoint);
  }
  const slope = (curve.targetBpm - curve.startBpm) / curve.beatLength;
  if (!Number.isFinite(slope) || slope === 0) return (60 * boundedBeat) / curve.startBpm;
  return (60 / slope) * Math.log1p((slope * boundedBeat) / curve.startBpm);
}

export function beatAtSeconds(curve, seconds) {
  const duration = secondsAtBeat(curve, curve.beatLength);
  const boundedSeconds = clamp(seconds, 0, duration);
  if (curve.shape === "peak") {
    const midpoint = curve.beatLength / 2;
    const rise = createTempoCurve(
      curve.startBpm,
      { shape: "up", amount: curve.targetBpm - curve.startBpm },
      midpoint,
    );
    const riseDuration = secondsAtBeat(rise, midpoint);
    if (boundedSeconds <= riseDuration) return beatAtSeconds(rise, boundedSeconds);
    const fall = createTempoCurve(
      curve.targetBpm,
      { shape: "down", amount: curve.targetBpm - curve.startBpm },
      midpoint,
    );
    return midpoint + beatAtSeconds(fall, boundedSeconds - riseDuration);
  }
  const slope = (curve.targetBpm - curve.startBpm) / curve.beatLength;
  if (!Number.isFinite(slope) || slope === 0) return (boundedSeconds * curve.startBpm) / 60;
  return (curve.startBpm * Math.expm1((boundedSeconds * slope) / 60)) / slope;
}

export function createSequenceTempoCurves(startingBpm, cycles) {
  let incomingBpm = clamp(startingBpm, TEMPO_LIMIT.minimum, TEMPO_LIMIT.maximum);
  return cycles.map((cycle) => {
    const active = cycle.repetitions > 0;
    const beatLength = active ? cycleSpanBeats(cycle) * cycle.repetitions : 0;
    const curve = createTempoCurve(incomingBpm, active ? cycle.envelope : null, beatLength);
    const outgoingBpm = active
      ? curve.shape === TEMPO_ENVELOPE_SHAPE.PEAK
        ? curve.inheritedBpm
        : curve.targetBpm
      : incomingBpm;
    const description = {
      id: cycle.id,
      active,
      incomingBpm,
      targetBpm: active ? curve.targetBpm : incomingBpm,
      outgoingBpm,
      beatLength,
      curve,
    };
    incomingBpm = outgoingBpm;
    return description;
  });
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

export function cycleSpanBeats(cycle) {
  const rhythms =
    Array.isArray(cycle?.rhythms) && cycle.rhythms.length
      ? cycle.rhythms
      : [{ signature: { count: 4, unit: 4 } }];
  return rhythms
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
}

export function cycleSpanSeconds(bpm, cycle) {
  const beatSeconds = 60 / normaliseNumber(bpm, 120, 1, 1000);
  return cycleSpanBeats(cycle) * beatSeconds;
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
 * The interval the tick row under the tempo slider is drawn at. `app.js` builds
 * the row from this and `TEMPO_LIMIT`, and the row is a scale: major ticks carry
 * their own number, so it is how a reader knows where on the range the thumb is
 * sitting. `TEMPO_STEP` divides this interval and the range spans a whole number
 * of them, so every mark drawn is a tempo the slider can stop on and the first
 * and last sit on the slider's own ends; `test/model.test.js` holds both.
 *
 * The row was once the drawn form of a snap. A drag stopped on these tempos —
 * restoring what a `<datalist>` on the slider had done for free before the
 * slider moved above the row and the browser's own marks started duplicating it
 * — and the two had to be one set of tempos or the snap landed nowhere visible.
 * That snap is gone. Its tolerance was two BPM either side of a mark, which is
 * narrower than the five the slider steps by, so it could not catch a single
 * value the control was able to produce: every tempo it would have moved was
 * already unreachable. What is left is the scale, which is all a reader ever saw.
 */
export const TEMPO_TICK_INTERVAL = 10;

/**
 * How far from the middle a Balance drag is still centred, and the only snap
 * left anywhere in the interface. It is here for the reading rather than for the
 * feel: `panLabel` calls anything inside four percent of the middle "Centre",
 * and a drag that stopped a hundredth or two short left that word over a Balance
 * that was audibly off to one side. Inside the five percent here it cannot —
 * everything the label calls Centre arrives at exactly zero.
 *
 * One `MIX_STEP` wide, which makes the two positions either side of centre the
 * only ones a drag cannot reach. Both stay reachable by arrow key, because only
 * the pointer snaps: a key stepping off centre would be pulled straight back
 * onto it and the slider would be stuck there for good.
 *
 * What this replaced was a table of marks at every quarter, sticky within five
 * percent of each. Sixteen of the forty-one positions the slider steps to were
 * unreachable by drag under it — ±0.20, ±0.30, ±0.45, ±0.55, ±0.70, ±0.80 and
 * ±0.95 as well as ±0.05 — for the sake of marks a stereo placement is only ever
 * described by loosely. Centre is the one a listener asks for exactly.
 *
 * Double-clicking the slider still returns it to centre outright. That serves the
 * pointer that is nowhere near the middle; this serves the one that is.
 */
export const BALANCE_CENTRE_TOLERANCE = 0.05;

/**
 * Centres a Balance a pointer left near the middle, and leaves every other value
 * exactly where the drag put it.
 *
 * Returns a number for anything numeric and the caller's own value untouched for
 * everything else — the slider's string, an empty field, a `null` read back from
 * storage. Repairing those here would decide what an unusable value means in the
 * one place that cannot report it; the Configuration refuses them and says why,
 * which is where every form value already goes.
 *
 * The comparison is made on the value the slider carries rather than on that
 * value scaled into percent, which is what the mark table this replaced had to
 * do. That scaling was where the float dust came from — `0.58 * 100` is
 * `57.99999999999999`, a hundred-billionth outside a tolerance it was meant to
 * be exactly on, and the snap passed over it — and a comparison against a
 * literal the slider's own string parses to has no dust in it to guard against.
 */
export function snapBalance(value) {
  const parsed = numericValue(value);
  if (!Number.isFinite(parsed)) return value;
  // Centre is written as the literal rather than derived, so a Balance
  // approached from the left cannot settle on `-0`: that is the centre by every
  // comparison the application makes and a different value to `Object.is` and to
  // anything that prints it, and it would reach storage, the Preset snapshot and
  // the readout from here.
  return Math.abs(parsed) <= BALANCE_CENTRE_TOLERANCE ? 0 : parsed;
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
