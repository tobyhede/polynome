import test from "node:test";
import assert from "node:assert/strict";

import {
  changeConfiguration,
  createConfiguration,
  describeConfiguration,
} from "../configuration.js";

test("the default Configuration contains one active 4/4 Rhythm layer", () => {
  const configuration = createConfiguration();

  assert.equal(configuration.bpm, 96);
  assert.equal(configuration.masterVolume, 0.8);
  assert.equal(configuration.sequence.cycles.length, 1);
  assert.equal(configuration.sequence.cycles[0].repetitions, 1);
  assert.deepEqual(
    configuration.sequence.cycles[0].rhythms.map((rhythm) => ({
      signature: rhythm.signature,
      subdivision: rhythm.subdivision,
      steps: rhythm.steps,
      volume: rhythm.volume,
      pan: rhythm.pan,
      sound: rhythm.sound,
      muted: rhythm.muted,
    })),
    [{
      signature: { count: 4, unit: 4 },
      subdivision: 1,
      steps: ["full", "half", "half", "half"],
      volume: 0.72,
      pan: 0,
      sound: "high",
      muted: false,
    }],
  );
});

test("tempo edits return a new Configuration and restart consequence", () => {
  const original = createConfiguration();
  const result = changeConfiguration(original, { type: "set-tempo", bpm: 140 });

  assert.equal(result.configuration.bpm, 140);
  assert.equal(original.bpm, 96);
  assert.equal(result.consequence, "restart-transport-run");
  assert.equal(result.reason, null);
});

test("applying a Preset replaces the complete Configuration", () => {
  const result = changeConfiguration(createConfiguration(), {
    type: "apply-preset",
    name: "4/4 + 3/4",
  });

  assert.equal(result.configuration.bpm, 112);
  assert.equal(result.configuration.masterVolume, 0.8);
  assert.deepEqual(
    result.configuration.sequence.cycles[0].rhythms.map((rhythm) => ({
      signature: rhythm.signature,
      sound: rhythm.sound,
      pan: rhythm.pan,
    })),
    [
      { signature: { count: 4, unit: 4 }, sound: "high", pan: 0 },
      { signature: { count: 3, unit: 4 }, sound: "low", pan: 0 },
    ],
  );
  assert.equal(result.consequence, "restart-transport-run");
  assert.equal(describeConfiguration(result.configuration).selectedPreset, "4/4 + 3/4");
});

test("adding a Cycle appends one active 4/4 Rhythm layer", () => {
  const original = createConfiguration();
  const result = changeConfiguration(original, { type: "add-cycle" });

  assert.equal(result.configuration.sequence.cycles.length, 2);
  assert.deepEqual(
    result.configuration.sequence.cycles.map((cycle) => ({
      repetitions: cycle.repetitions,
      signatures: cycle.rhythms.map((rhythm) => rhythm.signature),
    })),
    [
      { repetitions: 1, signatures: [{ count: 4, unit: 4 }] },
      { repetitions: 1, signatures: [{ count: 4, unit: 4 }] },
    ],
  );
  assert.equal(original.sequence.cycles.length, 1);
  assert.equal(result.consequence, "restart-transport-run");
});

test("removing the final Cycle is an unchanged edit with a stable reason", () => {
  const configuration = createConfiguration();
  const cycleId = configuration.sequence.cycles[0].id;
  const result = changeConfiguration(configuration, {
    type: "remove-cycle",
    cycleId,
  });

  assert.strictEqual(result.configuration, configuration);
  assert.equal(result.consequence, "none");
  assert.equal(result.reason, "sequence-requires-cycle");
});

test("Cycle repetitions preserve one active Cycle and the single-Cycle rule", () => {
  const one = createConfiguration();
  const onlyId = one.sequence.cycles[0].id;
  const rejected = changeConfiguration(one, {
    type: "set-cycle-repetitions",
    cycleId: onlyId,
    repetitions: 0,
  });
  assert.strictEqual(rejected.configuration, one);
  assert.equal(rejected.reason, "single-cycle-requires-one-repetition");

  const two = changeConfiguration(one, { type: "add-cycle" }).configuration;
  const [first, second] = two.sequence.cycles;
  const firstOff = changeConfiguration(two, {
    type: "set-cycle-repetitions",
    cycleId: first.id,
    repetitions: 0,
  });
  assert.deepEqual(
    firstOff.configuration.sequence.cycles.map((cycle) => cycle.repetitions),
    [0, 1],
  );
  assert.equal(firstOff.consequence, "restart-transport-run");
  const finalOff = changeConfiguration(firstOff.configuration, {
    type: "set-cycle-repetitions",
    cycleId: second.id,
    repetitions: 0,
  });
  assert.strictEqual(finalOff.configuration, firstOff.configuration);
  assert.equal(finalOff.reason, "sequence-requires-active-cycle");

  const firstRepeated = changeConfiguration(two, {
    type: "set-cycle-repetitions",
    cycleId: first.id,
    repetitions: 3,
  }).configuration;
  const secondOff = changeConfiguration(firstRepeated, {
    type: "set-cycle-repetitions",
    cycleId: second.id,
    repetitions: 0,
  }).configuration;
  const backToOne = changeConfiguration(secondOff, {
    type: "remove-cycle",
    cycleId: second.id,
  });
  assert.equal(backToOne.configuration.sequence.cycles[0].repetitions, 1);
});

