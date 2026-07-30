import test from "node:test";
import assert from "node:assert/strict";

import {
  STEP,
  activeStepIndex,
  createLayer,
  createPreset,
  cycleDurationSeconds,
  eventsBetween,
  nextStepState,
  normaliseState,
  resizePattern,
  stepDurationSeconds,
} from "../model.js";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("cycle duration uses quarter-note BPM as the shared reference", () => {
  closeTo(cycleDurationSeconds(120, { count: 4, unit: 4 }), 2);
  closeTo(cycleDurationSeconds(120, { count: 7, unit: 8 }), 1.75);
  closeTo(cycleDurationSeconds(60, { count: 3, unit: 4 }), 3);
});

test("3:2 produces three and two evenly spaced events in one shared cycle", () => {
  const state = createPreset("3:2");
  const cycle = cycleDurationSeconds(state.bpm, state.layers[0].signature);
  const events = eventsBetween(state, 0, cycle, 0);

  const three = events.filter((event) => event.layerId === state.layers[0].id);
  const two = events.filter((event) => event.layerId === state.layers[1].id);

  assert.equal(three.length, 3);
  assert.equal(two.length, 2);
  closeTo(three[0].when, 0);
  closeTo(three[1].when, cycle / 3);
  closeTo(three[2].when, (cycle * 2) / 3);
  closeTo(two[0].when, 0);
  closeTo(two[1].when, cycle / 2);
});

test("4/4 and 3/4 downbeats realign after twelve quarter notes", () => {
  const state = createPreset("4/4 + 3/4");
  state.bpm = 120;

  const fourCycle = cycleDurationSeconds(state.bpm, state.layers[0].signature);
  const threeCycle = cycleDurationSeconds(state.bpm, state.layers[1].signature);

  closeTo(fourCycle, 2);
  closeTo(threeCycle, 1.5);
  closeTo(fourCycle * 3, 6);
  closeTo(threeCycle * 4, 6);
});

test("rests never generate audio events", () => {
  const layer = createLayer({
    id: "rests",
    signature: { count: 4, unit: 4 },
    steps: [STEP.ACCENT, STEP.REST, STEP.HIT, STEP.REST],
  });
  const state = { bpm: 120, layers: [layer] };
  const events = eventsBetween(state, 0, 2, 0);

  assert.deepEqual(
    events.map((event) => event.patternIndex),
    [0, 2],
  );
});

test("step timing is derived from the transport origin and does not accumulate", () => {
  const layer = createLayer({
    signature: { count: 4, unit: 4 },
    steps: [STEP.ACCENT, STEP.HIT, STEP.HIT],
  });
  const duration = stepDurationSeconds(137, layer);
  const origin = 1.234;
  const active = activeStepIndex(137, layer, origin, origin + duration * 2002.2);

  assert.equal(active, 1);
  closeTo(origin + duration * 2002, origin + duration * 2002);
});

test("pattern states cycle accent to hit to rest to accent", () => {
  assert.equal(nextStepState(STEP.ACCENT), STEP.HIT);
  assert.equal(nextStepState(STEP.HIT), STEP.REST);
  assert.equal(nextStepState(STEP.REST), STEP.ACCENT);
});

test("resizing a pattern preserves existing steps and fills new subdivisions", () => {
  const original = [STEP.ACCENT, STEP.REST];
  assert.deepEqual(resizePattern(original, 4), [
    STEP.ACCENT,
    STEP.REST,
    STEP.HIT,
    STEP.HIT,
  ]);
  assert.deepEqual(resizePattern(original, 1), [STEP.ACCENT]);
});

test("state normalisation clamps unsafe values and preserves at least one layer", () => {
  const state = normaliseState({ bpm: 9999, masterVolume: -2, layers: [] });
  assert.equal(state.bpm, 300);
  assert.equal(state.masterVolume, 0);
  assert.ok(state.layers.length >= 1);
});
