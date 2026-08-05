import test from "node:test";
import assert from "node:assert/strict";

import {
  changeConfiguration,
  createConfiguration,
  createFactoryPresets,
  createSavedPresets,
  createStoredPresets,
  describeConfiguration,
  describePresets,
  presetNameInUse,
  removeSavedPreset,
  sameConfiguration,
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

  assert.equal(configuration.bpm, 120);
  assert.equal(configuration.sequence.cycles.length, 1);
  assert.equal(configuration.sequence.cycles[0].repetitions, 1);
  assert.deepEqual(
    configuration.sequence.cycles[0].rhythms.map((rhythm) => ({
      signature: rhythm.signature,
      subdivision: rhythm.subdivision,
      displayMode: rhythm.displayMode,
      steps: rhythm.steps,
      volume: rhythm.volume,
      pan: rhythm.pan,
      sound: rhythm.sound,
      muted: rhythm.muted,
    })),
    [
      {
        signature: { count: 4, unit: 4 },
        subdivision: 1,
        displayMode: "beat",
        steps: ["primary", "secondary", "secondary", "secondary"],
        volume: 0.7,
        pan: 0,
        sound: "high",
        muted: false,
      },
    ],
  );
});

test("Rhythm-layer display mode defaults and repairs to Beat Mode", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [{ displayMode: "subdivision" }, { displayMode: "unknown" }],
        },
      ],
    },
  });

  assert.deepEqual(
    configuration.sequence.cycles[0].rhythms.map(({ displayMode }) => displayMode),
    ["subdivision", "beat"],
  );
});

/**
 * A Meter or Subdivision edit writes the canonical pattern for the grid it
 * produces, and repair reaches the same grids from storage. Two answers to what
 * the canonical pattern is would make where a Rhythm layer came from decide what
 * it sounds like.
 */
