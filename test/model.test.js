import test from "node:test";
import assert from "node:assert/strict";

import {
  METER_COUNT_LIMIT,
  METER_UNITS,
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
  assert.deepEqual(METER_COUNT_LIMIT, { minimum: 1, maximum: 16 });
  assert.ok(Object.isFrozen(METER_COUNT_LIMIT));
  assert.deepEqual(METER_UNITS, [1, 2, 4, 8]);
  assert.ok(Object.isFrozen(METER_UNITS));
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

test("Subdivision labels retain a readable fallback outside the offered units", () => {
  assert.equal(subdivisionLabel(2, 3), "2 per 1/3 unit · duple");
  assert.equal(subdivisionLabel(1, 5), "1 per 1/5 unit · straight");
  assert.notEqual(subdivisionLabel(2, 3), subdivisionLabel(2, 5));
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

test("changing only a Meter denominator does not change its Cycle span", () => {
  const cycle = {
    rhythms: [
      { signature: { count: 4, unit: 1 }, subdivision: 1 },
      { signature: { count: 4, unit: 8 }, subdivision: 1 },
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 2);
});
