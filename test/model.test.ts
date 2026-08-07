import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  METER_COUNT_LIMIT,
  METER_UNITS,
  MIX_STEP,
  SOUND,
  STEP,
  TEMPO_LIMIT,
  TEMPO_STEP,
  TEMPO_TICK_INTERVAL,
  beatAtSeconds,
  convertedEnvelopeAmount,
  createSequenceTempoCurves,
  createTempoCurve,
  cycleSpanBeats,
  cycleSpanSeconds,
  envelopeTarget,
  envelopeTempoAt,
  outgoingTempo,
  panLabel,
  secondsAtBeat,
  snapBalance,
  subdivisionLabel,
  tempoAtBeat,
} from "../model.ts";
import {
  changeConfiguration,
  createConfiguration,
  createStoredPresets,
  describeConfiguration,
} from "../configuration.ts";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("an Up envelope is linear in musical progress and has an exact time mapping", () => {
  const curve = createTempoCurve(60, { shape: "up", amount: 60 }, 4);

  assert.equal(tempoAtBeat(curve, 0), 60);
  assert.equal(tempoAtBeat(curve, 2), 90);
  assert.equal(tempoAtBeat(curve, 4), 120);
  closeTo(secondsAtBeat(curve, 2), 1.6218604324326575);
  closeTo(secondsAtBeat(curve, 4), 2.772588722239781);
  closeTo(beatAtSeconds(curve, 1.6218604324326575), 2);
});

test("a Down envelope is linear in musical progress and has an exact inverse", () => {
  const curve = createTempoCurve(120, { shape: "down", amount: 60 }, 4);

  assert.equal(tempoAtBeat(curve, 2), 90);
  assert.equal(tempoAtBeat(curve, 4), 60);
  closeTo(secondsAtBeat(curve, 2), 1.1507282898071236);
  closeTo(secondsAtBeat(curve, 4), 2.772588722239781);
  closeTo(beatAtSeconds(curve, 1.1507282898071236), 2);
});

test("a Peak envelope reaches its target at the midpoint and returns", () => {
  const curve = createTempoCurve(60, { shape: "peak", amount: 60 }, 4);

  assert.equal(tempoAtBeat(curve, 0), 60);
  assert.equal(tempoAtBeat(curve, 2), 120);
  assert.equal(tempoAtBeat(curve, 4), 60);
  closeTo(secondsAtBeat(curve, 2), 1.3862943611198906);
  closeTo(secondsAtBeat(curve, 4), 2.772588722239781);
  closeTo(beatAtSeconds(curve, 1.3862943611198906), 2);
});

test("a Flat envelope applies its signed change at the Cycle boundary and holds", () => {
  const curve = createTempoCurve(100, { shape: "flat", amount: -30 }, 4);

  assert.equal(tempoAtBeat(curve, 0), 70);
  assert.equal(tempoAtBeat(curve, 4), 70);
  closeTo(secondsAtBeat(curve, 4), 24 / 7);
  closeTo(beatAtSeconds(curve, 12 / 7), 2);
});

test("active Cycles inherit audible endpoints while inactive Cycles are skipped", () => {
  const cycles = createSequenceTempoCurves(100, [
    { id: "inactive", envelope: { shape: "flat", amount: 50 }, repetitions: 0, rhythms: [{}] },
    {
      id: "up",
      envelope: { shape: "up", amount: 50 },
      repetitions: 1,
      rhythms: [{ signature: { count: 1 } }],
    },
    {
      id: "peak",
      envelope: { shape: "peak", amount: 40 },
      repetitions: 2,
      rhythms: [{ signature: { count: 1 } }],
    },
    {
      id: "flat",
      envelope: { shape: "flat", amount: -120 },
      repetitions: 1,
      rhythms: [{ signature: { count: 1 } }],
    },
  ]);

  assert.deepEqual(
    cycles.map(({ id, active, incomingBpm, targetBpm, outgoingBpm, beatLength }) => ({
      id,
      active,
      incomingBpm,
      targetBpm,
      outgoingBpm,
      beatLength,
    })),
    [
      {
        id: "inactive",
        active: false,
        incomingBpm: 100,
        targetBpm: 100,
        outgoingBpm: 100,
        beatLength: 0,
      },
      { id: "up", active: true, incomingBpm: 100, targetBpm: 150, outgoingBpm: 150, beatLength: 1 },
      {
        id: "peak",
        active: true,
        incomingBpm: 150,
        targetBpm: 190,
        outgoingBpm: 150,
        beatLength: 2,
      },
      { id: "flat", active: true, incomingBpm: 150, targetBpm: 30, outgoingBpm: 30, beatLength: 1 },
    ],
  );
});