test("repair fills a missing pattern with the same canonical voices an edit writes", () => {
  const repaired = createConfiguration({
    sequence: {
      cycles: [{ rhythms: [{ signature: { count: 2, unit: 4 }, subdivision: 3 }] }],
    },
  });
  const rhythm = repaired.sequence.cycles[0].rhythms[0];
  // The same grid reached by editing rather than by repair, which is the second
  // answer this compares the first against.
  const undivided = createConfiguration({
    sequence: {
      cycles: [{ rhythms: [{ signature: { count: 2, unit: 4 }, subdivision: 1 }] }],
    },
  });
  const edited = changeConfiguration(undivided, {
    type: "set-subdivision",
    cycleId: undivided.sequence.cycles[0].id,
    rhythmId: undivided.sequence.cycles[0].rhythms[0].id,
    subdivision: 3,
  });

  assert.deepEqual(rhythm.steps, [
    "primary",
    "tertiary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
  assert.deepEqual(edited.configuration.sequence.cycles[0].rhythms[0].steps, rhythm.steps);
});

test("repair keeps every voice a stored pattern supplies and fills only the gaps", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              signature: { count: 2, unit: 4 },
              subdivision: 3,
              steps: ["off", "primary"],
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(configuration.sequence.cycles[0].rhythms[0].steps, [
    "off",
    "primary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
});

test("tempo edits return a new Configuration and restart consequence", () => {
  const original = createConfiguration();
  const result = changeConfiguration(original, { type: "set-tempo", bpm: 140 });

  assert.equal(result.configuration.bpm, 140);
  assert.equal(original.bpm, 120);
  assert.equal(result.consequence, "restart-transport-run");
  assert.equal(result.reason, null);
});

test("applying a Preset replaces the complete Configuration", () => {
  const [, example] = createStoredPresets(null);
  const result = changeConfiguration(createConfiguration(), {
    type: "apply-preset",
    configuration: example.configuration,
  });

  assert.equal(result.configuration.bpm, 120);
  assert.deepEqual(
    result.configuration.sequence.cycles[0].rhythms.map((rhythm) => ({
      signature: rhythm.signature,
      subdivision: rhythm.subdivision,
      displayMode: rhythm.displayMode,
      sound: rhythm.sound,
      pan: rhythm.pan,
    })),
    [
      {
        signature: { count: 4, unit: 4 },
        subdivision: 3,
        displayMode: "beat",
        sound: "high",
        pan: 0,
      },
    ],
  );
  assert.equal(result.consequence, "restart-transport-run");
  assert.equal(describePresets(result.configuration, [example])[0].selected, true);
});

test("saving and loading a named Preset preserves the complete Configuration", () => {
  const configuration = createConfiguration({
    bpm: 173,
    masterVolume: 0.43,
    sequence: {
      cycles: [
        {
          repetitions: 2,
          rhythms: [
            {
              signature: { count: 5, unit: 8 },
              subdivision: 3,
              displayMode: "subdivision",
              steps: ["primary", "off", "tertiary", "secondary", "primary"],
              sound: "wood",
              volume: 0.31,
              pan: -0.62,
              muted: true,
            },
          ],
        },
        {
          repetitions: 1,
          rhythms: [
            {
              signature: { count: 7, unit: 4 },
              subdivision: 2,
              sound: "low",
              volume: 0.91,
              pan: 0.77,
            },
          ],
        },
      ],
    },
  });
  assert.equal(configuration.sequence.cycles[0].rhythms[0].displayMode, "subdivision");

  const saved = savePreset([], "  Clave practice  ", configuration);
  assert.equal(saved.reason, null);
  assert.equal(saved.preset.name, "Clave practice");
  assert.deepEqual(saved.preset.configuration, configuration);

  const loaded = createSavedPresets(JSON.parse(JSON.stringify(saved.presets)));
  assert.deepEqual(loaded, saved.presets);
});

test("saving an existing Preset name replaces its snapshot case-insensitively", () => {
  const first = savePreset([], "Warmup", createConfiguration({ bpm: 80 }));
  const replacement = savePreset(first.presets, "WARMUP", createConfiguration({ bpm: 140 }));

  assert.equal(replacement.reason, null);
  assert.equal(replacement.presets.length, 1);
  assert.equal(replacement.preset.id, first.preset.id);
  assert.equal(replacement.preset.name, "WARMUP");
  assert.equal(replacement.preset.configuration.bpm, 140);
});

test("saved Preset names cannot be empty or oversized", () => {
  const configuration = createConfiguration();
  for (const name of ["   ", "x".repeat(81)]) {
    const result = savePreset([], name, configuration);
    assert.deepEqual(result.presets, []);
    assert.equal(result.reason, "invalid-preset-name");
  }

  // The longest accepted name, checked beside the shortest rejected one: a limit
  // is only pinned from both sides.
  const longest = savePreset([], "x".repeat(80), configuration);
  assert.equal(longest.reason, null);
  assert.equal(longest.preset.name, "x".repeat(80));
});

/**
 * An example's name was refused while the examples were not stored Presets and
 * a save under one of them would have been shadowed. They are stored now, so the
 * name is the listener's to take, delete, and take again.
 */
test("a name an example Preset holds saves like any other", () => {
  const configuration = createConfiguration({ bpm: 155 });

  for (const name of ["4/4 8ths", "  4/4 Triplets  "]) {
    const result = savePreset([], name, configuration);
    assert.equal(result.reason, null);
    assert.equal(result.preset.name, name.trim());
    assert.equal(result.presets.length, 1);
    assert.equal(result.presets[0].configuration.bpm, 155);
  }
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

/**
 * The examples are Presets a first run writes, not a kind of Preset. A key this
 * browser has never written is the only input that produces them, and they
 * arrive through the same repair as anything else in storage, so they carry
 * generated identifiers rather than ones derived from their names.
 */
test("a Preset key that was never written seeds the example Presets", () => {
  const presets = createStoredPresets(null);

  assert.deepEqual(
    presets.map(({ name }) => name),
    ["4/4 8ths", "4/4 Triplets"],
  );
  for (const { id } of presets) assert.match(id, /^preset-[0-9a-z]+-[0-9a-z]+$/);
  assert.deepEqual(
    presets.map(({ configuration }) => ({
      bpm: configuration.bpm,
      subdivision: configuration.sequence.cycles[0].rhythms[0].subdivision,
      displayMode: configuration.sequence.cycles[0].rhythms[0].displayMode,
    })),
    [
      { bpm: 120, subdivision: 2, displayMode: "beat" },
      { bpm: 120, subdivision: 3, displayMode: "beat" },
    ],
  );
});

test("factory Presets are fresh repaired copies of the seeded definitions", () => {
  const first = createFactoryPresets();
  const second = createFactoryPresets();

  assert.deepEqual(
    first.map(({ name, configuration }) => ({ name, configuration: withoutIds(configuration) })),
    second.map(({ name, configuration }) => ({ name, configuration: withoutIds(configuration) })),
  );
  assert.notEqual(first[0].id, second[0].id);
  assert.notEqual(
    first[0].configuration.sequence.cycles[0].id,
    second[0].configuration.sequence.cycles[0].id,
  );
});

/**
 * Deleting the last Preset writes an empty list, which is a key that was
 * written. Seeding it again would put back the examples the listener had just
 * removed, so the only question this asks is whether the key has ever been
 * written, never whether it holds anything.
 */
test("a written Preset key is repaired without seeding, empty or not", () => {
  assert.deepEqual(createStoredPresets("[]"), []);

  const loaded = createStoredPresets(
    JSON.stringify([{ id: "preset-abc-1", name: "Stored", configuration: { bpm: 9999 } }]),
  );

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "preset-abc-1");
  assert.equal(loaded[0].name, "Stored");
  assert.equal(loaded[0].configuration.bpm, 300);
});

/**
 * Unreadable storage is still storage that was written, so it is emptied rather
 * than seeded. Anything that is neither the raw string nor the absent key never
 * came from storage at all, which makes it the caller's bug.
 */
test("unreadable stored Presets are emptied, and a non-string is a programmer error", () => {
  assert.deepEqual(createStoredPresets("{not json"), []);
  assert.deepEqual(createStoredPresets('"a string"'), []);

  for (const stored of [undefined, [], {}, 4]) {
    assert.throws(() => createStoredPresets(stored), {
      name: "TypeError",
      message: "Stored Presets must be the stored string or null",
    });
  }
});

/**
 * The example Presets are stored Presets like any other, so a name one of them
 * happens to hold is not a name storage may not use. Discarding it silently lost
 * whatever the listener had saved under it.
 */
test("a stored Preset named after an example survives load", () => {
  const loaded = createSavedPresets([{ name: "4/4", configuration: { bpm: 140 } }]);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "4/4");
  assert.equal(loaded[0].configuration.bpm, 140);
});

test("malformed saved Presets are discarded or repaired on load", () => {
  const loaded = createSavedPresets([
    null,
    { name: "" },
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

  assert.equal(descriptions.length, 1);
  assert.equal(descriptions[0].selected, true);
  assert.equal(describePresets(createConfiguration({ bpm: 96 }), saved.presets)[0].selected, false);
});

/**
 * Every Preset is a stored Preset, so a description is the stored list with the
 * selection marked and nothing else. No member says a card may not be deleted,
 * because there is no longer a Preset that may not be.
 */
test("describing Presets describes the stored list alone", () => {
  const saved = savePreset([], "Only", createConfiguration()).presets;
  const described = describePresets(createConfiguration(), saved);

  assert.deepEqual(
    described.map(({ name }) => name),
    ["Only"],
  );
  assert.equal(Object.hasOwn(described[0], "builtIn"), false);
  assert.deepEqual(describePresets(createConfiguration(), []), []);
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
  assert.notEqual(result.configuration.sequence.cycles[0].id, snapshot.sequence.cycles[0].id);
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
  assert.deepEqual(removeSavedPreset(result.presets, saved.preset.id), {
    presets: [],
    reason: "preset-not-found",
  });
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

test("Meter and Subdivision edits reset the meter-relative grid to canonical voices", () => {
  const base = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              signature: { count: 2, unit: 4 },
              subdivision: 2,
              steps: ["primary", "off", "secondary", "primary"],
            },
          ],
        },
      ],
    },
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
    "primary",
    "tertiary",
    "secondary",
    "tertiary",
    "secondary",
    "tertiary",
  ]);
  assert.equal(wider.consequence, "restart-transport-run");
  const simpler = changeConfiguration(wider.configuration, {
    type: "set-subdivision",
    cycleId,
    rhythmId,
    subdivision: 1,
  });
  assert.deepEqual(simpler.configuration.sequence.cycles[0].rhythms[0].steps, [
    "primary",
    "secondary",
    "secondary",
  ]);
  assert.equal(simpler.consequence, "restart-transport-run");
});

