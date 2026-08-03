import {
  METER_COUNT_LIMIT,
  NOTE_UNITS as METER_UNITS,
  normaliseNumber,
  STEP,
  SUBDIVISION_LIMIT,
} from "./model.js";

/**
 * A limit and the choices offered for it are one domain, so the list is built
 * from the limit rather than restated beside it, where the two could drift into
 * offering a choice that repair then clamps away.
 */
function choiceRange({ minimum, maximum }) {
  return Object.freeze(Array.from(
    { length: maximum - minimum + 1 },
    (_, index) => minimum + index,
  ));
}

const STEP_LEVEL_CHOICES = Object.freeze(Object.values(STEP));
const SOUNDS = Object.freeze(["high", "low", "wood"]);
const SUBDIVISIONS = choiceRange(SUBDIVISION_LIMIT);
const REPETITION_LIMIT = Object.freeze({ minimum: 0, maximum: 8 });
const REPETITIONS = choiceRange(REPETITION_LIMIT);
const PRESETS = Object.freeze(["4/4", "4/4 + 3/4"]);
const MAX_PRESET_NAME_LENGTH = 80;
const MAX_RHYTHMS = 12;
const GENERATED_IDENTIFIER = /^(cycle|layer|preset)-[0-9a-z]+-[0-9a-z]+$/;
let identifierSequence = 0;

