import test from "node:test";
import assert from "node:assert/strict";

import {
  changeConfiguration,
  createConfiguration,
  createSavedPresets,
  describeConfiguration,
  describePresets,
  removeSavedPreset,
  savePreset,
} from "../configuration.js";

/**
 * Key insertion order carries no domain meaning, so a stored Configuration may
 * arrive with its keys in any order. Reversing every object rebuilds the same
 * Configuration values in the order this module never produces itself.
 */
function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reorderKeys(nested)]),
  );
}

function withoutIds(configuration) {
  return {
    ...configuration,
    sequence: {
      cycles: configuration.sequence.cycles.map(({ id: _cycleId, ...cycle }) => ({
        ...cycle,
        rhythms: cycle.rhythms.map(({ id: _rhythmId, ...rhythm }) => rhythm),
      })),
    },
  };
}

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

test("saving and loading a named Preset preserves the complete Configuration", () => {
  const configuration = createConfiguration({
    bpm: 173,
    masterVolume: 0.43,
    sequence: {
      cycles: [
        {
          repetitions: 2,
          rhythms: [{
            signature: { count: 5, unit: 8 },
            subdivision: 3,
            steps: ["full", "off", "quarter", "half", "full"],
            sound: "wood",
            volume: 0.31,
            pan: -0.62,
            muted: true,
          }],
        },
        {
          repetitions: 1,
          rhythms: [{
            signature: { count: 7, unit: 4 },
            subdivision: 2,
            sound: "low",
            volume: 0.91,
            pan: 0.77,
          }],
        },
      ],
    },
  });

  const saved = savePreset([], "  Clave practice  ", configuration);
  assert.equal(saved.reason, null);
  assert.equal(saved.preset.name, "Clave practice");
  assert.deepEqual(saved.preset.configuration, configuration);

  const loaded = createSavedPresets(JSON.parse(JSON.stringify(saved.presets)));
  assert.deepEqual(loaded, saved.presets);
});

test("saving an existing Preset name replaces its snapshot case-insensitively", () => {
  const first = savePreset([], "Warmup", createConfiguration({ bpm: 80 }));
  const replacement = savePreset(
    first.presets,
    "WARMUP",
    createConfiguration({ bpm: 140 }),
  );

  assert.equal(replacement.reason, null);
  assert.equal(replacement.presets.length, 1);
  assert.equal(replacement.preset.id, first.preset.id);
  assert.equal(replacement.preset.name, "WARMUP");
  assert.equal(replacement.preset.configuration.bpm, 140);
});

test("saved Preset names cannot be empty, oversized, or collide with built-ins", () => {
  const configuration = createConfiguration();
  for (const [name, reason] of [
    ["   ", "invalid-preset-name"],
    ["x".repeat(81), "invalid-preset-name"],
    ["4/4", "preset-name-reserved"],
    ["  4/4 + 3/4  ", "preset-name-reserved"],
  ]) {
    const result = savePreset([], name, configuration);
    assert.deepEqual(result.presets, []);
    assert.equal(result.reason, reason);
  }

  // The longest accepted name, checked beside the shortest rejected one: a limit
  // is only pinned from both sides.
  const longest = savePreset([], "x".repeat(80), configuration);
  assert.equal(longest.reason, null);
  assert.equal(longest.preset.name, "x".repeat(80));
});

/**
 * Preset names fold to compare them, and the store travels: the single-file
 * distribution opens anywhere, and `createSavedPresets` drops an entry whose
 * folded name already exists. Locale-sensitive folding would make that dedup
 * disagree between hosts — under `tr`, `I` lowercases to `ı` — so one browser
 * would silently discard a Preset another browser considers distinct.
 */
test("Preset name folding does not depend on the host locale", () => {
  const configuration = createConfiguration();
  const first = savePreset([], "Ionian", configuration);
  const second = savePreset(first.presets, "IONIAN", configuration);

  assert.equal(second.presets.length, 1);
  assert.equal(second.preset.id, first.preset.id);
  assert.equal(
    createSavedPresets([
      { id: "preset-abc-1", name: "Ionian", configuration: {} },
      { id: "preset-def-2", name: "ıonian", configuration: {} },
    ]).length,
    2,
    "Expected a dotless ı to be a different name from an ASCII I",
  );
});