test("each envelope shape reaches its own target and hands on its own tempo", () => {
  const shapes = [
    { envelope: { shape: "flat", amount: 20 }, target: 120, outgoing: 120 },
    { envelope: { shape: "flat", amount: -20 }, target: 80, outgoing: 80 },
    { envelope: { shape: "flat", amount: 0 }, target: 100, outgoing: 100 },
    { envelope: { shape: "up", amount: 20 }, target: 120, outgoing: 120 },
    { envelope: { shape: "down", amount: 20 }, target: 80, outgoing: 80 },
    { envelope: { shape: "peak", amount: 20 }, target: 120, outgoing: 100 },
  ];

  for (const { envelope, target, outgoing } of shapes) {
    assert.equal(envelopeTarget(100, envelope), target, `${envelope.shape} target`);
    assert.equal(outgoingTempo(100, envelope), outgoing, `${envelope.shape} outgoing`);
  }
});

/**
 * Flat holds its target for the whole Cycle because it is a step; the ramps
 * spend the Cycle arriving at theirs. Peak is 0 at both ends and 1 at exactly
 * one half, which is what puts its target on the musical midpoint.
 */
test("envelope tempo at a progress fraction distinguishes a step from a ramp", () => {
  const flat = { shape: "flat", amount: 20 };
  const up = { shape: "up", amount: 20 };
  const peak = { shape: "peak", amount: 20 };

  assert.deepEqual(
    [0, 0.25, 0.5, 1].map((progress) => envelopeTempoAt(100, flat, progress)),
    [120, 120, 120, 120],
  );
  assert.deepEqual(
    [0, 0.25, 0.5, 1].map((progress) => envelopeTempoAt(100, up, progress)),
    [100, 105, 110, 120],
  );
  assert.deepEqual(
    [0, 0.25, 0.5, 0.75, 1].map((progress) => envelopeTempoAt(100, peak, progress)),
    [100, 110, 120, 110, 100],
  );
});

/**
 * The magnitude survives every shape change, in both directions. Down and Flat
 * are the pair that has to round-trip, because only one of them carries a sign
 * and the other spends it on its name.
 */
test("a change of envelope shape carries the magnitude across", () => {
  const cases: [envelope: { shape: string; amount: number }, shape: string, expected: number][] = [
    [{ shape: "flat", amount: 0 }, "up", 20],
    [{ shape: "flat", amount: 0 }, "peak", 20],
    [{ shape: "flat", amount: -35 }, "up", 35],
    [{ shape: "flat", amount: 35 }, "down", 35],
    [{ shape: "up", amount: 40 }, "flat", 40],
    [{ shape: "down", amount: 20 }, "flat", -20],
    [{ shape: "flat", amount: -20 }, "down", 20],
    [{ shape: "peak", amount: 40 }, "flat", 40],
    [{ shape: "up", amount: 40 }, "down", 40],
    [{ shape: "down", amount: 40 }, "peak", 40],
    [{ shape: "peak", amount: 40 }, "up", 40],
    [{ shape: "up", amount: 40 }, "up", 40],
  ];

  for (const [envelope, shape, expected] of cases) {
    assert.equal(
      convertedEnvelopeAmount(envelope, shape),
      expected,
      `${envelope.shape} ${envelope.amount} to ${shape}`,
    );
  }
});

