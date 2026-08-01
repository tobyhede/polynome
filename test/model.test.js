import test from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_NAMES,
  STEP,
  createDefaultState,
  createLayer,
  createPreset,
  cycleSpanSeconds,
  cycleDurationSeconds,
  nextStepState,
  normaliseState,
  resizePattern,
  sequenceSummary,
  stepDurationSeconds,
} from "../model.js";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("the application loads one cycle containing one 4/4 rhythm", () => {
  const state = createDefaultState();

  assert.equal(state.cycles.length, 1);
  assert.equal(state.cycles[0].repetitions, 1);
  assert.deepEqual(state.cycles[0].rhythms.map((layer) => ({
    signature: layer.signature,
    subdivision: layer.subdivision,
    positions: layer.steps.length,
  })), [
    {
      signature: { count: 4, unit: 4 },
      subdivision: 1,
      positions: 4,
    },
  ]);
});

test("the preset catalogue starts with meter-first rhythms", () => {
  assert.deepEqual(PRESET_NAMES, ["4/4", "4/4 + 3/4"]);
});

test("sequence summary distinguishes simultaneous rhythms from sequential cycles", () => {
  const state = normaliseState({
    cycles: [
      {
        repetitions: 4,
        rhythms: [
          { signature: { count: 4, unit: 4 } },
          { signature: { count: 3, unit: 4 } },
        ],
      },
      {
        repetitions: 1,
        rhythms: [{ signature: { count: 4, unit: 4 } }],
      },
    ],
  });

  assert.equal(sequenceSummary(state), "4(4/4 + 3/4), 1(4/4)");
});

test("cycle duration uses quarter-note BPM as the shared reference", () => {
  closeTo(cycleDurationSeconds(120, { count: 4, unit: 4 }), 2);
  closeTo(cycleDurationSeconds(120, { count: 7, unit: 8 }), 1.75);
  closeTo(cycleDurationSeconds(60, { count: 3, unit: 4 }), 3);
});

test("a rhythm layer creates one pattern position per meter-relative pulse", () => {
  const layer = createLayer({
    signature: { count: 4, unit: 4 },
    subdivision: 3,
  });

  assert.equal(layer.subdivision, 3);
  assert.equal(layer.steps.length, 12);
});

test("a rhythm layer preserves supplied emphasis while filling its meter-relative grid", () => {
  const layer = createLayer({
    signature: { count: 2, unit: 4 },
    subdivision: 2,
    steps: [STEP.ACCENT, STEP.REST],
  });

  assert.deepEqual(layer.steps, [
    STEP.ACCENT,
    STEP.REST,
    STEP.HIT,
    STEP.HIT,
  ]);
});

test("state normalisation clamps subdivision and keeps the full meter-relative grid", () => {
  const state = normaliseState({
    cycles: [
      { rhythms: [{
          signature: { count: 32, unit: 4 },
          subdivision: 99,
          steps: [STEP.ACCENT, STEP.REST],
      }] },
    ],
  });

  const layer = state.cycles[0].rhythms[0];
  assert.equal(layer.subdivision, 5);
  assert.equal(layer.steps.length, 160);
  assert.deepEqual(layer.steps.slice(0, 2), [
    STEP.ACCENT,
    STEP.REST,
  ]);
});

test("meter and subdivision edits resize the pattern while preserving emphasis", () => {
  const original = createLayer({
    signature: { count: 2, unit: 4 },
    subdivision: 2,
    steps: [STEP.ACCENT, STEP.REST, STEP.HIT, STEP.ACCENT],
  });
  const widerMeter = createLayer({
    ...original,
    signature: { ...original.signature, count: 3 },
  });
  const simplerGrid = createLayer({
    ...widerMeter,
    subdivision: 1,
  });

  assert.deepEqual(widerMeter.steps, [
    STEP.ACCENT,
    STEP.REST,
    STEP.HIT,
    STEP.ACCENT,
    STEP.HIT,
    STEP.HIT,
  ]);
  assert.deepEqual(simplerGrid.steps, [
    STEP.ACCENT,
    STEP.REST,
    STEP.HIT,
  ]);
});

test("4/4 and 3/4 downbeats realign after twelve quarter notes", () => {
  const state = createPreset("4/4 + 3/4");
  state.bpm = 120;

  const fourCycle = cycleDurationSeconds(state.bpm, state.cycles[0].rhythms[0].signature);
  const threeCycle = cycleDurationSeconds(state.bpm, state.cycles[0].rhythms[1].signature);

  closeTo(fourCycle, 2);
  closeTo(threeCycle, 1.5);
  closeTo(fourCycle * 3, 6);
  closeTo(threeCycle * 4, 6);
});

test("a cycle span completes every contained meter and ignores subdivision", () => {
  const cycle = {
    rhythms: [
      createLayer({ signature: { count: 4, unit: 4 }, subdivision: 5 }),
      createLayer({ signature: { count: 3, unit: 4 }, subdivision: 2 }),
    ],
  };

  closeTo(cycleSpanSeconds(120, cycle), 6);
});

test("the 4/4 + 3/4 preset uses quarter-note pulses in both meters", () => {
  const polymeter = createPreset("4/4 + 3/4");

  assert.deepEqual(
    polymeter.cycles[0].rhythms.map((layer) => ({
      subdivision: layer.subdivision,
      positions: layer.steps.length,
    })),
    [
      { subdivision: 1, positions: 4 },
      { subdivision: 1, positions: 3 },
    ],
  );
  assert.deepEqual(
    polymeter.cycles[0].rhythms.map((layer) => layer.pan),
    [0, 0],
  );
});

test("step duration follows subdivision within each signature unit", () => {
  const layer = createLayer({
    signature: { count: 4, unit: 4 },
    subdivision: 3,
  });

  closeTo(stepDurationSeconds(120, layer), 1 / 6);
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

test("state normalisation clamps unsafe values and preserves a non-empty sequence", () => {
  const state = normaliseState({ bpm: 9999, masterVolume: -2, cycles: [] });
  assert.equal(state.bpm, 300);
  assert.equal(state.masterVolume, 0);
  assert.ok(state.cycles.length >= 1);
  assert.ok(state.cycles[0].rhythms.length >= 1);
});

test("state normalisation limits repetitions and total rhythms", () => {
  const state = normaliseState({
    cycles: [
      { repetitions: 99, rhythms: Array.from({ length: 8 }, () => ({})) },
      { repetitions: -4, rhythms: Array.from({ length: 8 }, () => ({})) },
    ],
  });

  assert.deepEqual(state.cycles.map((cycle) => cycle.repetitions), [32, 1]);
  assert.equal(
    state.cycles.reduce((total, cycle) => total + cycle.rhythms.length, 0),
    12,
  );
});