test("a conventional Meter denominator edit preserves the grid and transport run", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              signature: { count: 2, unit: 4 },
              subdivision: 2,
              steps: ["primary", "off", "tertiary", "secondary"],
            },
          ],
        },
      ],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  const result = changeConfiguration(configuration, {
    type: "set-meter-unit",
    cycleId: cycle.id,
    rhythmId: rhythm.id,
    unit: 8,
  });

  assert.deepEqual(result.configuration.sequence.cycles[0].rhythms[0], {
    ...rhythm,
    signature: { count: 2, unit: 8 },
  });
  assert.equal(result.consequence, "update-configuration");
});

test("advancing a Step voice cycles the four voices and preserves the transport run", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  let current = configuration;

  for (const expected of ["secondary", "tertiary", "off", "primary"]) {
    const result = changeConfiguration(current, {
      type: "advance-control-voice",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      control: 0,
    });

    assert.equal(result.configuration.sequence.cycles[0].rhythms[0].steps[0], expected);
    assert.equal(result.consequence, "update-step-voices");
    current = result.configuration;
  }
});

test("changing a Rhythm layer to Subdivision Mode resets its Step voices without restarting", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              subdivision: 3,
              steps: ["primary", "off", "secondary", "tertiary"],
            },
          ],
        },
      ],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  const result = changeConfiguration(configuration, {
    type: "set-display-mode",
    cycleId: cycle.id,
    rhythmId: rhythm.id,
    displayMode: "subdivision",
  });

  assert.equal(result.configuration.sequence.cycles[0].rhythms[0].displayMode, "subdivision");
  assert.deepEqual(result.configuration.sequence.cycles[0].rhythms[0].steps, [
    "primary",
    "tertiary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
  assert.equal(result.consequence, "update-step-voices");
  assert.equal(result.reason, null);
  assert.equal(sameConfiguration(result.configuration, configuration), false);
});