/**
 * A repetition count sets the envelope's musical duration and nothing else, so
 * the target lands at the end of the last repetition rather than at the start of
 * it, and every repetition before that is still on the way there.
 */
test("a ramp reaches its target at the end of the final repetition", () => {
  const curve = createTempoCurve(100, { shape: "up", amount: 20 }, 16);

  assert.deepEqual(
    [0, 4, 8, 12, 16].map((beat) => tempoAtBeat(curve, beat)),
    [100, 105, 110, 115, 120],
  );
});

/**
 * The midpoint is musical, not structural: at three repetitions it falls halfway
 * through the second one, where no repetition boundary is.
 */
test("a Peak over an odd repetition count turns at the musical midpoint", () => {
  const curve = createTempoCurve(100, { shape: "peak", amount: 20 }, 12);

  assert.equal(tempoAtBeat(curve, 6), 120);
  // Exactly symmetric in arithmetic, a bit apart in binary: the two halves are
  // shaped by `progress * 2` and `(1 - progress) * 2`, which are different
  // roundings of the same fraction.
  closeTo(tempoAtBeat(curve, 4), tempoAtBeat(curve, 8));
  assert.ok(tempoAtBeat(curve, 4) < 120);
  closeTo(secondsAtBeat(curve, 6), secondsAtBeat(curve, 12) / 2);
});

test("a clamped target is spread across the whole continuous envelope", () => {
  const up = createTempoCurve(290, { shape: "up", amount: 120 }, 4);
  const down = createTempoCurve(35, { shape: "down", amount: 120 }, 4);

  assert.equal(tempoAtBeat(up, 2), 295);
  assert.equal(tempoAtBeat(up, 4), 300);
  assert.equal(tempoAtBeat(down, 2), 32.5);
  assert.equal(tempoAtBeat(down, 4), 30);
});

test("a Cycle span completes every contained Meter and ignores Subdivision", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 4 }, subdivision: 5 },
      { signature: { count: 3, unit: 4 }, subdivision: 2 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 6);
  assert.equal(cycleSpanBeats(cycle), 12);
});

test("a Cycle span falls back to 120 BPM when tempo is missing or invalid", () => {
  const cycle = { rhythms: [{ signature: { count: 4, unit: 4 }, subdivision: 1 }] };

  assert.equal(cycleSpanSeconds(undefined, cycle), 2);
  assert.equal(cycleSpanSeconds("not a tempo", cycle), 2);
});

test("Meter count clamps to one shared maximum in Configuration and timing", () => {
  const excessive = { signature: { count: METER_COUNT_LIMIT.maximum + 1, unit: 4 } };
  const configuration = createConfiguration({
    sequence: { cycles: [{ rhythms: [excessive] }] },
  });
  const repaired = configuration.sequence.cycles[0].rhythms[0];

  assert.equal(repaired.signature.count, METER_COUNT_LIMIT.maximum);
  closeTo(
    cycleSpanSeconds(120, { rhythms: [excessive] }),
    cycleSpanSeconds(120, { rhythms: [repaired] }),
  );
});

test("the shared vocabulary has one definition", () => {
  assert.deepEqual(Object.values(STEP), ["off", "tertiary", "secondary", "primary"]);
  assert.deepEqual(Object.values(SOUND), ["high", "low", "wood"]);
  assert.deepEqual(METER_COUNT_LIMIT, { minimum: 1, maximum: 16 });
  assert.ok(Object.isFrozen(METER_COUNT_LIMIT));
  assert.deepEqual(METER_UNITS, [1, 2, 4, 8]);
  assert.ok(Object.isFrozen(METER_UNITS));
  assert.ok(Object.isFrozen(SOUND));
});