test("malformed saved Presets are discarded or repaired on load", () => {
  const loaded = createSavedPresets([
    null,
    { name: "" },
    { name: "4/4", configuration: { bpm: 140 } },
    {
      id: '"><script>bad()</script>',
      name: "Stored",
      configuration: { bpm: 9999, sequence: { cycles: [] } },
    },
  ]);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "Stored");
  assert.match(loaded[0].id, /^preset-[0-9a-z]+-[0-9a-z]+$/);
  assert.equal(loaded[0].configuration.bpm, 300);
  assert.equal(loaded[0].configuration.sequence.cycles.length, 1);
});

/**
 * Storage can hold two entries under one name, and the later snapshot replaces
 * the earlier one. Replacing a Preset is not a collision with it, so the
 * survivor keeps the identity the interface is already addressing it by; a
 * regenerated one would move on every load, none of which is a write.
 */
test("a repeated Preset name keeps the identity of the entry it replaces", () => {
  const stored = [
    { id: "preset-abc-1", name: "Warmup", configuration: { bpm: 100 } },
    { id: "preset-abc-1", name: "Warmup", configuration: { bpm: 140 } },
  ];

  const loaded = createSavedPresets(stored);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "preset-abc-1");
  assert.equal(loaded[0].configuration.bpm, 140);
  assert.equal(createSavedPresets(stored)[0].id, "preset-abc-1");
});

