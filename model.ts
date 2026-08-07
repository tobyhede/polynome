export const STEP = Object.freeze({
  OFF: "off",
  TERTIARY: "tertiary",
  SECONDARY: "secondary",
  PRIMARY: "primary",
});

/**
 * Which click a rhythm layer plays. The name is the vocabulary and lives here;
 * what each one is tuned to — frequency, waveform, duration — is `metronome.ts`
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
 * The shared musical vocabulary. `model.ts` is the single definition; every
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
 * `test/model.test.ts` holds every default the application ships against it.
 *
 * `index.html` cannot import, so the tempo slider's `step="5"` is still written
 * there as a literal; the same test reads the shell and holds the two together.
 */
export const TEMPO_STEP = 5;

/** Level and Balance share one grid: a twentieth, five percent of either. */
export const MIX_STEP = 0.05;

/**
 * A Cycle's tempo envelope: a shape and an amount, owned by the Cycle it spans.
 *
 * Flat is a step — the whole Cycle plays at `incoming + amount`, and the change
 * lands on its first beat. The other three are continuous in musical position
 * rather than stepped per repetition, so a repetition count sets the envelope's
 * duration and nothing else: a one-repetition Up ramps across that repetition.
 *
 * Flat 0 is the canonical no-envelope state and the default for a new Cycle.
 * There is no separate off switch, which is why only Flat's range reaches zero
 * and below: a ramp of nothing is a Flat, and the vocabulary says so once here
 * rather than leaving two spellings of the same silence.
 */
export const ENVELOPE = Object.freeze({
  FLAT: "flat",
  UP: "up",
  DOWN: "down",
  PEAK: "peak",
});

/**
 * Reached with a shape a stored Configuration supplies, so it is a `lookup` for
 * the reason that helper exists: `ENVELOPE_LIMIT.toString` on a plain object
 * answers with a function, which survives the truthiness check that decides a
 * shape is known and then destructures to an undefined range. The amount is
 * clamped against that range, and `NaN` is what a Cycle ends up storing.
 */
export const ENVELOPE_LIMIT = lookup({
  flat: Object.freeze({ minimum: -120, maximum: 120 }),
  up: Object.freeze({ minimum: 1, maximum: 120 }),
  down: Object.freeze({ minimum: 1, maximum: 120 }),
  peak: Object.freeze({ minimum: 1, maximum: 120 }),
});

/**
 * What a shape's amount is worth against the incoming tempo. Only Down counts
 * downward: Flat carries its own sign, and Up and Peak are named for the
 * direction they take.
 */
const ENVELOPE_DIRECTION = lookup({ flat: 1, up: 1, down: -1, peak: 1 });

/** The amount a ramp starts at when it is chosen from Flat 0, which has none. */
export const ENVELOPE_DEFAULT_AMOUNT = 20;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampTempo(bpm) {
  return clamp(bpm, TEMPO_LIMIT.minimum, TEMPO_LIMIT.maximum);
}

/**
 * Reads an envelope the way every function below needs it: a shape this module
 * has a direction for and a finite amount. Anything else is Flat 0, so a Cycle
 * carrying nothing and a Cycle carrying a shape nobody wrote both evaluate as
 * the no-envelope state rather than turning the arithmetic into `NaN`.
 */
function readEnvelope(envelope) {
  const shape = ENVELOPE_DIRECTION[envelope?.shape] === undefined ? ENVELOPE.FLAT : envelope.shape;
  const amount = Number(envelope?.amount);
  return { shape, amount: Number.isFinite(amount) ? amount : 0 };
}

/**
 * The tempo the shape reaches — at the Cycle's start for Flat, at its end for
 * Up and Down, at its musical midpoint for Peak.
 *
 * Clamping is per evaluation and never per edit: at incoming 290 an Up 20
 * reaches 300 while the stored amount stays 20, so a Preset carries a relative
 * change rather than baking in the absolute tempo it happened to produce.
 */
export function envelopeTarget(incomingBpm, envelope) {
  const { shape, amount } = readEnvelope(envelope);
  return clampTempo(clampTempo(incomingBpm) + ENVELOPE_DIRECTION[shape] * amount);
}

/**
 * The tempo a fraction `0…1` of the way through the Cycle. Peak is shaped by
 * `1 − |1 − 2·progress|`, which is 0 at both ends and 1 at exactly 0.5, so the
 * target lands on the musical midpoint rather than on a repetition boundary.
 */
export function envelopeTempoAt(incomingBpm, envelope, progress) {
  const { shape } = readEnvelope(envelope);
  const target = envelopeTarget(incomingBpm, envelope);
  if (shape === ENVELOPE.FLAT) return target;
  const startBpm = clampTempo(incomingBpm);
  const bounded = clamp(progress, 0, 1);
  const fraction = shape === ENVELOPE.PEAK ? 1 - Math.abs(1 - 2 * bounded) : bounded;
  return startBpm + (target - startBpm) * fraction;
}