test("Subdivision labels name the signature unit and the grouping", () => {
  assert.equal(subdivisionLabel(3, 4), "3 per quarter unit · triplet");
  assert.equal(subdivisionLabel(1, 8), "1 per eighth unit · straight");
});

/**
 * `subdivisionLabel` maps each Subdivision to a musician's name for the
 * grouping. The map and the Subdivision choices live in different modules, so
 * an unmapped value must degrade to a readable label rather than reaching the
 * accessible name as "undefined".
 */
test("Subdivision labels fall back for values outside the named vocabulary", () => {
  assert.equal(subdivisionLabel(7, 4), "7 per quarter unit · 7-tuplet");
  assert.equal(subdivisionLabel(1, undefined), "1 per signature unit · straight");
  assert.equal(subdivisionLabel(1, 2.5), "1 per signature unit · straight");
});

/**
 * Repair settles a stored denominator into `METER_UNITS` before any label is
 * built, so a unit outside that vocabulary reaches here only through a caller's
 * mistake. It degrades to the generic signature unit rather than inventing a
 * written fraction for a Meter the interface cannot produce.
 */
test("Subdivision labels degrade for units the interface cannot produce", () => {
  assert.equal(subdivisionLabel(2, 3), "2 per signature unit · duple");
  assert.equal(subdivisionLabel(1, 5), "1 per signature unit · straight");
});

test("every Subdivision over every offered Meter denominator is named", () => {
  const { subdivisions, meterUnits } = describeConfiguration(createConfiguration()).choices;

  assert.ok(subdivisions.length, "Expected Configuration to offer Subdivisions");
  for (const subdivision of subdivisions) {
    for (const unit of meterUnits) {
      const label = subdivisionLabel(subdivision, unit);
      assert.ok(
        !label.includes("undefined"),
        `Subdivision ${subdivision} over unit ${unit} labels as "${label}"`,
      );
      assert.ok(!label.includes("signature unit"));
    }
  }
});

test("a Cycle span completes every beat count regardless of Meter denominator", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 8 }, subdivision: 5 },
      { signature: { count: 3, unit: 4 }, subdivision: 2 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 6);
});

test("a Polyrhythm Cycle spans one Meter of its first Rhythm layer", () => {
  const cycle = {
    timingMode: "polyrhythm",
    rhythms: [
      { signature: { count: 4, unit: 4 }, subdivision: 1 },
      { signature: { count: 3, unit: 8 }, subdivision: 5 },
    ],
  };

  assert.equal(cycleSpanBeats(cycle), 4);
  assert.equal(cycleSpanSeconds(120, cycle), 2);
});

test("a lone Meter spans its numerator in primary beats", () => {
  const cycle = { rhythms: [{ signature: { count: 4, unit: 8 }, subdivision: 1 }] };

  closeTo(cycleSpanSeconds(120, cycle), 2);
});

/**
 * The widest span the Meter count range permits, and so where this
 * calculation's exactness has to hold: sixteen layers counting 1 through 16
 * return to a shared downbeat after `lcm(1…16) = 720720` primary beats. The
 * largest intermediate product the reduction forms is `360360 × 16`, nine
 * orders of magnitude inside `Number.MAX_SAFE_INTEGER`, so the whole beat
 * count is exact in ordinary integer arithmetic and only the final conversion
 * to seconds is a floating-point division.
 */
test("the widest Cycle span the Meter count range permits stays exact", () => {
  const cycle = {
    rhythms: Array.from({ length: METER_COUNT_LIMIT.maximum }, (_, index) => ({
      signature: { count: index + 1, unit: 4 },
      subdivision: 1,
    })),
  };

  assert.equal(cycleSpanSeconds(60, cycle), 720720);
});

test("changing only a Meter denominator does not change its Cycle span", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 1 }, subdivision: 1 },
      { signature: { count: 4, unit: 8 }, subdivision: 1 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 2);
});

/** Every Rhythm layer in a Configuration, which is where a mix value lives. */
const rhythmsOf = (configuration) =>
  configuration.sequence.cycles.flatMap((cycle) => cycle.rhythms);