test("Presets sharing an identifier under different names are given separate ones", () => {
  const loaded = createSavedPresets([
    { id: "preset-abc-1", name: "One", configuration: {} },
    { id: "preset-abc-1", name: "Two", configuration: {} },
  ]);

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, "preset-abc-1");
  assert.match(loaded[1].id, /^preset-[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(loaded[0].id, loaded[1].id);
});

test("describing Presets identifies exact snapshots without comparing identifiers", () => {
  const original = createConfiguration({ bpm: 137 });
  const saved = savePreset([], "Odd IDs", original);
  const reidentified = createConfiguration(withoutIds(original));
  const descriptions = describePresets(reidentified, saved.presets);

  assert.equal(descriptions.length, 3);
  assert.equal(descriptions.find(({ name }) => name === "Odd IDs").selected, true);
  assert.equal(descriptions.find(({ name }) => name === "4/4").selected, false);
});

/**
 * Repair belongs at the door. `describePresets` runs on every render, so
 * repeating it there rebuilt every stored Configuration to reach the answer it
 * had already been given.
 */
test("describing Presets trusts the Presets createSavedPresets has repaired", () => {
  const presets = createSavedPresets([{ name: "Stored", configuration: { bpm: 5000 } }]);
  assert.equal(presets[0].configuration.bpm, 300);

  const described = describePresets(createConfiguration(), presets);

  assert.equal(described.at(-1).name, "Stored");
  assert.equal(described.at(-1).configuration, presets[0].configuration);
});

test("built-in Preset descriptions are the same Configurations every time", () => {
  const first = describePresets(createConfiguration(), []);
  const second = describePresets(createConfiguration({ bpm: 200 }), []);

  assert.equal(first[0].configuration, second[0].configuration);
  assert.equal(first[0].selected, true);
  assert.equal(second[0].selected, false);
});

test("applying a saved Preset restores its snapshot with fresh identifiers", () => {
  const snapshot = createConfiguration({
    bpm: 137,
    sequence: { cycles: [{ rhythms: [{ sound: "wood", pan: -1 }] }] },
  });
  const current = createConfiguration({ bpm: 88 });
  const result = changeConfiguration(current, {
    type: "apply-preset",
    configuration: snapshot,
  });

  assert.equal(result.consequence, "restart-transport-run");
  assert.equal(result.reason, null);
  assert.deepEqual(withoutIds(result.configuration), withoutIds(snapshot));
  assert.notEqual(
    result.configuration.sequence.cycles[0].id,
    snapshot.sequence.cycles[0].id,
  );
  assert.notEqual(
    result.configuration.sequence.cycles[0].rhythms[0].id,
    snapshot.sequence.cycles[0].rhythms[0].id,
  );
});

test("deleting a saved Preset leaves the current Configuration alone", () => {
  const configuration = createConfiguration({ bpm: 101 });
  const saved = savePreset([], "Delete me", configuration);
  const result = removeSavedPreset(saved.presets, saved.preset.id);

  assert.deepEqual(result, { presets: [], reason: null });
  assert.equal(configuration.bpm, 101);
  assert.deepEqual(
    removeSavedPreset(result.presets, saved.preset.id),
    { presets: [], reason: "preset-not-found" },
  );
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

  assert.deepEqual(result.configuration, configuration);
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
  assert.deepEqual(rejected.configuration, one);
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
  assert.deepEqual(finalOff.configuration, firstOff.configuration);
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
  assert.deepEqual(rejected.configuration, one);
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

test("advancing a Step level cycles the levels and preserves the transport run", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  let current = configuration;

  for (const expected of ["half", "quarter", "off", "full"]) {
    const result = changeConfiguration(current, {
      type: "advance-step-level",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      position: 0,
    });

    assert.equal(result.configuration.sequence.cycles[0].rhythms[0].steps[0], expected);
    assert.equal(result.consequence, "update-step-levels");
    current = result.configuration;
  }
});

test("Step-level positions outside the meter-relative grid are rejected", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const outside = [rhythm.steps.length, rhythm.steps.length + 1, 4096];

  for (const position of outside) {
    const result = changeConfiguration(configuration, {
      type: "advance-step-level",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      position,
    });

    assert.equal(result.consequence, "none");
    assert.equal(result.reason, "pattern-position-not-found");
    assert.deepEqual(result.configuration, configuration);
  }
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

test("structural edit availability agrees with final Cycle and Rhythm enforcement", () => {
  const single = createConfiguration();
  const onlyCycle = single.sequence.cycles[0];
  const onlyRhythm = onlyCycle.rhythms[0];
  const singleAvailability = describeConfiguration(single).availability;

  const finalCycleRemoval = changeConfiguration(single, {
    type: "remove-cycle",
    cycleId: onlyCycle.id,
  });
  assert.deepEqual(singleAvailability.cycles[onlyCycle.id].remove, {
    available: false,
    reason: finalCycleRemoval.reason,
  });

  const finalRhythmRemoval = changeConfiguration(single, {
    type: "remove-rhythm",
    cycleId: onlyCycle.id,
    rhythmId: onlyRhythm.id,
  });
  assert.deepEqual(
    singleAvailability.cycles[onlyCycle.id].rhythms[onlyRhythm.id].remove,
    { available: false, reason: finalRhythmRemoval.reason },
  );

  const twoCycles = changeConfiguration(single, { type: "add-cycle" }).configuration;
  const [activeCycle, inactiveCycle] = twoCycles.sequence.cycles;
  const withInactiveCycle = changeConfiguration(twoCycles, {
    type: "set-cycle-repetitions",
    cycleId: inactiveCycle.id,
    repetitions: 0,
  }).configuration;
  const finalActiveRemoval = changeConfiguration(withInactiveCycle, {
    type: "remove-cycle",
    cycleId: activeCycle.id,
  });

  assert.deepEqual(
    describeConfiguration(withInactiveCycle).availability.cycles[activeCycle.id].remove,
    { available: false, reason: finalActiveRemoval.reason },
  );
});

test("the global Rhythm limit controls both structural additions", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [{ rhythms: Array.from({ length: 12 }, () => ({})) }],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const description = describeConfiguration(configuration);

  for (const [availability, edit] of [
    [description.availability.addCycle, { type: "add-cycle" }],
    [
      description.availability.cycles[cycle.id].addRhythm,
      { type: "add-rhythm", cycleId: cycle.id },
    ],
  ]) {
    const result = changeConfiguration(configuration, edit);
    assert.deepEqual(availability, {
      available: false,
      reason: result.reason,
    });
    assert.deepEqual(result.configuration, configuration);
  }
});

test("Cycle-repetition availability agrees with every offered edit", () => {
  const single = createConfiguration();
  const secondCycle = changeConfiguration(single, { type: "add-cycle" }).configuration;
  const [first, second] = secondCycle.sequence.cycles;
  const scenarios = [
    [single, single.sequence.cycles[0]],
    [secondCycle, first],
    [
      changeConfiguration(secondCycle, {
        type: "set-cycle-repetitions",
        cycleId: first.id,
        repetitions: 0,
      }).configuration,
      second,
    ],
  ];

  for (const [configuration, cycle] of scenarios) {
    const description = describeConfiguration(configuration);
    for (const repetitions of description.choices.repetitions) {
      const offered = description.availability.cycles[cycle.id]
        .repetitions[repetitions];
      const result = changeConfiguration(configuration, {
        type: "set-cycle-repetitions",
        cycleId: cycle.id,
        repetitions,
      });

      if (!offered.available) {
        assert.deepEqual(result.configuration, configuration);
        assert.equal(result.consequence, "none");
        assert.equal(result.reason, offered.reason);
      } else if (repetitions === cycle.repetitions) {
        assert.deepEqual(result.configuration, configuration);
        assert.equal(result.consequence, "none");
        assert.equal(result.reason, null);
      } else {
        assert.notStrictEqual(result.configuration, configuration);
        assert.equal(result.consequence, "restart-transport-run");
        assert.equal(result.reason, null);
        assert.equal(
          result.configuration.sequence.cycles
            .find((candidate) => candidate.id === cycle.id)
            .repetitions,
          repetitions,
        );
      }
    }
  }
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

test("identifiers that were not generated are replaced during repair", () => {
  const generatedShape = /^(?:cycle|layer)-[0-9a-z]+-[0-9a-z]+$/;
  const configuration = createConfiguration({
    sequence: {
      cycles: [{
        id: '"><img src=x onerror=alert(1)>',
        rhythms: [{ id: '"><script>x()</script>' }],
      }],
    },
  });
  const cycle = configuration.sequence.cycles[0];

  assert.notEqual(cycle.id, '"><img src=x onerror=alert(1)>');
  assert.notEqual(cycle.rhythms[0].id, '"><script>x()</script>');
  assert.match(cycle.id, generatedShape);
  assert.match(cycle.rhythms[0].id, generatedShape);
});

test("an edit replaces identifiers the module did not issue", () => {
  const configuration = createConfiguration();
  const [cycle] = configuration.sequence.cycles;
  const forged = {
    ...configuration,
    sequence: {
      cycles: [{ ...cycle, id: '"><img src=x onerror=alert(1)>' }],
    },
  };
  const result = changeConfiguration(forged, { type: "set-tempo", bpm: "96" });

  assert.strictEqual(result.consequence, "none");
  assert.notStrictEqual(result.configuration, forged);
  assert.match(
    result.configuration.sequence.cycles[0].id,
    /^cycle-[0-9a-z]+-[0-9a-z]+$/,
  );
});

test("generated identifiers survive repeated Configuration repair", () => {
  const stored = {
    sequence: {
      cycles: [{
        id: "cycle-abc123-7",
        repetitions: 1,
        rhythms: [{ id: "layer-abc123-8" }],
      }],
    },
  };
  const configuration = createConfiguration(stored);
  const cycle = configuration.sequence.cycles[0];

  assert.equal(cycle.id, "cycle-abc123-7");
  assert.equal(cycle.rhythms[0].id, "layer-abc123-8");

  const repaired = createConfiguration(configuration);
  assert.equal(repaired.sequence.cycles[0].id, "cycle-abc123-7");
  assert.equal(repaired.sequence.cycles[0].rhythms[0].id, "layer-abc123-8");
});

test("duplicate generated identifiers are still de-duplicated", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        { id: "cycle-abc123-1", rhythms: [{ id: "layer-abc123-1" }] },
        { id: "cycle-abc123-1", rhythms: [{ id: "layer-abc123-1" }] },
      ],
    },
  });
  const ids = configuration.sequence.cycles.flatMap((cycle) => [
    cycle.id,
    ...cycle.rhythms.map((rhythm) => rhythm.id),
  ]);

  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});