test("changing a Rhythm layer to Beat Mode also resets its Step voices", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              displayMode: "subdivision",
              subdivision: 2,
              steps: ["off", "primary", "tertiary", "off"],
            },
          ],
        },
      ],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  const result = changeConfiguration(configuration, {
    type: "set-display-mode",
    cycleId: cycle.id,
    rhythmId: rhythm.id,
    displayMode: "beat",
  });

  assert.equal(result.configuration.sequence.cycles[0].rhythms[0].displayMode, "beat");
  assert.deepEqual(result.configuration.sequence.cycles[0].rhythms[0].steps, [
    "primary",
    "tertiary",
    "secondary",
    "tertiary",
    "secondary",
    "tertiary",
    "secondary",
    "tertiary",
  ]);
  assert.equal(result.consequence, "update-step-voices");
  assert.equal(result.reason, null);
});

test("advancing a Beat voice normalises its remaining subdivision pulses", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              signature: { count: 2, unit: 4 },
              subdivision: 3,
              steps: ["primary", "off", "secondary", "off", "primary", "secondary"],
            },
          ],
        },
      ],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  const result = changeConfiguration(configuration, {
    type: "advance-control-voice",
    cycleId: cycle.id,
    rhythmId: rhythm.id,
    control: 0,
  });

  assert.deepEqual(result.configuration.sequence.cycles[0].rhythms[0].steps, [
    "secondary",
    "tertiary",
    "tertiary",
    "off",
    "primary",
    "secondary",
  ]);
  assert.equal(result.consequence, "update-step-voices");
});

/**
 * In Beat Mode a control runs the whole signature unit, so its voice has to be
 * the voice of every pulse inside it. Only `off` is silent, so a beat advanced
 * to `off` that kept `tertiary` trailing pulses would go on sounding under a
 * control announcing it as off.
 */