/**
 * Each stepped control's grid, described in the smallest unit its values are
 * written in: whole bpm for the tempo, hundredths for the two mix sliders. The
 * bounds are the `min` the control carries, because that is what the standard's
 * stepping counts from; each control's own copy of its grid is asserted below —
 * the tempo's from the shell, the two mix sliders' from the `app.ts` template
 * that renders them, named here by the `data-field` that finds them there.
 */
const STEPPED_CONTROLS = [
  {
    name: "the tempo slider",
    unit: 1,
    minimum: TEMPO_LIMIT.minimum,
    step: TEMPO_STEP,
    values: (configuration) => [configuration.bpm],
  },
  {
    name: "the Level slider",
    field: "volume",
    unit: 100,
    minimum: 0,
    step: MIX_STEP,
    values: (configuration) => rhythmsOf(configuration).map((rhythm) => rhythm.volume),
  },
  {
    name: "the Balance slider",
    field: "pan",
    unit: 100,
    minimum: -1,
    step: MIX_STEP,
    values: (configuration) => rhythmsOf(configuration).map((rhythm) => rhythm.pan),
  },
];

/**
 * A value counted in its control's unit, as an integer. Every comparison below
 * is made on these counts and never leaves the integers, because this is exactly
 * the question floating point cannot answer: `0.72 / 0.05` is
 * `14.399999999999999` and is genuinely off a five-hundredth grid, while
 * `0.7 / 0.05` is `13.999999999999998` and is not, and a test that cannot tell
 * those two apart is a test of its own arithmetic.
 *
 * The rounding is not a tolerance. It undoes the dust a product leaves — `0.05`
 * times a hundred is `5.000000000000001` — and the assertion beside it holds the
 * count to being the value exactly, so a default finer than the unit its control
 * counts in is reported rather than rounded into a pass.
 */
function inUnits(value, unit, description) {
  const count = Math.round(value * unit);
  assert.equal(
    count / unit,
    value,
    `${description} is ${value}, which is finer than the unit its control counts in`,
  );
  return count;
}

/**
 * Every default the application can put into a stepped control has to be a value
 * that control can hold. `<input type="range">` sanitises a value off its step
 * onto the nearest value on it — silently, firing no event — so a default that
 * misses the grid is a thumb sitting where the readout beside it disagrees, an
 * audio graph playing a third value, and a first arrow key that moves by the
 * mismatch instead of by the step. Nothing downstream can notice, because
 * nothing downstream is told.
 *
 * The defaults are enumerated rather than listed. `createConfiguration()` is
 * what a first run holds and `createStoredPresets(null)` is what a first run
 * writes into storage, so a new seed Preset, another Rhythm layer inside one, or
 * a moved default joins this check by existing rather than by being remembered.
 *
 * A Rhythm layer added during a session is enumerated too, and it has to be
 * added by the edit rather than assumed to match: its Level and Balance are a
 * separate call to the same builder, reached only through `add-rhythm`, and they
 * arrive in front of a listener on the same two sliders. A layer given its own
 * defaults there would sit off the grid with nothing else in the suite looking.
 */