test("every edit outcome returns a repaired Configuration", () => {
  const stored = {
    bpm: 9999,
    masterVolume: 0.8,
    sequence: {
      cycles: [{
        id: "cycle-stored-1",
        repetitions: 7,
        rhythms: [{ id: "layer-stored-1", signature: { count: 99, unit: 4 } }],
      }],
    },
  };
  const repaired = createConfiguration(stored);
  assert.equal(repaired.bpm, 300);
  assert.equal(repaired.sequence.cycles[0].repetitions, 1);
  assert.equal(repaired.sequence.cycles[0].rhythms[0].signature.count, 32);

  const outcomes = [
    [
      { type: "remove-cycle", cycleId: "cycle-stored-1" },
      "sequence-requires-cycle",
    ],
    [{ type: "set-tempo", bpm: 9999 }, "invalid-value"],
    [{ type: "set-tempo", bpm: 300 }, null],
  ];

  for (const [edit, reason] of outcomes) {
    const result = changeConfiguration(stored, edit);
    assert.equal(result.consequence, "none");
    assert.equal(result.reason, reason);
    assert.deepEqual(result.configuration, repaired);
    assert.notStrictEqual(result.configuration, stored);
  }
});

/**
 * `changeConfiguration` repairs before it dispatches, so even an edit that
 * changes nothing hands back a new value. Asserting only `deepEqual` would
 * pass under a design that returned the caller's object when it was already
 * valid, which is what the module used to do; pin the reference too.
 */