test("advancing a Beat voice carries all four voices across the whole beat", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [{ signature: { count: 2, unit: 4 }, subdivision: 3 }],
        },
      ],
    },
  });
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  let current = configuration;

  for (const expected of [
    ["secondary", "tertiary", "tertiary"],
    ["tertiary", "tertiary", "tertiary"],
    ["off", "off", "off"],
    ["primary", "tertiary", "tertiary"],
  ]) {
    const result = changeConfiguration(current, {
      type: "advance-control-voice",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      control: 0,
    });

    assert.deepEqual(
      result.configuration.sequence.cycles[0].rhythms[0].steps.slice(0, 3),
      expected,
    );
    assert.equal(result.consequence, "update-step-voices");
    current = result.configuration;
  }
});

test("repair rejects inherited object names as Step voices", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [
        {
          rhythms: [
            {
              signature: { count: 3, unit: 4 },
              steps: ["constructor", "toString", "__proto__"],
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(configuration.sequence.cycles[0].rhythms[0].steps, [
    "secondary",
    "secondary",
    "secondary",
  ]);
});

/**
 * A control is refused at the count of controls its own Display mode offers,
 * which is the Meter's numerator in Beat Mode and the grid's length in
 * Subdivision Mode. At any Subdivision above one the two differ, and taking the
 * wider of them in Beat Mode would let a control past the end of the Meter
 * rewrite the pulses of a beat inside it.
 */
test("controls outside the Display mode's own count are rejected", () => {
  const configuration = createConfiguration({
    sequence: {
      cycles: [{ rhythms: [{ signature: { count: 2, unit: 4 }, subdivision: 3 }] }],
    },
  });
  const cycle = configuration.sequence.cycles[0];

  for (const [displayMode, offered] of [
    ["beat", 2],
    ["subdivision", 6],
  ]) {
    const { configuration: current } = changeConfiguration(configuration, {
      type: "set-display-mode",
      cycleId: cycle.id,
      rhythmId: cycle.rhythms[0].id,
      displayMode,
    });

    for (const control of [offered, offered + 1, 4096]) {
      const result = changeConfiguration(current, {
        type: "advance-control-voice",
        cycleId: cycle.id,
        rhythmId: current.sequence.cycles[0].rhythms[0].id,
        control,
      });

      assert.equal(result.consequence, "none");
      assert.equal(result.reason, "control-not-found");
      assert.deepEqual(result.configuration, current);
    }
  }
});

/**
 * One edit for both Display modes, so what a press means has to come from the
 * layer rather than the payload. The same `control: 1` addresses the second
 * signature unit in Beat Mode and the second pattern position in Subdivision
 * Mode, and nothing in the edit says which.
 */
test("the same control edit addresses a beat or a position, per the layer's mode", () => {
  const base = createConfiguration({
    sequence: {
      cycles: [{ rhythms: [{ signature: { count: 2, unit: 4 }, subdivision: 3 }] }],
    },
  });
  const cycle = base.sequence.cycles[0];
  const advance = (configuration) =>
    changeConfiguration(configuration, {
      type: "advance-control-voice",
      cycleId: cycle.id,
      rhythmId: configuration.sequence.cycles[0].rhythms[0].id,
      control: 1,
    }).configuration.sequence.cycles[0].rhythms[0].steps;

  assert.deepEqual(advance(base), [
    "primary",
    "tertiary",
    "tertiary",
    "tertiary",
    "tertiary",
    "tertiary",
  ]);

  const { configuration: subdivided } = changeConfiguration(base, {
    type: "set-display-mode",
    cycleId: cycle.id,
    rhythmId: cycle.rhythms[0].id,
    displayMode: "subdivision",
  });

  assert.deepEqual(advance(subdivided), [
    "primary",
    "off",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
});

test("sound and mix edits preserve transport position and all affect Preset identity", () => {
  const base = createConfiguration();
  const [example] = createSavedPresets([{ name: "Baseline", configuration: base }]);
  const cycle = base.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const edits = [
    { type: "set-sound", cycleId: cycle.id, rhythmId: rhythm.id, sound: "wood" },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id, volume: 0.4 },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: -1 },
    { type: "set-muted", cycleId: cycle.id, rhythmId: rhythm.id, muted: true },
  ];

  for (const edit of edits) {
    const result = changeConfiguration(base, edit);
    assert.equal(result.consequence, "update-mix");
    assert.equal(describePresets(result.configuration, [example])[0].selected, false);
  }
  assert.equal(describePresets(base, [example])[0].selected, true);
});

test("Configuration description exposes domain choices and unavailable final removals", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const description = describeConfiguration(configuration);

  assert.deepEqual(description.choices, {
    meterCounts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    meterUnits: [1, 2, 4, 8],
    subdivisions: [1, 2, 3, 4, 5],
    sounds: ["high", "low", "wood"],
    stepVoices: ["off", "tertiary", "secondary", "primary"],
    repetitions: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  });
  // Which Preset a Configuration matches is a question about the stored list,
  // which this never sees; `describePresets` is what answers it.
  assert.equal(Object.hasOwn(description, "selectedPreset"), false);
  assert.deepEqual(description.availability.cycles[cycle.id].remove, {
    available: false,
    reason: "sequence-requires-cycle",
  });
  assert.deepEqual(description.availability.cycles[cycle.id].repetitions[0], {
    available: false,
    reason: "single-cycle-requires-one-repetition",
  });
  assert.deepEqual(description.availability.cycles[cycle.id].rhythms[rhythm.id].remove, {
    available: false,
    reason: "cycle-requires-rhythm",
  });
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
  assert.deepEqual(singleAvailability.cycles[onlyCycle.id].rhythms[onlyRhythm.id].remove, {
    available: false,
    reason: finalRhythmRemoval.reason,
  });

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
      const offered = description.availability.cycles[cycle.id].repetitions[repetitions];
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
          result.configuration.sequence.cycles.find((candidate) => candidate.id === cycle.id)
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
    sequence: {
      cycles: [
        { repetitions: 99, rhythms: Array.from({ length: 8 }, () => ({})) },
        { repetitions: -4, rhythms: Array.from({ length: 8 }, () => ({})) },
      ],
    },
  });

  assert.equal(configuration.bpm, 300);
  assert.deepEqual(
    configuration.sequence.cycles.map((cycle) => cycle.repetitions),
    [8, 0],
  );
  assert.equal(configuration.sequence.cycles.flatMap((cycle) => cycle.rhythms).length, 12);

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
      cycles: [
        {
          id: '"><img src=x onerror=alert(1)>',
          rhythms: [{ id: '"><script>x()</script>' }],
        },
      ],
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
  const result = changeConfiguration(forged, { type: "set-tempo", bpm: "120" });

  assert.strictEqual(result.consequence, "none");
  assert.notStrictEqual(result.configuration, forged);
  assert.match(result.configuration.sequence.cycles[0].id, /^cycle-[0-9a-z]+-[0-9a-z]+$/);
});