test("every default the application ships sits on its control's grid", () => {
  const fresh = createConfiguration();
  const grown = changeConfiguration(fresh, {
    type: "add-rhythm",
    cycleId: fresh.sequence.cycles[0].id,
  }).configuration;
  // The added layer is the whole point of this source, and an `add-rhythm` that
  // was refused would leave a Configuration identical to the one above — a check
  // that still passes while testing nothing, which is the failure this file
  // exists to catch.
  assert.equal(
    rhythmsOf(grown).length,
    rhythmsOf(fresh).length + 1,
    "Expected `add-rhythm` to have added the Rhythm layer this checks the defaults of",
  );

  const shipped = [
    { source: "the default Configuration", configuration: fresh },
    { source: "a Rhythm layer added to a Cycle", configuration: grown },
    ...createStoredPresets(null).map((preset) => ({
      source: `the ${preset.name} Preset`,
      configuration: preset.configuration,
    })),
  ];
  assert.ok(shipped.length > 2, "Expected the seed Presets to be among the defaults checked");

  const offGrid = [];
  for (const { source, configuration } of shipped) {
    for (const control of STEPPED_CONTROLS) {
      const step = inUnits(control.step, control.unit, `${control.name}'s step`);
      const minimum = inUnits(control.minimum, control.unit, `${control.name}'s minimum`);
      const values = control.values(configuration);
      assert.ok(values.length, `Expected ${source} to carry a value for ${control.name}`);
      for (const value of values) {
        const counted = inUnits(value, control.unit, `${source}'s value for ${control.name}`);
        if ((counted - minimum) % step !== 0) {
          offGrid.push(
            `${source} carries ${value} for ${control.name}, which steps by ${control.step} from ${control.minimum}`,
          );
        }
      }
    }
  }

  assert.deepEqual(offGrid, []);
});

/**
 * The tempo slider lives in the static shell, which has no way to import, so its
 * grid is written there as string literals and this is the only thing holding
 * them to the constants the rest of the application steps by. Both attributes
 * are the grid: the step is what the thumb moves by, and the standard counts
 * those steps from the minimum, so a shell that disagreed about either would put
 * the slider on a different set of tempos than the check above tests defaults
 * against. The maximum is the range's other end rather than part of the grid,
 * and `e2e/polynome.spec.ts` holds both bounds against `TEMPO_LIMIT` from the
 * rendered control.
 */
