import test from "node:test";
import assert from "node:assert/strict";

import {
  METER_COUNT_LIMIT,
  METER_UNIT_LIMIT,
  STEP,
  cycleSpanSeconds,
  stepDurationSeconds,
  stepLevel,
  subdivisionLabel,
} from "../model.js";
import { createConfiguration, describeConfiguration } from "../configuration.js";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("step levels expose amplitude-only factors", () => {
  assert.equal(stepLevel(STEP.OFF), 0);
  assert.equal(stepLevel(STEP.QUARTER), 0.25);
  assert.equal(stepLevel(STEP.HALF), 0.5);
  assert.equal(stepLevel(STEP.FULL), 1);
});

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
  assert.deepEqual(Object.values(STEP), ["off", "quarter", "half", "full"]);
  assert.deepEqual(METER_COUNT_LIMIT, { minimum: 1, maximum: 32 });
  assert.ok(Object.isFrozen(METER_COUNT_LIMIT));
  assert.deepEqual(METER_UNIT_LIMIT, { minimum: 1, maximum: 32 });
  assert.ok(Object.isFrozen(METER_UNIT_LIMIT));
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
 * Every denominator from 1 to 32 is now a Meter a musician can enter, so a
 * non-dyadic signature unit needs a name of its own. Naming them all
 * "signature" would leave every Subdivision option in a /3 Meter reading
 * identically to the same option in a /5 Meter.
 */
test("Subdivision labels name a non-dyadic signature unit by its duration", () => {
  assert.equal(subdivisionLabel(2, 3), "2 per 1/3 unit · duple");
  assert.equal(subdivisionLabel(1, 5), "1 per 1/5 unit · straight");
  assert.notEqual(subdivisionLabel(2, 3), subdivisionLabel(2, 5));
});

test("every Subdivision over every enterable Meter denominator is named", () => {
  const { subdivisions } = describeConfiguration(createConfiguration()).choices;

  assert.ok(subdivisions.length, "Expected Configuration to offer Subdivisions");
  for (const subdivision of subdivisions) {
    for (let unit = METER_UNIT_LIMIT.minimum; unit <= METER_UNIT_LIMIT.maximum; unit += 1) {
      const label = subdivisionLabel(subdivision, unit);
      assert.ok(
        !label.includes("undefined"),
        `Subdivision ${subdivision} over unit ${unit} labels as "${label}"`,
      );
      assert.ok(
        !label.includes("signature unit"),
        `Subdivision ${subdivision} over unit ${unit} falls back to "${label}"`,
      );
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

test("step duration supports a non-dyadic signature unit", () => {
  const rhythm = {
    signature: { count: 4, unit: 3 },
    subdivision: 2,
  };

  closeTo(stepDurationSeconds(120, rhythm), 1 / 3);
});

test("a Cycle span exactly completes dyadic and non-dyadic Meters", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 3 }, subdivision: 5 },
      { signature: { count: 3, unit: 4 }, subdivision: 2 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 24);
});

/**
 * A lone non-dyadic Meter spans its own written length and nothing longer. In
 * `4/3` each signature unit is a third of a whole note, so the Meter is
 * `4 × 4/3 = 16/3` quarter notes; a span rounded up to a whole number of
 * quarters would silently pad every Cycle containing one.
 */
test("a Cycle span of one non-dyadic Meter is that Meter's own length", () => {
  const cycle = { rhythms: [{ signature: { count: 4, unit: 3 }, subdivision: 1 }] };

  closeTo(cycleSpanSeconds(120, cycle), 8 / 3);
});

/**
 * Meters sharing a non-dyadic denominator must combine over that denominator
 * rather than over a whole-quarter lattice: `4/6` is exactly half of `4/3`, so
 * the two complete together after one `4/3`, not after three of them.
 */
test("a Cycle span reduces Meters that share a non-dyadic denominator", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 3 }, subdivision: 1 },
      { signature: { count: 4, unit: 6 }, subdivision: 1 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 8 / 3);
});
