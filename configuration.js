const STEP_LEVEL_CHOICES = Object.freeze(["off", "quarter", "half", "full"]);
const METER_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);
const SOUNDS = Object.freeze(["high", "low", "wood"]);
const SUBDIVISIONS = Object.freeze([1, 2, 3, 4, 5]);
const REPETITIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PRESETS = Object.freeze(["4/4", "4/4 + 3/4"]);
const MAX_RHYTHMS = 12;
const EDIT_TYPES = Object.freeze([
  "add-cycle",
  "add-rhythm",
  "advance-step-level",
  "apply-preset",
  "remove-cycle",
  "remove-rhythm",
  "set-cycle-repetitions",
  "set-master-volume",
  "set-meter-count",
  "set-meter-unit",
  "set-muted",
  "set-rhythm-volume",
  "set-sound",
  "set-stereo-position",
  "set-subdivision",
  "set-tempo",
]);

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

export function describeConfiguration(configuration) {
  const valid = createConfiguration(configuration);
  const rhythmCount = valid.sequence.cycles
    .flatMap((cycle) => cycle.rhythms).length;
  const activeCycleCount = valid.sequence.cycles
    .filter((cycle) => cycle.repetitions > 0).length;

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
      addCycle: availability(
        rhythmCount < MAX_RHYTHMS,
        "sequence-rhythm-limit",
      ),
      cycles: Object.fromEntries(valid.sequence.cycles.map((cycle) => [
        cycle.id,
        {
          remove: availability(
            valid.sequence.cycles.length > 1
              && !(cycle.repetitions > 0 && activeCycleCount === 1),
            valid.sequence.cycles.length === 1
              ? "sequence-requires-cycle"
              : "sequence-requires-active-cycle",
          ),
          addRhythm: availability(
            rhythmCount < MAX_RHYTHMS,
            "sequence-rhythm-limit",
          ),
          repetitions: Object.fromEntries(REPETITIONS.map((repetitions) => {
            const singleCycleInvalid = valid.sequence.cycles.length === 1
              && repetitions !== 1;
            const finalActiveInvalid = repetitions === 0
              && cycle.repetitions > 0
              && activeCycleCount === 1;
            return [repetitions, availability(
              !singleCycleInvalid && !finalActiveInvalid,
              singleCycleInvalid
                ? "single-cycle-requires-one-repetition"
                : "sequence-requires-active-cycle",
            )];
          })),
          rhythms: Object.fromEntries(cycle.rhythms.map((rhythm) => [
            rhythm.id,
            {
              remove: availability(
                cycle.rhythms.length > 1,
                "cycle-requires-rhythm",
              ),
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

function validPayloadStructure(edit) {
  const stringProperty = (property) => typeof edit[property] === "string";
  const numericFormProperty = (property) => (
    typeof edit[property] === "number" || typeof edit[property] === "string"
  );
  const target = () => stringProperty("cycleId");
  const rhythmTarget = () => target() && stringProperty("rhythmId");

  switch (edit.type) {
    case "add-cycle":
      return true;
    case "add-rhythm":
    case "remove-cycle":
      return target();
    case "advance-step-level":
      return rhythmTarget() && numericFormProperty("position");
    case "apply-preset":
      return stringProperty("name");
    case "remove-rhythm":
      return rhythmTarget();
    case "set-cycle-repetitions":
      return target() && numericFormProperty("repetitions");
    case "set-master-volume":
      return numericFormProperty("masterVolume");
    case "set-meter-count":
      return rhythmTarget() && numericFormProperty("count");
    case "set-meter-unit":
      return rhythmTarget() && numericFormProperty("unit");
    case "set-muted":
      return rhythmTarget() && typeof edit.muted === "boolean";
    case "set-rhythm-volume":
      return rhythmTarget() && numericFormProperty("volume");
    case "set-sound":
      return rhythmTarget() && stringProperty("sound");
    case "set-stereo-position":
      return rhythmTarget() && numericFormProperty("pan");
    case "set-subdivision":
      return rhythmTarget() && numericFormProperty("subdivision");
    case "set-tempo":
      return numericFormProperty("bpm");
    default:
      return false;
  }
}

function formNumber(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDomainValue(edit) {
  const numberInRange = (property, minimum, maximum, integer = false) => {
    const value = formNumber(edit[property]);
    return value !== null
      && value >= minimum
      && value <= maximum
      && (!integer || Number.isInteger(value));
  };

  switch (edit.type) {
    case "advance-step-level":
      return numberInRange("position", 0, Number.MAX_SAFE_INTEGER, true);
    case "set-cycle-repetitions":
      return numberInRange("repetitions", 0, 8, true);
    case "set-master-volume":
      return numberInRange("masterVolume", 0, 1);
    case "set-meter-count":
      return numberInRange("count", 1, 32, true);
    case "set-meter-unit":
      return METER_UNITS.includes(formNumber(edit.unit));
    case "set-rhythm-volume":
      return numberInRange("volume", 0, 1);
    case "set-sound":
      return SOUNDS.includes(edit.sound);
    case "set-stereo-position":
      return numberInRange("pan", -1, 1);
    case "set-subdivision":
      return SUBDIVISIONS.includes(formNumber(edit.subdivision));
    case "set-tempo":
      return numberInRange("bpm", 30, 300, true);
    default:
      return true;
  }
}

function editLeavesValuesUnchanged(current, edit) {
  const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
  const rhythm = cycle?.rhythms.find(({ id }) => id === edit.rhythmId);

  switch (edit.type) {
    case "apply-preset":
      return selectedPreset(current) === edit.name;
    case "set-cycle-repetitions":
      return cycle?.repetitions === formNumber(edit.repetitions);
    case "set-master-volume":
      return current.masterVolume === formNumber(edit.masterVolume);
    case "set-meter-count":
      return rhythm?.signature.count === formNumber(edit.count);
    case "set-meter-unit":
      return rhythm?.signature.unit === formNumber(edit.unit);
    case "set-muted":
      return rhythm?.muted === edit.muted;
    case "set-rhythm-volume":
      return rhythm?.volume === formNumber(edit.volume);
    case "set-sound":
      return rhythm?.sound === edit.sound;
    case "set-stereo-position":
      return rhythm?.pan === formNumber(edit.pan);
    case "set-subdivision":
      return rhythm?.subdivision === formNumber(edit.subdivision);
    case "set-tempo":
      return current.bpm === formNumber(edit.bpm);
    default:
      return false;
  }
}

export function changeConfiguration(configuration, edit) {
  if (!edit || typeof edit !== "object" || typeof edit.type !== "string") {
    throw new TypeError("Configuration edit must have a type");
  }
  if (!EDIT_TYPES.includes(edit.type)) {
    throw new TypeError(`Unknown Configuration edit: ${edit.type}`);
  }
  if (!validPayloadStructure(edit)) {
    throw new TypeError(`Malformed Configuration edit: ${edit.type}`);
  }
  if (!validDomainValue(edit)) {
    return { configuration, consequence: "none", reason: "invalid-value" };
  }
  const current = createConfiguration(configuration);
  if (editLeavesValuesUnchanged(current, edit)) {
    return { configuration, consequence: "none", reason: null };
  }

  switch (edit.type) {
    case "advance-step-level": {
      const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
      const rhythm = cycle?.rhythms.find(({ id }) => id === edit.rhythmId);
      if (!cycle) return { configuration, consequence: "none", reason: "cycle-not-found" };
      if (!rhythm) return { configuration, consequence: "none", reason: "rhythm-not-found" };
      const position = formNumber(edit.position);
      if (!rhythm.steps[position]) {
        return { configuration, consequence: "none", reason: "pattern-position-not-found" };
      }
      const result = editRhythm(current, edit.cycleId, edit.rhythmId, (candidate) => ({
        ...candidate,
        steps: candidate.steps.map((level, position) => (
          position === formNumber(edit.position) ? nextStepLevel(level) : level
        )),
      }));
      return changed(result.configuration, "update-step-levels");
    }
    case "add-rhythm": {
      const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
      if (!cycle) {
        return { configuration, consequence: "none", reason: "cycle-not-found" };
      }
      if (current.sequence.cycles.flatMap(({ rhythms }) => rhythms).length >= MAX_RHYTHMS) {
        return { configuration, consequence: "none", reason: "sequence-rhythm-limit" };
      }
      return changed({
        ...current,
        sequence: { cycles: current.sequence.cycles.map((candidate) => (
          candidate.id === edit.cycleId
            ? { ...candidate, rhythms: [...candidate.rhythms, createRhythm()] }
            : candidate
        )) },
      }, "restart-transport-run");
    }
    case "add-cycle":
      if (current.sequence.cycles.flatMap((cycle) => cycle.rhythms).length >= MAX_RHYTHMS) {
        return {
          configuration,
          consequence: "none",
          reason: "sequence-rhythm-limit",
        };
      }
      return changed({
        ...current,
        sequence: {
          cycles: [...current.sequence.cycles, createCycle()],
        },
      }, "restart-transport-run");
    case "apply-preset":
      if (!PRESETS.includes(edit.name)) {
        return { configuration, consequence: "none", reason: "preset-not-found" };
      }
      return changed(
        createPresetConfiguration(edit.name),
        "restart-transport-run",
      );
    case "remove-cycle": {
      const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
      if (!cycle) {
        return { configuration, consequence: "none", reason: "cycle-not-found" };
      }
      if (current.sequence.cycles.length === 1) {
        return { configuration, consequence: "none", reason: "sequence-requires-cycle" };
      }
      const activeCount = current.sequence.cycles
        .filter(({ repetitions }) => repetitions > 0).length;
      if (cycle.repetitions > 0 && activeCount === 1) {
        return {
          configuration,
          consequence: "none",
          reason: "sequence-requires-active-cycle",
        };
      }
      return changed(createConfiguration({
        ...current,
        sequence: {
          cycles: current.sequence.cycles.filter(({ id }) => id !== edit.cycleId),
        },
      }), "restart-transport-run");
    }
    case "remove-rhythm": {
      const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
      if (!cycle) {
        return { configuration, consequence: "none", reason: "cycle-not-found" };
      }
      if (!cycle.rhythms.some(({ id }) => id === edit.rhythmId)) {
        return { configuration, consequence: "none", reason: "rhythm-not-found" };
      }
      if (cycle.rhythms.length === 1) {
        return { configuration, consequence: "none", reason: "cycle-requires-rhythm" };
      }
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
    }
    case "set-cycle-repetitions": {
      const cycle = current.sequence.cycles.find(({ id }) => id === edit.cycleId);
      if (!cycle) {
        return { configuration, consequence: "none", reason: "cycle-not-found" };
      }
      const repetitions = Math.round(
        clampNumber(edit.repetitions, cycle.repetitions, 0, 8),
      );
      if (current.sequence.cycles.length === 1 && repetitions !== 1) {
        return {
          configuration,
          consequence: "none",
          reason: "single-cycle-requires-one-repetition",
        };
      }
      const activeCount = current.sequence.cycles
        .filter((candidate) => candidate.repetitions > 0).length;
      if (repetitions === 0 && cycle.repetitions > 0 && activeCount === 1) {
        return {
          configuration,
          consequence: "none",
          reason: "sequence-requires-active-cycle",
        };
      }
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
    }
    case "set-meter-count":
    case "set-meter-unit":
    case "set-subdivision": {
      const result = editRhythm(
        current,
        edit.cycleId,
        edit.rhythmId,
        (rhythm) => {
          const signature = {
            count: edit.type === "set-meter-count"
              ? Math.round(clampNumber(edit.count, rhythm.signature.count, 1, 32))
              : rhythm.signature.count,
            unit: edit.type === "set-meter-unit" && METER_UNITS.includes(Number(edit.unit))
              ? Number(edit.unit)
              : rhythm.signature.unit,
          };
          const subdivision = edit.type === "set-subdivision"
            ? Math.round(clampNumber(edit.subdivision, rhythm.subdivision, 1, 5))
            : rhythm.subdivision;
          return {
            ...rhythm,
            signature,
            subdivision,
            steps: resizeSteps(rhythm.steps, signature.count * subdivision),
          };
        },
      );
      if (result.reason) {
        return { configuration, consequence: "none", reason: result.reason };
      }
      return changed(result.configuration, "restart-transport-run");
    }
    case "set-master-volume":
      return changed({
        ...current,
        masterVolume: clampNumber(
          edit.masterVolume,
          current.masterVolume,
          0,
          1,
        ),
      }, "update-mix");
    case "set-muted":
    case "set-rhythm-volume":
    case "set-sound":
    case "set-stereo-position": {
      const result = editRhythm(
        current,
        edit.cycleId,
        edit.rhythmId,
        (rhythm) => ({
          ...rhythm,
          ...(edit.type === "set-muted" ? { muted: Boolean(edit.muted) } : {}),
          ...(edit.type === "set-rhythm-volume" ? {
            volume: clampNumber(edit.volume, rhythm.volume, 0, 1),
          } : {}),
          ...(edit.type === "set-sound" ? {
            sound: SOUNDS.includes(edit.sound) ? edit.sound : rhythm.sound,
          } : {}),
          ...(edit.type === "set-stereo-position" ? {
            pan: clampNumber(edit.pan, rhythm.pan, -1, 1),
          } : {}),
        }),
      );
      if (result.reason) {
        return { configuration, consequence: "none", reason: result.reason };
      }
      return changed(result.configuration, "update-mix");
    }
    case "set-tempo":
      return changed({
        ...current,
        bpm: Math.round(clampNumber(edit.bpm, current.bpm, 30, 300)),
      }, "restart-transport-run");
  }
}