test("a no-op edit on an already-valid Configuration still returns a fresh object", () => {
  const configuration = createConfiguration();
  const result = changeConfiguration(configuration, {
    type: "set-tempo",
    bpm: String(configuration.bpm),
  });

  assert.equal(result.consequence, "none");
  assert.deepEqual(result.configuration, configuration);
  assert.notStrictEqual(result.configuration, configuration);
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
    { type: "apply-preset" },
    { type: "apply-preset", name: "4/4", configuration },
    { type: "apply-preset", configuration: null },
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
    assert.deepEqual(result.configuration, configuration);
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
    assert.deepEqual(result.configuration, configuration);
    assert.equal(result.consequence, "none");
    assert.equal(result.reason, null);
  }
});

test("a Cycle stored without Rhythm layers is repaired rather than dropped", () => {
  const configuration = createConfiguration({
    sequence: { cycles: [{ rhythms: [] }, { rhythms: [{}] }] },
  });

  assert.deepEqual(
    configuration.sequence.cycles.map((cycle) => cycle.rhythms.length),
    [1, 1],
  );

  const spentBudget = createConfiguration({
    sequence: {
      cycles: [
        { rhythms: Array.from({ length: 12 }, () => ({})) },
        { rhythms: [] },
      ],
    },
  });

  assert.equal(spentBudget.sequence.cycles.length, 1);
  assert.equal(
    spentBudget.sequence.cycles.flatMap((cycle) => cycle.rhythms).length,
    12,
  );
});

test("repairing a repaired Configuration leaves it unchanged", () => {
  const storedConfigurations = [
    { sequence: { cycles: [{ rhythms: [] }, { rhythms: [{}] }] } },
    {
      sequence: {
        cycles: [
          { rhythms: [] },
          { rhythms: Array.from({ length: 12 }, () => ({})) },
        ],
      },
    },
  ];

  for (const stored of storedConfigurations) {
    const repaired = createConfiguration(stored);
    assert.deepEqual(createConfiguration(repaired), repaired);
  }
});

test("Preset identity ignores the key order of a stored Configuration", () => {
  const configuration = reorderKeys(createConfiguration());

  assert.equal(describeConfiguration(configuration).selectedPreset, "4/4");

  const reapplied = changeConfiguration(configuration, {
    type: "apply-preset",
    name: "4/4",
  });
  assert.deepEqual(reapplied.configuration, configuration);
  assert.equal(reapplied.consequence, "none");
  assert.equal(reapplied.reason, null);
});

test("a Configuration carrying unknown fields is still replaced by a repaired one", () => {
  const configuration = createConfiguration();
  const embellished = {
    ...configuration,
    sequence: {
      cycles: configuration.sequence.cycles.map((cycle) => ({
        ...cycle,
        rhythms: cycle.rhythms.map((rhythm) => ({ ...rhythm, swing: 0.3 })),
      })),
    },
  };
  const result = changeConfiguration(embellished, { type: "set-tempo", bpm: "96" });

  assert.notStrictEqual(result.configuration, embellished);
  assert.equal(
    Object.hasOwn(result.configuration.sequence.cycles[0].rhythms[0], "swing"),
    false,
  );
});

test("stored key order does not change an edit outcome", () => {
  const configuration = reorderKeys(createConfiguration());
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  for (const edit of [
    { type: "set-tempo", bpm: "96" },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: "0" },
    { type: "remove-cycle", cycleId: cycle.id },
  ]) {
    const result = changeConfiguration(configuration, edit);
    assert.deepEqual(result.configuration, configuration);
    assert.equal(result.consequence, "none");
  }
});