test("generated identifiers survive repeated Configuration repair", () => {
  const stored = {
    sequence: {
      cycles: [
        {
          id: "cycle-abc123-7",
          repetitions: 1,
          rhythms: [{ id: "layer-abc123-8" }],
        },
      ],
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

test("stored Meter denominators accept offered units and repair other values", () => {
  const units = [8, 3, 0, 2.5, "nope", 16].map(
    (unit) =>
      createConfiguration({
        sequence: { cycles: [{ rhythms: [{ signature: { count: 4, unit } }] }] },
      }).sequence.cycles[0].rhythms[0].signature.unit,
  );

  assert.deepEqual(units, [8, 4, 4, 4, 4, 4]);
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
    sequence: {
      cycles: [
        {
          id: "cycle-stored-1",
          repetitions: 7,
          rhythms: [{ id: "layer-stored-1", signature: { count: 99, unit: 4 } }],
        },
      ],
    },
  };
  const repaired = createConfiguration(stored);
  assert.equal(repaired.bpm, 300);
  assert.equal(repaired.sequence.cycles[0].repetitions, 1);
  assert.equal(repaired.sequence.cycles[0].rhythms[0].signature.count, 16);

  const outcomes = [
    [{ type: "remove-cycle", cycleId: "cycle-stored-1" }, "sequence-requires-cycle"],
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

  assert.throws(() => changeConfiguration(configuration, {}), {
    name: "TypeError",
    message: "Configuration edit must have a type",
  });
  assert.throws(() => changeConfiguration(configuration, { type: "warp-time" }), {
    name: "TypeError",
    message: "Unknown Configuration edit: warp-time",
  });
});

test("known edits with structurally malformed payloads expose programmer errors", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const malformedEdits = [
    { type: "apply-preset" },
    // A Preset is applied by the Configuration it holds. Naming one is a payload
    // the interface has no way to produce, so it is a bug rather than a miss.
    { type: "apply-preset", name: "4/4" },
    { type: "apply-preset", configuration: null },
    { type: "set-tempo" },
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
    { type: "advance-control-voice", cycleId: cycle.id, rhythmId: rhythm.id },
    { type: "set-display-mode", cycleId: cycle.id, rhythmId: rhythm.id },
  ];

  for (const edit of malformedEdits) {
    assert.throws(() => changeConfiguration(configuration, edit), {
      name: "TypeError",
      message: `Malformed Configuration edit: ${edit.type}`,
    });
  }
});

test("well-formed edits with invalid domain values are unchanged no-ops", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const invalidEdits = [
    { type: "set-tempo", bpm: "not-a-number" },
    { type: "set-tempo", bpm: 301 },
    { type: "set-cycle-repetitions", cycleId: cycle.id, repetitions: 1.5 },
    { type: "set-meter-count", cycleId: cycle.id, rhythmId: rhythm.id, count: 0 },
    { type: "set-meter-unit", cycleId: cycle.id, rhythmId: rhythm.id, unit: 16 },
    { type: "set-subdivision", cycleId: cycle.id, rhythmId: rhythm.id, subdivision: 6 },
    { type: "set-display-mode", cycleId: cycle.id, rhythmId: rhythm.id, displayMode: "notes" },
    { type: "advance-control-voice", cycleId: cycle.id, rhythmId: rhythm.id, control: -1 },
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

test("both Meter components reject invalid committed values consistently", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  for (const [type, property] of [
    ["set-meter-count", "count"],
    ["set-meter-unit", "unit"],
  ]) {
    const values =
      type === "set-meter-count"
        ? ["", "2.5", "not-a-number", "0", "-1", "17"]
        : ["", "2.5", "not-a-number", "0", "-1", "3", "16"];
    for (const value of values) {
      const result = changeConfiguration(configuration, {
        type,
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        [property]: value,
      });

      assert.deepEqual(result.configuration, configuration);
      assert.equal(result.consequence, "none");
      assert.equal(result.reason, "invalid-value");
    }
  }
});

/**
 * Every edit carrying a value from a control parses it the same way, and that
 * way is `Number`, which reads hex, binary, octal and exponent literals. Meter
 * Select controls constrain Meter entry, while Configuration remains strict at
 * its boundary so programmatic callers cannot smuggle alternate numeric syntax
 * into the same edits. The rule is shared, so tempo is here to say so.
 *
 * Surrounding space is not one of these: a pasted value is a plain numeral with
 * something around it, and refusing it would only puzzle whoever pasted it.
 */
test("committed values are plain numerals, not every literal Number reads", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const unit = (value) =>
    changeConfiguration(configuration, {
      type: "set-meter-unit",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      unit: value,
    });

  assert.equal(unit(" 8 ").configuration.sequence.cycles[0].rhythms[0].signature.unit, 8);
  for (const literal of ["0x10", "0b100", "0o10", "1e1", "8.", "+8"]) {
    assert.equal(unit(literal).reason, "invalid-value", `${literal} was accepted`);
  }
  assert.equal(
    changeConfiguration(configuration, { type: "set-tempo", bpm: "0x64" }).reason,
    "invalid-value",
  );
});

test("valid edits that leave every user-editable value unchanged are no-ops", () => {
  const configuration = createConfiguration();
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];
  const sameValueEdits = [
    { type: "apply-preset", configuration: createConfiguration() },
    { type: "set-tempo", bpm: "120" },
    { type: "set-cycle-repetitions", cycleId: cycle.id, repetitions: "1" },
    { type: "set-meter-count", cycleId: cycle.id, rhythmId: rhythm.id, count: "4" },
    { type: "set-meter-unit", cycleId: cycle.id, rhythmId: rhythm.id, unit: "4" },
    { type: "set-subdivision", cycleId: cycle.id, rhythmId: rhythm.id, subdivision: "1" },
    { type: "set-display-mode", cycleId: cycle.id, rhythmId: rhythm.id, displayMode: "beat" },
    { type: "set-rhythm-volume", cycleId: cycle.id, rhythmId: rhythm.id, volume: "0.7" },
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
      cycles: [{ rhythms: Array.from({ length: 12 }, () => ({})) }, { rhythms: [] }],
    },
  });

  assert.equal(spentBudget.sequence.cycles.length, 1);
  assert.equal(spentBudget.sequence.cycles.flatMap((cycle) => cycle.rhythms).length, 12);
});