function makeIdentifier(prefix) {
  identifierSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${identifierSequence.toString(36)}`;
}

/**
 * Identifiers reach this module from persisted storage and leave it for the
 * interface, so only the shape `makeIdentifier` generates is trusted. Anything
 * else is replaced rather than repaired.
 */
function safeIdentifier(candidate, prefix) {
  return typeof candidate === "string"
    && GENERATED_IDENTIFIER.exec(candidate)?.[1] === prefix
    ? candidate
    : makeIdentifier(prefix);
}

function normaliseStep(step) {
  return STEP_LEVEL_CHOICES.includes(step) ? step : STEP.HALF;
}

function resizeSteps(steps, length) {
  const source = Array.isArray(steps) ? steps.map(normaliseStep) : [];
  return Array.from({ length }, (_, index) => (
    source[index] || (index === 0 ? STEP.FULL : STEP.HALF)
  ));
}

function createRhythm(overrides = {}) {
  const signature = {
    count: Math.round(normaliseNumber(
      overrides.signature?.count,
      4,
      METER_COUNT_LIMIT.minimum,
      METER_COUNT_LIMIT.maximum,
    )),
    unit: METER_UNITS.includes(Number(overrides.signature?.unit))
      ? Number(overrides.signature.unit)
      : 4,
  };
  const subdivision = Math.round(normaliseNumber(
    overrides.subdivision,
    1,
    SUBDIVISION_LIMIT.minimum,
    SUBDIVISION_LIMIT.maximum,
  ));
  return {
    id: safeIdentifier(overrides.id, "layer"),
    signature,
    subdivision,
    steps: resizeSteps(overrides.steps, signature.count * subdivision),
    volume: normaliseNumber(overrides.volume, 0.72, 0, 1),
    pan: normaliseNumber(overrides.pan, 0, -1, 1),
    sound: SOUNDS.includes(overrides.sound) ? overrides.sound : "high",
    muted: Boolean(overrides.muted),
  };
}

function createCycle(overrides = {}) {
  const rhythms = Array.isArray(overrides.rhythms)
    ? overrides.rhythms.map((rhythm) => createRhythm(
        rhythm && typeof rhythm === "object" ? rhythm : {},
      ))
    : [];
  return {
    id: safeIdentifier(overrides.id, "cycle"),
    repetitions: Math.round(normaliseNumber(
      overrides.repetitions,
      1,
      REPETITION_LIMIT.minimum,
      REPETITION_LIMIT.maximum,
    )),
    rhythms: rhythms.length ? rhythms : [createRhythm()],
  };
}

function uniqueIdentifiers(cycles) {
  const used = new Set();
  const identifier = (candidate, prefix) => {
    const value = safeIdentifier(candidate, prefix);
    if (!used.has(value)) {
      used.add(value);
      return value;
    }
    const replacement = makeIdentifier(prefix);
    used.add(replacement);
    return replacement;
  };
  return cycles.map((cycle) => ({
    ...cycle,
    id: identifier(cycle.id, "cycle"),
    rhythms: cycle.rhythms.map((rhythm) => ({
      ...rhythm,
      id: identifier(rhythm.id, "layer"),
    })),
  }));
}

/**
 * Malformed input only reaches here from storage, so repair keeps as much of the
 * saved Sequence as the domain allows. A Cycle that arrives without rhythm
 * layers is given the default layer by `createCycle` rather than discarded:
 * a Cycle is a non-empty group, and dropping one silently changes the Sequence
 * the listener saved. The sequence-wide rhythm-layer limit still wins, so a
 * Cycle arriving after the budget is spent is dropped, having no layer left to
 * be repaired with.
 */
export function createConfiguration(input) {
  const source = input && typeof input === "object" ? input : {};
  let remainingRhythms = MAX_RHYTHMS;
  const sourceCycles = Array.isArray(source.sequence?.cycles)
    ? source.sequence.cycles
    : [];
  const cycles = sourceCycles.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || remainingRhythms === 0) {
      return [];
    }
    const rhythms = Array.isArray(candidate.rhythms)
      ? candidate.rhythms.slice(0, remainingRhythms)
      : [];
    const cycle = createCycle({ ...candidate, rhythms });
    remainingRhythms -= cycle.rhythms.length;
    return [cycle];
  });
  const populated = uniqueIdentifiers(cycles.length ? cycles : [createCycle()]);
  const validCycles = populated.length === 1
    ? [{ ...populated[0], repetitions: 1 }]
    : populated.some((cycle) => cycle.repetitions > 0)
      ? populated
      : populated.map((cycle, index) => (
          index === 0 ? { ...cycle, repetitions: 1 } : cycle
        ));

  return {
    bpm: Math.round(normaliseNumber(source.bpm, 96, 30, 300)),
    masterVolume: normaliseNumber(source.masterVolume, 0.8, 0, 1),
    sequence: { cycles: validCycles },
  };
}

function createPresetConfiguration(name) {
  if (name === "4/4 + 3/4") {
    return createConfiguration({
      bpm: 112,
      masterVolume: 0.8,
      sequence: {
        cycles: [{
          repetitions: 1,
          rhythms: [
            { signature: { count: 4, unit: 4 }, sound: "high" },
            { signature: { count: 3, unit: 4 }, sound: "low" },
          ],
        }],
      },
    });
  }
  return createConfiguration();
}

function freshPresetConfiguration(configuration) {
  const repaired = createConfiguration(configuration);
  return createConfiguration({
    ...repaired,
    sequence: {
      cycles: repaired.sequence.cycles.map(({ id: _cycleId, ...cycle }) => ({
        ...cycle,
        rhythms: cycle.rhythms.map(({ id: _rhythmId, ...rhythm }) => rhythm),
      })),
    },
  });
}

/**
 * Configurations are compared value by value rather than serialised, because key
 * insertion order is an accident of how an updater spread its objects and must
 * never decide whether two Configurations describe the same rhythm. Counting
 * fields is enough to reject a candidate carrying one this module never issues,
 * since every field this module does issue is compared below. Only the first
 * argument has to be a repaired Configuration; the second is whatever a caller
 * or storage offers. Identifiers are ignored throughout: the only question asked
 * here is which Preset a Configuration sounds like, and a freshly built Preset
 * carries new identifiers by construction.
 */
function sameFields(repaired, candidate) {
  return Boolean(candidate)
    && typeof candidate === "object"
    && Object.keys(candidate).length === Object.keys(repaired).length;
}

function sameRhythm(rhythm, candidate) {
  return sameFields(rhythm, candidate)
    && sameFields(rhythm.signature, candidate.signature)
    && rhythm.signature.count === candidate.signature.count
    && rhythm.signature.unit === candidate.signature.unit
    && rhythm.subdivision === candidate.subdivision
    && rhythm.volume === candidate.volume
    && rhythm.pan === candidate.pan
    && rhythm.sound === candidate.sound
    && rhythm.muted === candidate.muted
    && Array.isArray(candidate.steps)
    && rhythm.steps.length === candidate.steps.length
    && rhythm.steps.every((step, position) => step === candidate.steps[position]);
}

function sameCycle(cycle, candidate) {
  return sameFields(cycle, candidate)
    && cycle.repetitions === candidate.repetitions
    && Array.isArray(candidate.rhythms)
    && cycle.rhythms.length === candidate.rhythms.length
    && cycle.rhythms.every((rhythm, index) => sameRhythm(
      rhythm,
      candidate.rhythms[index],
    ));
}

function sameConfiguration(configuration, candidate) {
  return sameFields(configuration, candidate)
    && configuration.bpm === candidate.bpm
    && configuration.masterVolume === candidate.masterVolume
    && sameFields(configuration.sequence, candidate.sequence)
    && Array.isArray(candidate.sequence.cycles)
    && configuration.sequence.cycles.length === candidate.sequence.cycles.length
    && configuration.sequence.cycles.every((cycle, index) => sameCycle(
      cycle,
      candidate.sequence.cycles[index],
    ));
}

function selectedPreset(configuration) {
  return PRESETS.find((name) => sameConfiguration(
    createPresetConfiguration(name),
    configuration,
  )) || null;
}

function presetName(candidate) {
  if (typeof candidate !== "string") return null;
  const name = candidate.trim();
  return name && name.length <= MAX_PRESET_NAME_LENGTH ? name : null;
}

/**
 * Deliberately not `toLocaleLowerCase`: a saved store opens on any host, and
 * folding that follows the host's locale would have one browser treat two names
 * as the same Preset and another treat them as two — under `tr`, `I` lowercases
 * to a dotless `ı`. Loading discards an entry whose folded name already exists,
 * so that disagreement loses a Preset rather than merely displaying one oddly.
 */
function normalisedPresetName(candidate) {
  return candidate.toLowerCase();
}

function reservedPresetName(name) {
  return PRESETS.some((builtIn) => (
    normalisedPresetName(builtIn) === normalisedPresetName(name)
  ));
}

function findPresetNamed(presets, name) {
  return presets.findIndex((stored) => (
    normalisedPresetName(stored.name) === normalisedPresetName(name)
  ));
}

/**
 * Saved Presets are storage input, so malformed entries are discarded and
 * malformed Configurations are repaired. Repeated names follow save semantics:
 * the later snapshot replaces the earlier one.
 */
export function createSavedPresets(input) {
  const candidates = Array.isArray(input) ? input : [];
  return candidates.reduce((presets, candidate) => {
    if (!candidate || typeof candidate !== "object") return presets;
    const name = presetName(candidate.name);
    if (!name || reservedPresetName(name)) return presets;

    const candidateId = safeIdentifier(candidate.id, "preset");
    const duplicate = findPresetNamed(presets, name);
    // Sharing an identifier with the entry this one replaces is not a
    // collision: that entry is about to stop existing, and regenerating here
    // would move the surviving Preset's identity on every load.
    const collides = presets.some(({ id }, index) => (
      id === candidateId && index !== duplicate
    ));
    const preset = {
      id: collides ? makeIdentifier("preset") : candidateId,
      name,
      configuration: createConfiguration(candidate.configuration),
    };
    if (duplicate < 0) return [...presets, preset];
    return presets.map((stored, index) => index === duplicate ? preset : stored);
  }, []);
}

export function savePreset(savedPresets, nameCandidate, configuration) {
  if (typeof nameCandidate !== "string") {
    throw new TypeError("Preset name must be a string");
  }
  const presets = createSavedPresets(savedPresets);
  const name = presetName(nameCandidate);
  if (!name) return { presets, preset: null, reason: "invalid-preset-name" };
  if (reservedPresetName(name)) {
    return { presets, preset: null, reason: "preset-name-reserved" };
  }

  const duplicate = presets[findPresetNamed(presets, name)];
  const preset = {
    id: duplicate?.id || makeIdentifier("preset"),
    name,
    configuration: createConfiguration(configuration),
  };
  return {
    presets: duplicate
      ? presets.map((stored) => stored.id === duplicate.id ? preset : stored)
      : [...presets, preset],
    preset,
    reason: null,
  };
}

export function removeSavedPreset(savedPresets, presetId) {
  if (typeof presetId !== "string") {
    throw new TypeError("Preset identifier must be a string");
  }
  const presets = createSavedPresets(savedPresets);
  if (!presets.some(({ id }) => id === presetId)) {
    return { presets, reason: "preset-not-found" };
  }
  return {
    presets: presets.filter(({ id }) => id !== presetId),
    reason: null,
  };
}

/**
 * Built-in Presets never change, so their Configurations are built once. The
 * identifier is derived from the name rather than generated, because it has to
 * survive a reload to be worth addressing a button by.
 */
const BUILT_IN_PRESETS = Object.freeze(PRESETS.map((name) => Object.freeze({
  id: `built-in-${name.replaceAll(/[^0-9a-z]+/gi, "-").toLowerCase()}`,
  name,
  configuration: createPresetConfiguration(name),
})));

/**
 * Runs on every render, so it repairs nothing: `createSavedPresets` is the only
 * door in from storage, and `configuration` is a repaired Configuration the
 * caller is already holding. Repeating either pass here would rebuild every
 * stored Configuration to reach an answer it was handed.
 */
export function describePresets(configuration, savedPresets) {
  const presets = Array.isArray(savedPresets) ? savedPresets : [];
  return [
    ...BUILT_IN_PRESETS.map((preset) => ({
      ...preset,
      builtIn: true,
      selected: sameConfiguration(configuration, preset.configuration),
    })),
    ...presets.map((preset) => ({
      ...preset,
      builtIn: false,
      selected: sameConfiguration(configuration, preset.configuration),
    })),
  ];
}

function availability(available, reason = null) {
  return { available, reason: available ? null : reason };
}

function sequenceRhythmCount(configuration) {
  return configuration.sequence.cycles.reduce(
    (total, cycle) => total + cycle.rhythms.length,
    0,
  );
}

function addStructurePolicy(configuration) {
  return availability(
    sequenceRhythmCount(configuration) < MAX_RHYTHMS,
    "sequence-rhythm-limit",
  );
}

function removeCyclePolicy(configuration, cycle) {
  if (configuration.sequence.cycles.length === 1) {
    return availability(false, "sequence-requires-cycle");
  }
  const activeCycleCount = configuration.sequence.cycles
    .filter((candidate) => candidate.repetitions > 0).length;
  return availability(
    !(cycle.repetitions > 0 && activeCycleCount === 1),
    "sequence-requires-active-cycle",
  );
}

function cycleRepetitionsPolicy(configuration, cycle, repetitions) {
  if (configuration.sequence.cycles.length === 1 && repetitions !== 1) {
    return availability(false, "single-cycle-requires-one-repetition");
  }
  const activeCycleCount = configuration.sequence.cycles
    .filter((candidate) => candidate.repetitions > 0).length;
  return availability(
    !(repetitions === 0 && cycle.repetitions > 0 && activeCycleCount === 1),
    "sequence-requires-active-cycle",
  );
}

function removeRhythmPolicy(cycle) {
  return availability(
    cycle.rhythms.length > 1,
    "cycle-requires-rhythm",
  );
}

export function describeConfiguration(configuration) {
  const valid = createConfiguration(configuration);

  return {
    selectedPreset: selectedPreset(valid),
    choices: {
      presetNames: [...PRESETS],
      meterUnits: [...METER_UNITS],
      subdivisions: [...SUBDIVISIONS],
      sounds: [...SOUNDS],
      stepLevels: [...STEP_LEVEL_CHOICES],
      repetitions: [...REPETITIONS],
    },
    availability: {
      addCycle: addStructurePolicy(valid),
      cycles: Object.fromEntries(valid.sequence.cycles.map((cycle) => [
        cycle.id,
        {
          remove: removeCyclePolicy(valid, cycle),
          addRhythm: addStructurePolicy(valid),
          repetitions: Object.fromEntries(REPETITIONS.map((repetitions) => [
            repetitions,
            cycleRepetitionsPolicy(valid, cycle, repetitions),
          ])),
          rhythms: Object.fromEntries(cycle.rhythms.map((rhythm) => [
            rhythm.id,
            {
              remove: removeRhythmPolicy(cycle),
            },
          ])),
        },
      ])),
    },
  };
}

function changed(configuration, consequence) {
  return { configuration, consequence, reason: null };
}

function editRhythm(current, cycleId, rhythmId, updater) {
  const cycle = current.sequence.cycles.find(({ id }) => id === cycleId);
  if (!cycle) return { reason: "cycle-not-found" };
  if (!cycle.rhythms.some(({ id }) => id === rhythmId)) {
    return { reason: "rhythm-not-found" };
  }
  return {
    configuration: {
      ...current,
      sequence: { cycles: current.sequence.cycles.map((candidate) => (
        candidate.id === cycleId
          ? {
              ...candidate,
              rhythms: candidate.rhythms.map((rhythm) => (
                rhythm.id === rhythmId ? updater(rhythm) : rhythm
              )),
            }
          : candidate
      )) },
    },
  };
}

function nextStepLevel(level) {
  return {
    [STEP.FULL]: STEP.HALF,
    [STEP.HALF]: STEP.QUARTER,
    [STEP.QUARTER]: STEP.OFF,
    [STEP.OFF]: STEP.FULL,
  }[level] || STEP.FULL;
}

function formNumber(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasString(edit, property) {
  return typeof edit[property] === "string";
}

function hasFormNumber(edit, property) {
  return typeof edit[property] === "number"
    || typeof edit[property] === "string";
}

function targetsCycle(edit) {
  return hasString(edit, "cycleId");
}

function targetsRhythm(edit) {
  return targetsCycle(edit) && hasString(edit, "rhythmId");
}

function numberInRange(edit, property, minimum, maximum, integer = false) {
  const value = formNumber(edit[property]);
  return value !== null
    && value >= minimum
    && value <= maximum
    && (!integer || Number.isInteger(value));
}

function findCycle(configuration, cycleId) {
  return configuration.sequence.cycles.find(({ id }) => id === cycleId);
}

function findRhythm(configuration, cycleId, rhythmId) {
  return findCycle(configuration, cycleId)
    ?.rhythms.find(({ id }) => id === rhythmId);
}

function unchanged(configuration, reason = null) {
  return { configuration, consequence: "none", reason };
}

function rejectedByPolicy(configuration, policy) {
  return policy.available ? null : unchanged(configuration, policy.reason);
}

function changeRhythm(current, edit, consequence, updater) {
  const result = editRhythm(
    current,
    edit.cycleId,
    edit.rhythmId,
    updater,
  );
  return result.reason
    ? unchanged(current, result.reason)
    : changed(result.configuration, consequence);
}

const COMMANDS = Object.freeze({
  "add-cycle": {
    validPayload: () => true,
    apply(current, _edit) {
      const rejection = rejectedByPolicy(current, addStructurePolicy(current));
      if (rejection) return rejection;
      return changed({
        ...current,
        sequence: {
          cycles: [...current.sequence.cycles, createCycle()],
        },
      }, "restart-transport-run");
    },
  },
  "add-rhythm": {
    validPayload: targetsCycle,
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const rejection = rejectedByPolicy(current, addStructurePolicy(current));
      if (rejection) return rejection;
      return changed({
        ...current,
        sequence: { cycles: current.sequence.cycles.map((candidate) => (
          candidate.id === edit.cycleId
            ? { ...candidate, rhythms: [...candidate.rhythms, createRhythm()] }
            : candidate
        )) },
      }, "restart-transport-run");
    },
  },
  "advance-step-level": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "position"),
    validValue: (edit) => numberInRange(
      edit,
      "position",
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      const rhythm = findRhythm(current, edit.cycleId, edit.rhythmId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      if (!rhythm) return unchanged(current, "rhythm-not-found");
      const targetPosition = formNumber(edit.position);
      if (targetPosition >= rhythm.steps.length) {
        return unchanged(current, "pattern-position-not-found");
      }
      return changeRhythm(
        current,
        edit,
        "update-step-levels",
        (candidate) => ({
          ...candidate,
          steps: candidate.steps.map((level, position) => (
            position === targetPosition ? nextStepLevel(level) : level
          )),
        }),
      );
    },
  },
  "apply-preset": {
    validPayload: (edit) => (
      (hasString(edit, "name") && !Object.hasOwn(edit, "configuration"))
      || (!Object.hasOwn(edit, "name")
        && edit.configuration
        && typeof edit.configuration === "object")
    ),
    leavesUnchanged: (current, edit) => {
      const preset = hasString(edit, "name")
        ? PRESETS.includes(edit.name) && createPresetConfiguration(edit.name)
        : createConfiguration(edit.configuration);
      return Boolean(preset) && sameConfiguration(current, preset);
    },
    apply(current, edit) {
      if (hasString(edit, "name") && !PRESETS.includes(edit.name)) {
        return unchanged(current, "preset-not-found");
      }
      return changed(
        hasString(edit, "name")
          ? createPresetConfiguration(edit.name)
          : freshPresetConfiguration(edit.configuration),
        "restart-transport-run",
      );
    },
  },
  "remove-cycle": {
    validPayload: targetsCycle,
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const rejection = rejectedByPolicy(
        current,
        removeCyclePolicy(current, cycle),
      );
      if (rejection) return rejection;
      return changed(createConfiguration({
        ...current,
        sequence: {
          cycles: current.sequence.cycles.filter(({ id }) => id !== edit.cycleId),
        },
      }), "restart-transport-run");
    },
  },
  "remove-rhythm": {
    validPayload: targetsRhythm,
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      if (!findRhythm(current, edit.cycleId, edit.rhythmId)) {
        return unchanged(current, "rhythm-not-found");
      }
      const rejection = rejectedByPolicy(current, removeRhythmPolicy(cycle));
      if (rejection) return rejection;
      return changed({
        ...current,
        sequence: { cycles: current.sequence.cycles.map((candidate) => (
          candidate.id === edit.cycleId
            ? {
                ...candidate,
                rhythms: candidate.rhythms.filter(({ id }) => id !== edit.rhythmId),
              }
            : candidate
        )) },
      }, "restart-transport-run");
    },
  },
  "set-cycle-repetitions": {
    validPayload: (edit) => targetsCycle(edit)
      && hasFormNumber(edit, "repetitions"),
    validValue: (edit) => numberInRange(
      edit,
      "repetitions",
      REPETITION_LIMIT.minimum,
      REPETITION_LIMIT.maximum,
      true,
    ),
    leavesUnchanged: (current, edit) => (
      findCycle(current, edit.cycleId)?.repetitions
        === formNumber(edit.repetitions)
    ),
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const repetitions = formNumber(edit.repetitions);
      const rejection = rejectedByPolicy(
        current,
        cycleRepetitionsPolicy(current, cycle, repetitions),
      );
      if (rejection) return rejection;
      return changed({
        ...current,
        sequence: {
          cycles: current.sequence.cycles.map((candidate) => (
            candidate.id === edit.cycleId
              ? { ...candidate, repetitions }
              : candidate
          )),
        },
      }, "restart-transport-run");
    },
  },
  "set-master-volume": {
    validPayload: (edit) => hasFormNumber(edit, "masterVolume"),
    validValue: (edit) => numberInRange(edit, "masterVolume", 0, 1),
    leavesUnchanged: (current, edit) => (
      current.masterVolume === formNumber(edit.masterVolume)
    ),
    apply(current, edit) {
      return changed({
        ...current,
        masterVolume: formNumber(edit.masterVolume),
      }, "update-mix");
    },
  },
  "set-meter-count": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "count"),
    validValue: (edit) => numberInRange(
      edit,
      "count",
      METER_COUNT_LIMIT.minimum,
      METER_COUNT_LIMIT.maximum,
      true,
    ),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.signature.count
        === formNumber(edit.count)
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "restart-transport-run",
        (rhythm) => {
          const signature = {
            ...rhythm.signature,
            count: formNumber(edit.count),
          };
          return {
            ...rhythm,
            signature,
            steps: resizeSteps(
              rhythm.steps,
              signature.count * rhythm.subdivision,
            ),
          };
        },
      );
    },
  },
  "set-meter-unit": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "unit"),
    validValue: (edit) => METER_UNITS.includes(formNumber(edit.unit)),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.signature.unit
        === formNumber(edit.unit)
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "restart-transport-run",
        (rhythm) => ({
          ...rhythm,
          signature: { ...rhythm.signature, unit: formNumber(edit.unit) },
        }),
      );
    },
  },
  "set-muted": {
    validPayload: (edit) => targetsRhythm(edit)
      && typeof edit.muted === "boolean",
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.muted === edit.muted
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "update-mix",
        (rhythm) => ({ ...rhythm, muted: edit.muted }),
      );
    },
  },
  "set-rhythm-volume": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "volume"),
    validValue: (edit) => numberInRange(edit, "volume", 0, 1),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.volume
        === formNumber(edit.volume)
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "update-mix",
        (rhythm) => ({ ...rhythm, volume: formNumber(edit.volume) }),
      );
    },
  },
  "set-sound": {
    validPayload: (edit) => targetsRhythm(edit) && hasString(edit, "sound"),
    validValue: (edit) => SOUNDS.includes(edit.sound),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.sound === edit.sound
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "update-mix",
        (rhythm) => ({ ...rhythm, sound: edit.sound }),
      );
    },
  },
  "set-stereo-position": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "pan"),
    validValue: (edit) => numberInRange(edit, "pan", -1, 1),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.pan
        === formNumber(edit.pan)
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "update-mix",
        (rhythm) => ({ ...rhythm, pan: formNumber(edit.pan) }),
      );
    },
  },
  "set-subdivision": {
    validPayload: (edit) => targetsRhythm(edit)
      && hasFormNumber(edit, "subdivision"),
    validValue: (edit) => SUBDIVISIONS.includes(formNumber(edit.subdivision)),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.subdivision
        === formNumber(edit.subdivision)
    ),
    apply(current, edit) {
      return changeRhythm(
        current,
        edit,
        "restart-transport-run",
        (rhythm) => {
          const subdivision = formNumber(edit.subdivision);
          return {
            ...rhythm,
            subdivision,
            steps: resizeSteps(
              rhythm.steps,
              rhythm.signature.count * subdivision,
            ),
          };
        },
      );
    },
  },
  "set-tempo": {
    validPayload: (edit) => hasFormNumber(edit, "bpm"),
    validValue: (edit) => numberInRange(edit, "bpm", 30, 300, true),
    leavesUnchanged: (current, edit) => current.bpm === formNumber(edit.bpm),
    apply(current, edit) {
      return changed({ ...current, bpm: formNumber(edit.bpm) }, "restart-transport-run");
    },
  },
});

export function changeConfiguration(configuration, edit) {
  if (!edit || typeof edit !== "object" || typeof edit.type !== "string") {
    throw new TypeError("Configuration edit must have a type");
  }
  if (!Object.hasOwn(COMMANDS, edit.type)) {
    throw new TypeError(`Unknown Configuration edit: ${edit.type}`);
  }
  const command = COMMANDS[edit.type];
  if (!command.validPayload(edit)) {
    throw new TypeError(`Malformed Configuration edit: ${edit.type}`);
  }
  const current = createConfiguration(configuration);
  if (command.validValue && !command.validValue(edit)) {
    return unchanged(current, "invalid-value");
  }
  if (command.leavesUnchanged?.(current, edit)) {
    return unchanged(current);
  }
  return command.apply(current, edit);
}
