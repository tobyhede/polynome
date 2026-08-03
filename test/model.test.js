import test from "node:test";
import assert from "node:assert/strict";

import {
  METER_COUNT_LIMIT,
  NOTE_UNITS,
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
  assert.deepEqual(NOTE_UNITS, [1, 2, 4, 8, 16, 32]);
  assert.deepEqual(Object.values(STEP), ["off", "quarter", "half", "full"]);
  assert.ok(Object.isFrozen(NOTE_UNITS));
  assert.ok(Object.isFrozen(METER_COUNT_LIMIT));
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
  assert.equal(subdivisionLabel(1, 5), "1 per signature unit · straight");
});

test("every Subdivision the Configuration offers has a named label", () => {
  const { subdivisions } = describeConfiguration(createConfiguration()).choices;

  assert.ok(subdivisions.length, "Expected Configuration to offer Subdivisions");
  for (const subdivision of subdivisions) {
    for (const unit of NOTE_UNITS) {
      const label = subdivisionLabel(subdivision, unit);
      assert.ok(
        !label.includes("undefined"),
        `Subdivision ${subdivision} over unit ${unit} labels as "${label}"`,
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
