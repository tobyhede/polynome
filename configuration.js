const STEP_LEVEL_CHOICES = Object.freeze(["off", "quarter", "half", "full"]);
const METER_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);
const SOUNDS = Object.freeze(["high", "low", "wood"]);
const SUBDIVISIONS = Object.freeze([1, 2, 3, 4, 5]);
const REPETITIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PRESETS = Object.freeze(["4/4", "4/4 + 3/4"]);
const MAX_RHYTHMS = 12;
let identifierSequence = 0;

function makeIdentifier(prefix) {
  identifierSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${identifierSequence.toString(36)}`;
}

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function normaliseStep(step) {
  return STEP_LEVEL_CHOICES.includes(step) ? step : "half";
}

function resizeSteps(steps, length) {
  const source = Array.isArray(steps) ? steps.map(normaliseStep) : [];
  return Array.from({ length }, (_, index) => (
    source[index] || (index === 0 ? "full" : "half")
  ));
}

function createRhythm(overrides = {}) {
  const signature = {
    count: Math.round(clampNumber(overrides.signature?.count, 4, 1, 32)),
    unit: METER_UNITS.includes(Number(overrides.signature?.unit))
      ? Number(overrides.signature.unit)
      : 4,
  };
  const subdivision = Math.round(
    clampNumber(overrides.subdivision, 1, 1, 5),
  );
  return {
    id: overrides.id || makeIdentifier("layer"),
    signature,
    subdivision,
    steps: resizeSteps(overrides.steps, signature.count * subdivision),
    volume: clampNumber(overrides.volume, 0.72, 0, 1),
    pan: clampNumber(overrides.pan, 0, -1, 1),
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
    id: overrides.id || makeIdentifier("cycle"),
    repetitions: Math.round(clampNumber(overrides.repetitions, 1, 0, 8)),
    rhythms: rhythms.length ? rhythms : [createRhythm()],
  };
}

function uniqueIdentifiers(cycles) {
  const used = new Set();
  const identifier = (candidate, prefix) => {
    const value = typeof candidate === "string" && candidate
      ? candidate
      : makeIdentifier(prefix);
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
    if (!rhythms.length) return [];
    remainingRhythms -= rhythms.length;
    return [createCycle({ ...candidate, rhythms })];
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
    bpm: Math.round(clampNumber(source.bpm, 96, 30, 300)),
    masterVolume: clampNumber(source.masterVolume, 0.8, 0, 1),
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

function comparableConfiguration(configuration) {
  return {
    bpm: configuration.bpm,
    masterVolume: configuration.masterVolume,
    sequence: {
      cycles: configuration.sequence.cycles.map((cycle) => ({
        repetitions: cycle.repetitions,
        rhythms: cycle.rhythms.map(({ id: _id, ...rhythm }) => rhythm),
      })),
    },
  };
}

function selectedPreset(configuration) {
  const candidate = JSON.stringify(comparableConfiguration(configuration));
  return PRESETS.find((name) => (
    JSON.stringify(comparableConfiguration(createPresetConfiguration(name)))
      === candidate
  )) || null;
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
    full: "half",
    half: "quarter",
    quarter: "off",
    off: "full",
  }[level] || "full";
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

function changeRhythm(current, original, edit, consequence, updater) {
  const result = editRhythm(
    current,
    edit.cycleId,
    edit.rhythmId,
    updater,
  );
  return result.reason
    ? unchanged(original, result.reason)
    : changed(result.configuration, consequence);
}

const COMMANDS = Object.freeze({
  "add-cycle": {
    validPayload: () => true,
    apply(current, _edit, original) {
      const rejection = rejectedByPolicy(original, addStructurePolicy(current));
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
    apply(current, edit, original) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(original, "cycle-not-found");
      const rejection = rejectedByPolicy(original, addStructurePolicy(current));
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
    apply(current, edit, original) {
      const cycle = findCycle(current, edit.cycleId);
      const rhythm = findRhythm(current, edit.cycleId, edit.rhythmId);
      if (!cycle) return unchanged(original, "cycle-not-found");
      if (!rhythm) return unchanged(original, "rhythm-not-found");
      const targetPosition = formNumber(edit.position);
      if (!rhythm.steps[targetPosition]) {
        return unchanged(original, "pattern-position-not-found");
      }
      return changeRhythm(
        current,
        original,
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
    validPayload: (edit) => hasString(edit, "name"),
    leavesUnchanged: (current, edit) => selectedPreset(current) === edit.name,
    apply(_current, edit, original) {
      if (!PRESETS.includes(edit.name)) {
        return unchanged(original, "preset-not-found");
      }
      return changed(
        createPresetConfiguration(edit.name),
        "restart-transport-run",
      );
    },
  },
  "remove-cycle": {
    validPayload: targetsCycle,
    apply(current, edit, original) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(original, "cycle-not-found");
      const rejection = rejectedByPolicy(
        original,
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
    apply(current, edit, original) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(original, "cycle-not-found");
      if (!findRhythm(current, edit.cycleId, edit.rhythmId)) {
        return unchanged(original, "rhythm-not-found");
      }
      const rejection = rejectedByPolicy(original, removeRhythmPolicy(cycle));
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
    validValue: (edit) => numberInRange(edit, "repetitions", 0, 8, true),
    leavesUnchanged: (current, edit) => (
      findCycle(current, edit.cycleId)?.repetitions
        === formNumber(edit.repetitions)
    ),
    apply(current, edit, original) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(original, "cycle-not-found");
      const repetitions = formNumber(edit.repetitions);
      const rejection = rejectedByPolicy(
        original,
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
    validValue: (edit) => numberInRange(edit, "count", 1, 32, true),
    leavesUnchanged: (current, edit) => (
      findRhythm(current, edit.cycleId, edit.rhythmId)?.signature.count
        === formNumber(edit.count)
    ),
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
    apply(current, edit, original) {
      return changeRhythm(
        current,
        original,
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
  if (command.validValue && !command.validValue(edit)) {
    return unchanged(configuration, "invalid-value");
  }
  const current = createConfiguration(configuration);
  if (command.leavesUnchanged?.(current, edit)) {
    return unchanged(configuration);
  }
  return command.apply(current, edit, configuration);
}