test("Rhythm-layer structural edits preserve a non-empty Cycle", () => {
  const one = createConfiguration();
  const cycleId = one.sequence.cycles[0].id;
  const firstRhythmId = one.sequence.cycles[0].rhythms[0].id;
  const rejected = changeConfiguration(one, {
    type: "remove-rhythm",
    cycleId,
    rhythmId: firstRhythmId,
  });
  assert.strictEqual(rejected.configuration, one);
  assert.equal(rejected.reason, "cycle-requires-rhythm");

  const added = changeConfiguration(one, { type: "add-rhythm", cycleId });
  assert.equal(added.configuration.sequence.cycles[0].rhythms.length, 2);
  assert.equal(added.consequence, "restart-transport-run");
  const removed = changeConfiguration(added.configuration, {
    type: "remove-rhythm",
    cycleId,
    rhythmId: firstRhythmId,
  });
  assert.equal(removed.configuration.sequence.cycles[0].rhythms.length, 1);
  assert.equal(removed.consequence, "restart-transport-run");
});

test("Meter and Subdivision edits resize the meter-relative grid without losing levels", () => {
  const base = createConfiguration({
    sequence: { cycles: [{ rhythms: [{
      signature: { count: 2, unit: 4 },
      subdivision: 2,
      steps: ["full", "off", "half", "full"],
    }] }] },
  });
  const cycleId = base.sequence.cycles[0].id;
  const rhythmId = base.sequence.cycles[0].rhythms[0].id;
  const wider = changeConfiguration(base, {
    type: "set-meter-count",
    cycleId,
    rhythmId,
    count: 3,
  });
  assert.deepEqual(wider.configuration.sequence.cycles[0].rhythms[0].steps, [
    "full", "off", "half", "full", "half", "half",
  ]);
  assert.equal(wider.consequence, "restart-transport-run");
  const simpler = changeConfiguration(wider.configuration, {
    type: "set-subdivision",
    cycleId,
    rhythmId,
    subdivision: 1,
  });
  assert.deepEqual(simpler.configuration.sequence.cycles[0].rhythms[0].steps, [
    "full", "off", "half",
  ]);
  assert.equal(simpler.consequence, "restart-transport-run");
});

test("advancing a Step level preserves the transport run", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const result = changeConfiguration(configuration, {
    type: "advance-step-level",
    cycleId: cycle.id,
    rhythmId: rhythm.id,
    position: 0,
  });

  assert.equal(result.configuration.sequence.cycles[0].rhythms[0].steps[0], "half");
  assert.equal(result.consequence, "update-step-levels");
});

test("sound and mix edits preserve transport position and all affect Preset identity", () => {
  const base = createConfiguration();
  const cycle = base.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const edits = [
    { type: "set-master-volume", masterVolume: 0.4 },
    { type: "set-sound", cycleId: cycle.id, rhythmId: rhythm.id, sound: "wood" },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id, volume: 0.4 },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: -1 },
    { type: "set-muted", cycleId: cycle.id, rhythmId: rhythm.id, muted: true },
  ];

  for (const edit of edits) {
    const result = changeConfiguration(base, edit);
    assert.equal(result.consequence, "update-mix");
    assert.equal(describeConfiguration(result.configuration).selectedPreset, null);
  }
  assert.equal(describeConfiguration(base).selectedPreset, "4/4");
});

test("Configuration description exposes domain choices and unavailable final removals", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const description = describeConfiguration(configuration);

  assert.deepEqual(description.choices, {
    presetNames: ["4/4", "4/4 + 3/4"],
    meterUnits: [1, 2, 4, 8, 16, 32],
    subdivisions: [1, 2, 3, 4, 5],
    sounds: ["high", "low", "wood"],
    stepLevels: ["off", "quarter", "half", "full"],
    repetitions: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  });
  assert.equal(description.selectedPreset, "4/4");
  assert.deepEqual(description.availability.cycles[cycle.id].remove, {
    available: false,
    reason: "sequence-requires-cycle",
  });
  assert.deepEqual(description.availability.cycles[cycle.id].repetitions[0], {
    available: false,
    reason: "single-cycle-requires-one-repetition",
  });
  assert.deepEqual(
    description.availability.cycles[cycle.id].rhythms[rhythm.id].remove,
    { available: false, reason: "cycle-requires-rhythm" },
  );
});

