import test from "node:test";
import assert from "node:assert/strict";

import {
  STEP,
  createDefaultState,
  createLayer,
  createPreset,
  cycleDurationSeconds,
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

test("the application loads the 3:2 preset in 2/4", () => {
  const state = createDefaultState();

  assert.deepEqual(
    state.layers.map((layer) => layer.signature),
    [
      { count: 2, unit: 4 },
      { count: 2, unit: 4 },
    ],
  );
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
    layers: [
      {
        signature: { count: 32, unit: 4 },
        subdivision: 99,
        steps: [STEP.ACCENT, STEP.REST],
      },
    ],
  });

  assert.equal(state.layers[0].subdivision, 5);
  assert.equal(state.layers[0].steps.length, 160);
  assert.deepEqual(state.layers[0].steps.slice(0, 2), [
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

  const fourCycle = cycleDurationSeconds(state.bpm, state.layers[0].signature);
  const threeCycle = cycleDurationSeconds(state.bpm, state.layers[1].signature);

  closeTo(fourCycle, 2);
  closeTo(threeCycle, 1.5);
  closeTo(fourCycle * 3, 6);
  closeTo(threeCycle * 4, 6);
});

test("ratio presets expose their meters and meter-relative grids", () => {
  const presetLayers = Object.fromEntries(
    ["3:2", "4:3", "5:4"].map((name) => [
      name,
      createPreset(name).layers.map((layer) => ({
        signature: layer.signature,
        subdivision: layer.subdivision,
        positions: layer.steps.length,
      })),
    ]),
  );

  assert.deepEqual(presetLayers, {
    "3:2": [
      { signature: { count: 2, unit: 4 }, subdivision: 3, positions: 6 },
      { signature: { count: 2, unit: 4 }, subdivision: 2, positions: 4 },
    ],
    "4:3": [
      { signature: { count: 4, unit: 4 }, subdivision: 4, positions: 16 },
      { signature: { count: 4, unit: 4 }, subdivision: 3, positions: 12 },
    ],
    "5:4": [
      { signature: { count: 4, unit: 4 }, subdivision: 5, positions: 20 },
      { signature: { count: 4, unit: 4 }, subdivision: 4, positions: 16 },
    ],
  });
});

test("meter presets use one pulse per signature unit and pattern-only emphasis", () => {
  const polymeter = createPreset("4/4 + 3/4");
  const sevenEight = createPreset("7/8 · 2+2+3").layers[0];

  assert.deepEqual(
    polymeter.layers.map((layer) => ({
      subdivision: layer.subdivision,
      positions: layer.steps.length,
    })),
    [
      { subdivision: 1, positions: 4 },
      { subdivision: 1, positions: 3 },
    ],
  );
  assert.equal(sevenEight.subdivision, 1);
  assert.equal(sevenEight.steps.length, 7);
  assert.deepEqual(
    sevenEight.steps
      .map((step, index) => step === STEP.ACCENT ? index : null)
      .filter((index) => index !== null),
    [0, 2, 4],
  );
  assert.equal("groups" in sevenEight, false);
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

test("state normalisation clamps unsafe values and preserves at least one layer", () => {
  const state = normaliseState({ bpm: 9999, masterVolume: -2, layers: [] });
  assert.equal(state.bpm, 300);
  assert.equal(state.masterVolume, 0);
  assert.ok(state.layers.length >= 1);
});
