export const STEP = Object.freeze({
  OFF: "off",
  QUARTER: "quarter",
  HALF: "half",
  FULL: "full",
});

const STEP_LEVELS = Object.freeze({
  [STEP.OFF]: 0,
  [STEP.QUARTER]: 0.25,
  [STEP.HALF]: 0.5,
  [STEP.FULL]: 1,
});

export function stepLevel(step) {
  return STEP_LEVELS[step] ?? 0;
}

export const NOTE_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);
export const SOUNDS = Object.freeze(["high", "low", "wood"]);
export const MAX_REPETITIONS = 8;

let layerSequence = 0;

export function makeId(prefix = "layer") {
  layerSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${layerSequence.toString(36)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normaliseNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

export function createPattern(length, firstStep = STEP.FULL) {
  const safeLength = Math.round(normaliseNumber(length, 4, 1, 160));
  return Array.from({ length: safeLength }, (_, index) =>
    index === 0 ? firstStep : STEP.HALF,
  );
}

export function createLayer(overrides = {}) {
  const signature = {
    count: Math.round(
      normaliseNumber(overrides.signature?.count, 4, 1, 32),
    ),
    unit: normaliseUnit(overrides.signature?.unit, 4),
  };
  const subdivision = Math.round(
    normaliseNumber(overrides.subdivision, 1, 1, 5),
  );
  const steps = Array.isArray(overrides.steps)
    ? resizePattern(
        overrides.steps.map(normaliseStep),
        signature.count * subdivision,
      )
    : createPattern(signature.count * subdivision);

  return {
    id: overrides.id || makeId(),
    signature,
    subdivision,
    steps,
    volume: normaliseNumber(overrides.volume, 0.72, 0, 1),
    pan: normaliseNumber(overrides.pan, 0, -1, 1),
    sound: SOUNDS.includes(overrides.sound) ? overrides.sound : "high",
    muted: Boolean(overrides.muted),
  };
}

export function createCycle(overrides = {}) {
  const rhythms = Array.isArray(overrides.rhythms)
    ? overrides.rhythms.slice(0, 12).map(createLayer)
    : [];

  return {
    id: overrides.id || makeId("cycle"),
    repetitions: Math.round(
      normaliseNumber(overrides.repetitions, 1, 0, MAX_REPETITIONS),
    ),
    rhythms: rhythms.length ? rhythms : [createLayer()],
  };
}

export function createDefaultState() {
  return createPreset("4/4");
}

export function normaliseState(input) {
  const source = input && typeof input === "object" ? input : {};
  let remainingRhythms = 12;
  const cycles = Array.isArray(source.cycles)
    ? source.cycles.flatMap((cycle) => {
        if (remainingRhythms <= 0) return [];
        const candidate = cycle && typeof cycle === "object" ? cycle : {};
        const rhythms = Array.isArray(candidate.rhythms)
          ? candidate.rhythms.slice(0, remainingRhythms)
          : [];
        if (!rhythms.length) return [];
        remainingRhythms -= rhythms.length;
        return [createCycle({ ...candidate, rhythms })];
      })
    : [];
  const populatedCycles = cycles.length ? cycles : createPreset("4/4").cycles;
  const activeCycles = populatedCycles.some((cycle) => cycle.repetitions > 0)
    ? populatedCycles
    : populatedCycles.map((cycle, index) => (
        index === 0 ? { ...cycle, repetitions: 1 } : cycle
      ));

  return {
    bpm: Math.round(normaliseNumber(source.bpm, 96, 30, 300)),
    masterVolume: normaliseNumber(source.masterVolume, 0.8, 0, 1),
    cycles: activeCycles,
  };
}

export function normaliseStep(value) {
  return Object.values(STEP).includes(value) ? value : STEP.HALF;
}

export function normaliseUnit(value, fallback = 4) {
  const parsed = Number(value);
  return NOTE_UNITS.includes(parsed) ? parsed : fallback;
}

export function nextStepState(step) {
  switch (normaliseStep(step)) {
    case STEP.FULL:
      return STEP.HALF;
    case STEP.HALF:
      return STEP.QUARTER;
    case STEP.QUARTER:
      return STEP.OFF;
    case STEP.OFF:
      return STEP.FULL;
    default:
      return STEP.FULL;
  }
}

export function resizePattern(steps, nextLength) {
  const length = Math.round(
    normaliseNumber(nextLength, steps?.length || 4, 1, 160),
  );
  const source = Array.isArray(steps) ? steps.map(normaliseStep) : [];

  return Array.from({ length }, (_, index) => {
    if (source[index]) return source[index];
    return index === 0 ? STEP.FULL : STEP.HALF;
  });
}

/**
 * Tempo is always displayed and interpreted as quarter-note BPM.
 */
export function cycleDurationSeconds(bpm, signature) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const count = normaliseNumber(signature?.count, 4, 1, 64);
  const unit = normaliseUnit(signature?.unit, 4);
  const quarterSeconds = 60 / safeBpm;
  return quarterSeconds * count * (4 / unit);
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function leastCommonMultiple(left, right) {
  return Math.abs(left * right) / greatestCommonDivisor(left, right);
}

export function cycleSpanSeconds(bpm, cycle) {
  const rhythms = Array.isArray(cycle?.rhythms) && cycle.rhythms.length
    ? cycle.rhythms
    : [createLayer()];
  const spanInThirtySecondNotes = rhythms
    .map((rhythm) => {
      const count = Math.round(
        normaliseNumber(rhythm.signature?.count, 4, 1, 32),
      );
      const unit = normaliseUnit(rhythm.signature?.unit, 4);
      return count * (32 / unit);
    })
    .reduce(leastCommonMultiple);
  const quarterSeconds = 60 / normaliseNumber(bpm, 96, 1, 1000);
  return spanInThirtySecondNotes * quarterSeconds / 8;
}

export function stepDurationSeconds(bpm, layer) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const unit = normaliseUnit(layer?.signature?.unit, 4);
  const subdivision = Math.round(
    normaliseNumber(layer?.subdivision, 1, 1, 5),
  );
  return (60 / safeBpm) * (4 / unit) / subdivision;
}

export const PRESET_NAMES = Object.freeze([
  "4/4",
  "4/4 + 3/4",
]);

export function createPreset(name) {
  switch (name) {
    case "4/4 + 3/4":
      return {
        bpm: 112,
        masterVolume: 0.8,
        cycles: [
          createCycle({
            rhythms: [
              createLayer({
                signature: { count: 4, unit: 4 },
                subdivision: 1,
                pan: 0,
                sound: "high",
              }),
              createLayer({
                signature: { count: 3, unit: 4 },
                subdivision: 1,
                pan: 0,
                sound: "low",
              }),
            ],
          }),
        ],
      };

    case "4/4":
    default:
      return {
        bpm: 96,
        masterVolume: 0.8,
        cycles: [
          createCycle({
            rhythms: [
              createLayer({
                signature: { count: 4, unit: 4 },
                subdivision: 1,
                pan: 0,
                sound: "high",
              }),
            ],
          }),
        ],
      };
  }
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