test("loaded Configuration is repaired into the valid nested shape", () => {
  const configuration = createConfiguration({
    bpm: 9999,
    masterVolume: -2,
    sequence: {
      cycles: [
        { repetitions: 99, rhythms: Array.from({ length: 8 }, () => ({})) },
        { repetitions: -4, rhythms: Array.from({ length: 8 }, () => ({})) },
      ],
    },
  });

  assert.equal(configuration.bpm, 300);
  assert.equal(configuration.masterVolume, 0);
  assert.deepEqual(
    configuration.sequence.cycles.map((cycle) => cycle.repetitions),
    [8, 0],
  );
  assert.equal(
    configuration.sequence.cycles.flatMap((cycle) => cycle.rhythms).length,
    12,
  );

  const duplicateIds = createConfiguration({
    sequence: {
      cycles: [
        { id: "duplicate", rhythms: [{ id: "duplicate" }] },
        { id: "duplicate", rhythms: [{ id: "duplicate" }] },
      ],
    },
  });
  const ids = duplicateIds.sequence.cycles.flatMap((cycle) => [
    cycle.id,
    ...cycle.rhythms.map((rhythm) => rhythm.id),
  ]);
  assert.equal(new Set(ids).size, 4);
});

test("malformed and unknown edits expose programmer errors", () => {
  const configuration = createConfiguration();

  assert.throws(
    () => changeConfiguration(configuration, {}),
    { name: "TypeError", message: "Configuration edit must have a type" },
  );
  assert.throws(
    () => changeConfiguration(configuration, { type: "warp-time" }),
    { name: "TypeError", message: "Unknown Configuration edit: warp-time" },
  );
});

test("known edits with structurally malformed payloads expose programmer errors", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const malformedEdits = [
    { type: "set-tempo" },
    { type: "set-master-volume", masterVolume: {} },
    { type: "set-cycle-repetitions", cycleId: cycle.id },
    { type: "set-meter-count", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-meter-unit", cycleId: cycle.id, rhythmId: rhythm.id, unit: [] },
    { type: "set-subdivision", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-sound", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-muted", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "remove-cycle" },
    { type: "add-rhythm", cycleId: 42 },
    { type: "remove-rhythm", cycleId: cycle.id },
    { type: "advance-step-level", cycleId: cycle.id, rhythmId: rhythm.id },
  ];

  for (const edit of malformedEdits) {
    assert.throws(
      () => changeConfiguration(configuration, edit),
      { name: "TypeError", message: `Malformed Configuration edit: ${edit.type}` },
    );
  }
});

test("well-formed edits with invalid domain values are unchanged no-ops", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const invalidEdits = [
    { type: "set-tempo", bpm: "not-a-number" },
    { type: "set-tempo", bpm: 301 },
    { type: "set-master-volume", masterVolume: -0.01 },
    { type: "set-cycle-repetitions", cycleId: cycle.id, repetitions: 1.5 },
    { type: "set-meter-count", cycleId: cycle.id, rhythmId: rhythm.id, count: 0 },
    { type: "set-meter-unit", cycleId: cycle.id, rhythmId: rhythm.id, unit: 3 },
    { type: "set-subdivision", cycleId: cycle.id, rhythmId: rhythm.id, subdivision: 6 },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id, volume: 2 },
    { type: "set-sound", cycleId: cycle.id, rhythmId: rhythm.id, sound: "clap" },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: -2 },
  ];

  for (const edit of invalidEdits) {
    const result = changeConfiguration(configuration, edit);
    assert.strictEqual(result.configuration, configuration);
    assert.equal(result.consequence, "none");
    assert.equal(result.reason, "invalid-value");
  }
});

test("valid edits that leave every user-editable value unchanged are no-ops", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const sameValueEdits = [
    { type: "apply-preset", name: "4/4" },
    { type: "set-tempo", bpm: "96" },
    { type: "set-master-volume", masterVolume: "0.8" },
    { type: "set-cycle-repetitions", cycleId: cycle.id, repetitions: "1" },
    { type: "set-meter-count", cycleId: cycle.id, rhythmId: rhythm.id, count: "4" },
    { type: "set-meter-unit", cycleId: cycle.id, rhythmId: rhythm.id, unit: "4" },
    { type: "set-subdivision", cycleId: cycle.id, rhythmId: rhythm.id, subdivision: "1" },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id, volume: "0.72" },
    { type: "set-sound", cycleId: cycle.id, rhythmId: rhythm.id, sound: "high" },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: "0" },
    { type: "set-muted", cycleId: cycle.id, rhythmId: rhythm.id, muted: false },
  ];

  for (const edit of sameValueEdits) {
    const result = changeConfiguration(configuration, edit);
    assert.strictEqual(result.configuration, configuration);
    assert.equal(result.consequence, "none");
    assert.equal(result.reason, null);
  }
});