test("repairing a repaired Configuration leaves it unchanged", () => {
  const storedConfigurations = [
    { sequence: { cycles: [{ rhythms: [] }, { rhythms: [{}] }] } },
    {
      sequence: {
        cycles: [{ rhythms: [] }, { rhythms: Array.from({ length: 12 }, () => ({})) }],
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
  const [example] = createSavedPresets([{ name: "Baseline", configuration }]);

  assert.equal(describePresets(configuration, [example])[0].selected, true);

  const reapplied = changeConfiguration(configuration, {
    type: "apply-preset",
    configuration: example.configuration,
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
  const result = changeConfiguration(embellished, { type: "set-tempo", bpm: "120" });

  assert.notStrictEqual(result.configuration, embellished);
  assert.equal(Object.hasOwn(result.configuration.sequence.cycles[0].rhythms[0], "swing"), false);
});

test("stored key order does not change an edit outcome", () => {
  const configuration = reorderKeys(createConfiguration());
  const cycle = configuration.sequence.cycles[0];
  const rhythm = cycle.rhythms[0];

  for (const edit of [
    { type: "set-tempo", bpm: "120" },
    { type: "set-stereo-position", cycleId: cycle.id, rhythmId: rhythm.id, pan: "0" },
    { type: "remove-cycle", cycleId: cycle.id },
  ]) {
    const result = changeConfiguration(configuration, edit);
    assert.deepEqual(result.configuration, configuration);
    assert.equal(result.consequence, "none");
  }
});

/**
 * The interface labels its save action from this, so it has to agree with what
 * `savePreset` then does. Every case is asserted against both: the answer here
 * and the list that comes back, because a name reported as in use that turns
 * out to add a Preset is the one way this can be wrong and still look right.
 */
test("a name is in use exactly when saving it would replace a preset", () => {
  const configuration = createConfiguration();
  const rehearsal = savePreset(createSavedPresets(), "Rehearsal", configuration).presets;
  // An example Preset is stored, so the question about its name is the same
  // question asked about any other: is it in the list.
  const stored = savePreset(rehearsal, "4/4", configuration).presets;

  const cases = [
    { name: "Rehearsal", inUse: true, because: "the stored name exactly" },
    { name: "rehearsal", inUse: true, because: "case is folded" },
    { name: "  Rehearsal  ", inUse: true, because: "surrounding space is trimmed" },
    { name: "Rehearsal 2", inUse: false, because: "a different name" },
    { name: "", inUse: false, because: "no name at all" },
    { name: "   ", inUse: false, because: "space is not a name" },
    { name: "4/4", inUse: true, because: "a stored example is replaced like any other" },
    { name: "4/4 Triplets", inUse: false, because: "an example this list does not hold" },
  ];

  for (const { name, inUse, because } of cases) {
    assert.equal(presetNameInUse(stored, name), inUse, because);
    const result = savePreset(stored, name, configuration);
    const replaced = result.reason === null && result.presets.length === stored.length;
    assert.equal(replaced, inUse, `saving "${name}" disagreed: ${because}`);
  }
});
