export const STEP = Object.freeze({
  REST: "rest",
  HIT: "hit",
  ACCENT: "accent",
});

export const NOTE_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);
export const SOUNDS = Object.freeze(["high", "low", "wood"]);

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

export function createPattern(length, firstStep = STEP.ACCENT) {
  const safeLength = Math.round(normaliseNumber(length, 4, 1, 160));
  return Array.from({ length: safeLength }, (_, index) =>
    index === 0 ? firstStep : STEP.HIT,
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
      normaliseNumber(overrides.repetitions, 1, 1, 32),
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

  return {
    bpm: Math.round(normaliseNumber(source.bpm, 96, 30, 300)),
    masterVolume: normaliseNumber(source.masterVolume, 0.8, 0, 1),
    cycles: cycles.length ? cycles : createPreset("4/4").cycles,
  };
}

export function normaliseStep(value) {
  return Object.values(STEP).includes(value) ? value : STEP.HIT;
}

export function normaliseUnit(value, fallback = 4) {
  const parsed = Number(value);
  return NOTE_UNITS.includes(parsed) ? parsed : fallback;
}

export function nextStepState(step) {
  switch (normaliseStep(step)) {
    case STEP.ACCENT:
      return STEP.HIT;
    case STEP.HIT:
      return STEP.REST;
    default:
      return STEP.ACCENT;
  }
}

export function resizePattern(steps, nextLength) {
  const length = Math.round(
    normaliseNumber(nextLength, steps?.length || 4, 1, 160),
  );
  const source = Array.isArray(steps) ? steps.map(normaliseStep) : [];

  return Array.from({ length }, (_, index) => {
    if (source[index]) return source[index];
    return index === 0 ? STEP.ACCENT : STEP.HIT;
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

export function sequenceSummary(state) {
  return state.cycles
    .map((cycle) => {
      const rhythms = cycle.rhythms
        .map((rhythm) => `${rhythm.signature.count}/${rhythm.signature.unit}`)
        .join(" + ");
      return `${cycle.repetitions}(${rhythms})`;
    })
    .join(", ");
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