/**
 * What the Cycle hands to the next one. Peak returns to where it started, so it
 * passes its incoming tempo through; every other shape ends on its target.
 */
export function outgoingTempo(incomingBpm, envelope) {
  const { shape } = readEnvelope(envelope);
  return shape === ENVELOPE.PEAK ? clampTempo(incomingBpm) : envelopeTarget(incomingBpm, envelope);
}

/**
 * The amount an envelope keeps when its shape changes. The magnitude always
 * survives, because the amount is the thing the listener chose and the shape is
 * how it is spent: only the sign is the shape's to decide, and only Flat has
 * one to carry. A Flat at rest has no magnitude to survive, so a ramp chosen
 * from it starts at the default rather than at a zero no ramp can hold.
 */
export function convertedEnvelopeAmount(envelope, shape) {
  const current = readEnvelope(envelope);
  if (shape === current.shape) return current.amount;
  if (shape === ENVELOPE.FLAT) {
    return current.shape === ENVELOPE.DOWN ? -current.amount : current.amount;
  }
  if (current.shape !== ENVELOPE.FLAT) return current.amount;
  return current.amount === 0 ? ENVELOPE_DEFAULT_AMOUNT : Math.abs(current.amount);
}

/**
 * The scheduler's form of an envelope: the two tempos a Cycle interpolates
 * between and the musical length it takes to do it. Flat starts where it ends,
 * which is what makes it a step — every function below reads one pair of tempos
 * and a length, and none of them needs to know which shape produced them.
 */
export function createTempoCurve(incomingBpm, envelope, beatLength) {
  const inheritedBpm = clampTempo(incomingBpm);
  const { shape } = readEnvelope(envelope);
  const targetBpm = envelopeTarget(inheritedBpm, envelope);
  const startBpm = shape === ENVELOPE.FLAT ? targetBpm : inheritedBpm;
  const boundedBeatLength = Math.max(0, beatLength);
  const curve = {
    shape,
    inheritedBpm,
    startBpm,
    targetBpm,
    beatLength: boundedBeatLength,
  };

  if (shape === ENVELOPE.PEAK) {
    // These immutable halves are part of the curve rather than scratch values
    // created by every scheduler-side conversion. The gain is avoiding garbage
    // on the scheduler's thread; the timing arithmetic is already inexpensive.
    const midpoint = boundedBeatLength / 2;
    const amount = targetBpm - startBpm;
    return Object.freeze({
      ...curve,
      rise: createTempoCurve(startBpm, { shape: ENVELOPE.UP, amount }, midpoint),
      fall: createTempoCurve(targetBpm, { shape: ENVELOPE.DOWN, amount }, midpoint),
    });
  }

  return Object.freeze(curve);
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
    const { rise, fall } = curve;
    if (boundedBeat <= midpoint) return secondsAtBeat(rise, boundedBeat);
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
    const { rise, fall } = curve;
    const riseDuration = secondsAtBeat(rise, midpoint);
    if (boundedSeconds <= riseDuration) return beatAtSeconds(rise, boundedSeconds);
    return midpoint + beatAtSeconds(fall, boundedSeconds - riseDuration);
  }
  const slope = (curve.targetBpm - curve.startBpm) / curve.beatLength;
  if (!Number.isFinite(slope) || slope === 0) return (boundedSeconds * curve.startBpm) / 60;
  return (curve.startBpm * Math.expm1((boundedSeconds * slope) / 60)) / slope;
}

/**
 * A Cycle's incoming tempo is the starting BPM folded through every preceding
 * *active* Cycle, so editing an earlier envelope moves the tempo every later
 * one is read against. An inactive Cycle has no tempo effect and passes its
 * incoming tempo through untouched, while keeping the envelope it was given.
 */
export function createSequenceTempoCurves(startingBpm, cycles) {
  let incomingBpm = clampTempo(startingBpm);
  return cycles.map((cycle) => {
    const active = cycle.repetitions > 0;
    const beatLength = active ? cycleSpanBeats(cycle) * cycle.repetitions : 0;
    const curve = createTempoCurve(incomingBpm, active ? cycle.envelope : null, beatLength);
    const outgoingBpm = active ? outgoingTempo(incomingBpm, cycle.envelope) : incomingBpm;
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
 * A Cycle span is the least common multiple of its Meter counts. The counts
 * used here are whole numbers the count range clamps, so every value and
 * intermediate product is an exact integer and only the conversion to seconds
 * is a floating-point division. `test/model.test.ts` holds the widest span the
 * range permits and the margin it leaves.
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
 * The interval the tick row under the tempo slider is drawn at. `app.ts` builds
 * the row from this and `TEMPO_LIMIT`, and the row is a scale: major ticks carry
 * their own number, so it is how a reader knows where on the range the thumb is
 * sitting. `TEMPO_STEP` divides this interval and the range spans a whole number
 * of them, so every mark drawn is a tempo the slider can stop on and the first
 * and last sit on the slider's own ends; `test/model.test.ts` holds both.
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
