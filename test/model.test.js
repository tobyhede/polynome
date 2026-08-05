import test from "node:test";
import assert from "node:assert/strict";

import {
  BALANCE_SNAP,
  LEVEL_SNAP,
  METER_COUNT_LIMIT,
  METER_UNITS,
  SOUND,
  STEP,
  TEMPO_LIMIT,
  TEMPO_SNAP,
  cycleSpanSeconds,
  panLabel,
  snapTempo,
  snapToMark,
  stepDurationSeconds,
  subdivisionLabel,
} from "../model.js";
import { createConfiguration, describeConfiguration } from "../configuration.js";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("a Cycle span completes every contained Meter and ignores Subdivision", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 4 }, subdivision: 5 },
      { signature: { count: 3, unit: 4 }, subdivision: 2 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 6);
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

test("step duration follows Subdivision within each signature unit", () => {
  const rhythm = {
    signature: { count: 4, unit: 4 },
    subdivision: 3,
  };

  closeTo(stepDurationSeconds(120, rhythm), 1 / 6);
});

test("step duration follows BPM and Subdivision regardless of Meter denominator", () => {
  const rhythm = {
    signature: { count: 4, unit: 1 },
    subdivision: 2,
  };

  closeTo(stepDurationSeconds(120, rhythm), 1 / 4);
  closeTo(
    stepDurationSeconds(120, {
      ...rhythm,
      signature: { count: 4, unit: 8 },
    }),
    1 / 4,
  );
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

/**
 * A drag stops on the ten-BPM marks the tick row draws, and the slider carries
 * its value as a string, so the string form is the one the interface actually
 * passes.
 */
test("a dragged tempo takes the nearest ten within the snap tolerance", () => {
  assert.equal(snapTempo("88"), 90);
  assert.equal(snapTempo("92"), 90);
  assert.equal(snapTempo(89), 90);
  assert.equal(snapTempo(90), 90);
});

test("a dragged tempo outside the tolerance is left where it landed", () => {
  assert.equal(snapTempo(87), 87);
  assert.equal(snapTempo("93"), 93);
  assert.equal(snapTempo(85), 85);
});

/**
 * Snapping never carries a tempo past a bound, and what makes that true is that
 * both ends of the range are marks themselves. That is a fact about the two
 * constants rather than about `snapTempo`, so it is asserted where a change to
 * either would be caught — a range ending anywhere else would let the tolerance
 * pull a tempo off the end of the slider.
 */
test("both ends of the tempo range are marks", () => {
  assert.equal(TEMPO_LIMIT.minimum % TEMPO_SNAP.interval, 0);
  assert.equal(TEMPO_LIMIT.maximum % TEMPO_SNAP.interval, 0);
});

test("snapping holds the tempo range's own ends", () => {
  assert.equal(snapTempo(TEMPO_LIMIT.minimum + 1), TEMPO_LIMIT.minimum);
  assert.equal(snapTempo(TEMPO_LIMIT.maximum - 1), TEMPO_LIMIT.maximum);
  assert.equal(snapTempo(TEMPO_LIMIT.minimum), TEMPO_LIMIT.minimum);
  assert.equal(snapTempo(TEMPO_LIMIT.maximum), TEMPO_LIMIT.maximum);
});

/**
 * Every value the slider can hold is either a mark or within one tolerance of
 * the nearest one, so no drag can land somewhere the snap leaves further from a
 * mark than the tolerance allows.
 */
test("no reachable tempo settles further from a mark than the tolerance", () => {
  for (let bpm = TEMPO_LIMIT.minimum; bpm <= TEMPO_LIMIT.maximum; bpm += 1) {
    const snapped = snapTempo(bpm);
    const mark = Math.round(snapped / TEMPO_SNAP.interval) * TEMPO_SNAP.interval;
    assert.ok(
      snapped === mark || Math.abs(snapped - mark) > TEMPO_SNAP.tolerance,
      `${bpm} settled at ${snapped}, which is neither a mark nor clear of one`,
    );
  }
});

test("a tempo that is not a number is left for the Configuration to refuse", () => {
  assert.equal(snapTempo(""), "");
  assert.equal(snapTempo("fast"), "fast");
  assert.equal(snapTempo(null), null);
});

/**
 * The two mix sliders count their marks in percent while carrying a fraction,
 * so every reachable value is one of the hundredths the `step` allows. Both
 * walks below are over that set rather than over a float sequence, because a
 * loop adding 0.01 to itself drifts and would be testing its own arithmetic.
 */
const reachable = (minimum, maximum) =>
  Array.from(
    { length: (maximum - minimum) * 100 + 1 },
    (_, index) => (minimum * 100 + index) / 100,
  );

const MIX_SNAPS = [
  { name: "Level", snap: LEVEL_SNAP, minimum: 0, maximum: 1 },
  { name: "Balance", snap: BALANCE_SNAP, minimum: -1, maximum: 1 },
];

/**
 * The same fact the tempo range is held to, for the same reason: a bound that
 * is not itself a mark is a bound the tolerance can pull a value off the end of.
 */
for (const { name, snap, minimum, maximum } of MIX_SNAPS) {
  test(`both ends of the ${name} range are marks`, () => {
    // `Math.abs` because a negative bound leaves a negative zero behind, which
    // is the remainder this is asking about and not the same value to `equal`.
    assert.equal(Math.abs((minimum * snap.scale) % snap.interval), 0);
    assert.equal(Math.abs((maximum * snap.scale) % snap.interval), 0);
  });

  test(`snapping holds the ${name} range's own ends`, () => {
    assert.equal(snapToMark(minimum, snap), minimum);
    assert.equal(snapToMark(maximum, snap), maximum);
    assert.equal(snapToMark(minimum + 0.01, snap), minimum);
    assert.equal(snapToMark(maximum - 0.01, snap), maximum);
  });

  /**
   * The whole specification, over every value the slider can hold: inside the
   * tolerance the value is the mark, outside it the value is untouched.
   *
   * Stated both ways round on purpose. Asserting only that a settled value is
   * never stranded beside a mark — which is how the tempo's own version of this
   * reads — is satisfied by a snap that never fires at all, and that is not a
   * hypothetical: `0.58` counted to `57.99999999999999` and missed a tolerance
   * of two by a hundred-billionth, which the one-sided form waved through
   * because a value that stays put is trivially clear of the mark it should
   * have taken. The count here is a whole number that never leaves the integers,
   * so what the assertion expects is exact rather than itself rounded.
   */
  test(`every ${name} within a tolerance of a mark lands on it`, () => {
    for (let counted = minimum * snap.scale; counted <= maximum * snap.scale; counted += 1) {
      const value = counted / snap.scale;
      const mark = Math.round(counted / snap.interval) * snap.interval;
      const settled = Math.abs(counted - mark) <= snap.tolerance ? mark / snap.scale : value;
      assert.equal(snapToMark(value, snap), settled === 0 ? 0 : settled, `${value} settled wrong`);
    }
  });

  /**
   * A mark has to arrive as the number the Preset holding it would carry.
   * `Math.round(0.3 / 0.1) * 0.1` is `0.30000000000000004`, and a Level or
   * Balance carrying that compares unequal to the `0.3` it was saved at — which
   * surfaces as a Configuration offering to be saved again over a change nobody
   * made. Counting in percent and dividing once is what avoids it, so this
   * asserts the arithmetic rather than trusting it.
   */
  test(`a snapped ${name} is the number a Preset would hold`, () => {
    for (const value of reachable(minimum, maximum)) {
      const snapped = snapToMark(value, snap);
      assert.equal(snapped, Number(snapped.toFixed(2)), `${value} settled at ${snapped}`);
    }
  });
}

test("a mix value that is not a number is left for the Configuration to refuse", () => {
  assert.equal(snapToMark("", LEVEL_SNAP), "");
  assert.equal(snapToMark("centre", BALANCE_SNAP), "centre");
  assert.equal(snapToMark(null, BALANCE_SNAP), null);
});

/**
 * `panLabel` calls anything inside four percent of the middle "Centre", which
 * was a reading no drag could make true: the value under it was off-centre by
 * as much as three percent and the audio was too. The Balance tolerance is
 * wider than that window, so everything inside it now arrives at exactly zero —
 * which is the fact that makes the label honest, and it belongs to the two
 * constants rather than to either one.
 */
test("a dragged Balance that reads Centre is centred", () => {
  for (const value of reachable(-1, 1)) {
    const snapped = snapToMark(value, BALANCE_SNAP);
    if (panLabel(snapped) === "Centre") {
      assert.equal(snapped, 0, `${value} settled at ${snapped}, which reads Centre but is not`);
    }
  }
});
