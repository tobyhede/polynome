import test from "node:test";
import assert from "node:assert/strict";

import {
  STEP,
  cycleDurationSeconds,
  cycleSpanSeconds,
  stepDurationSeconds,
  stepLevel,
} from "../model.js";

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

test("cycle duration uses quarter-note BPM as the shared reference", () => {
  closeTo(cycleDurationSeconds(120, { count: 4, unit: 4 }), 2);
  closeTo(cycleDurationSeconds(120, { count: 7, unit: 8 }), 1.75);
  closeTo(cycleDurationSeconds(60, { count: 3, unit: 4 }), 3);
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

test("step duration follows Subdivision within each signature unit", () => {
  const rhythm = {
    signature: { count: 4, unit: 4 },
    subdivision: 3,
  };

  closeTo(stepDurationSeconds(120, rhythm), 1 / 6);
});