test("the shell's tempo slider carries the grid the model names", async () => {
  const shell = await readFile(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const slider = shell.match(/<input[^>]*id="bpm-slider"[^>]*>/);

  assert.ok(slider, "Expected the shell to hold a tempo slider");
  assert.match(slider[0], new RegExp(`\\sstep="${TEMPO_STEP}"`));
  assert.match(slider[0], new RegExp(`\\smin="${TEMPO_LIMIT.minimum}"`));
});

/**
 * The other two stepped controls are rendered by `app.ts`, so their grid is
 * written there and the check above measures every default against the copy of
 * it in `STEPPED_CONTROLS`. Nothing else holds those two copies together.
 *
 * Both halves are the grid. The step is what the thumb moves by, and it has to
 * be `MIX_STEP` itself rather than the number `MIX_STEP` currently holds — a
 * literal is a second answer to which values these sliders can hold, and it can
 * drift from the constant that names the grid without either one looking wrong
 * where it is written. The `min` is what the standard counts those steps from,
 * and it is the control's own end rather than anything the model names, so a
 * `min` moved here would shift every value the slider can reach while the check
 * above went on measuring from where it used to be — and the values it measures
 * would all still pass.
 *
 * Read as text because `app.ts` reaches for the document as it loads, which is
 * the same reason the shell above is.
 */
test("the grid the rendered mix sliders carry is the one the model names", async () => {
  const source = await readFile(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf8");
  const rendered = STEPPED_CONTROLS.filter(({ field }) => field);

  assert.equal(rendered.length, 2, "Expected the Level and the Balance to be rendered by app.ts");
  for (const control of rendered) {
    const slider = source.match(new RegExp(`<input[^>]*data-field="${control.field}"[^>]*>`));

    assert.ok(slider, `Expected app.ts to render ${control.name}`);
    assert.match(
      slider[0],
      /\sstep=\$\{String\(MIX_STEP\)\}/,
      `${control.name} writes its own step instead of taking MIX_STEP`,
    );
    assert.match(
      slider[0],
      new RegExp(`\\smin="${control.minimum}"`),
      `${control.name} counts its steps from a different minimum than this file measures from`,
    );
  }
});

/**
 * The tick row under the tempo slider is a scale a reader aims at, so every
 * tempo it draws has to be a tempo the slider can actually stop on: the step
 * divides the interval, and the range spans a whole number of intervals, which
 * together put the first and last marks on the slider's own ends. A row drawn at
 * any other interval would be a ruler whose numbers sit between the values it
 * measures rather than on them.
 */
test("every tempo the tick row draws is one the slider can hold", () => {
  assert.equal(TEMPO_TICK_INTERVAL % TEMPO_STEP, 0);
  assert.equal((TEMPO_LIMIT.maximum - TEMPO_LIMIT.minimum) % TEMPO_TICK_INTERVAL, 0);
});

/**
 * The one snap left in the interface. It exists for the reading: `panLabel`
 * calls anything inside four percent of the middle "Centre", and before this a
 * drag could leave that word over a Balance that was audibly off to one side.
 * The slider carries its value as a string, so the string form is the one the
 * interface actually passes.
 */
test("a dragged Balance inside the centre tolerance is centred exactly", () => {
  assert.equal(snapBalance("0.05"), 0);
  assert.equal(snapBalance("-0.05"), 0);
  assert.equal(snapBalance("0"), 0);
  // A Balance approached from the left can arrive as `-0`, which is the centre
  // by every comparison the application makes and a different value to
  // `Object.is` — which is what `assert/strict` compares with, so this asserts
  // the sign as much as the value. It reaches storage, the Preset snapshot and
  // the readout, so it is settled here rather than in each of them.
  assert.equal(snapBalance("-0"), 0);
});

test("a dragged Balance outside the centre tolerance is left where it landed", () => {
  assert.equal(snapBalance("0.1"), 0.1);
  assert.equal(snapBalance("-0.1"), -0.1);
  assert.equal(snapBalance("1"), 1);
  assert.equal(snapBalance("-1"), -1);
});

/**
 * What the snap costs, stated over every position the slider can stop on. A
 * tolerance one step wide takes the two positions either side of centre and
 * nothing else, and those two are still reachable by arrow key, because only the
 * pointer snaps: a key stepping off centre would be pulled straight back onto it
 * and the slider would be stuck there for good.
 *
 * The interval table this replaced also claimed marks at every quarter, and its
 * five-percent tolerance around each one made sixteen of these positions
 * unreachable by drag — ±0.20, ±0.30, ±0.45, ±0.55, ±0.70, ±0.80 and ±0.95 as
 * well as ±0.05. Nobody chose to lose those, which is why the list below is
 * asserted exactly rather than as an upper bound.
 */
test("a drag reaches every Balance the slider steps to except the two beside centre", () => {
  const percentStep = Math.round(MIX_STEP * 100);
  const swallowed = [];

  for (let percent = -100; percent <= 100; percent += percentStep) {
    const value = percent / 100;
    if (snapBalance(value) !== value) swallowed.push(percent);
  }

  assert.deepEqual(swallowed, [-percentStep, percentStep]);
});

test("a Balance that is not a number is left for the Configuration to refuse", () => {
  assert.equal(snapBalance(""), "");
  assert.equal(snapBalance("centre"), "centre");
  assert.equal(snapBalance(null), null);
});

/**
 * `panLabel` calls anything inside four percent of the middle "Centre", which
 * was a reading no drag could make true: the value under it was off-centre by as
 * much as three percent and the audio was too. The centre tolerance is wider
 * than that window, so everything inside it now arrives at exactly zero — which
 * is the fact that makes the label honest, and it belongs to the two constants
 * rather than to either one. The walk is over hundredths rather than over the
 * slider's own step, because a stored Balance is any value in range and the
 * label has to be honest about whatever a drag then settles.
 */
test("a dragged Balance that reads Centre is centred", () => {
  for (let counted = -100; counted <= 100; counted += 1) {
    const value = counted / 100;
    const snapped = snapBalance(value);
    if (panLabel(snapped) === "Centre") {
      assert.equal(snapped, 0, `${value} settled at ${snapped}, which reads Centre but is not`);
    }
  }
});
