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
    name: String(overrides.name || "Rhythm"),
    signature,
    subdivision,
    steps,
    volume: normaliseNumber(overrides.volume, 0.72, 0, 1),
    pan: normaliseNumber(overrides.pan, 0, -1, 1),
    sound: SOUNDS.includes(overrides.sound) ? overrides.sound : "high",
    muted: Boolean(overrides.muted),
  };
}

export function createDefaultState() {
  return createPreset("3:2");
}

export function normaliseState(input) {
  const source = input && typeof input === "object" ? input : {};
  const layers = Array.isArray(source.layers)
    ? source.layers.slice(0, 12).map(createLayer)
    : [];

  return {
    bpm: Math.round(normaliseNumber(source.bpm, 96, 30, 300)),
    masterVolume: normaliseNumber(source.masterVolume, 0.8, 0, 1),
    layers: layers.length ? layers : createPreset("3:2").layers,
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

export function stepDurationSeconds(bpm, layer) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const unit = normaliseUnit(layer?.signature?.unit, 4);
  const subdivision = Math.round(
    normaliseNumber(layer?.subdivision, 1, 1, 5),
  );
  return (60 / safeBpm) * (4 / unit) / subdivision;
}

export const PRESET_NAMES = Object.freeze([
  "3:2",
  "4:3",
  "5:4",
  "4/4 + 3/4",
  "7/8 · 2+2+3",
]);

export function createPreset(name) {
  switch (name) {
    case "4:3":
      return {
        bpm: 96,
        masterVolume: 0.8,
        layers: [
          createLayer({
            name: "Four",
            signature: { count: 4, unit: 4 },
            subdivision: 4,
            pan: -0.72,
            sound: "high",
          }),
          createLayer({
            name: "Three",
            signature: { count: 4, unit: 4 },
            subdivision: 3,
            pan: 0.72,
            sound: "low",
          }),
        ],
      };

    case "5:4":
      return {
        bpm: 90,
        masterVolume: 0.8,
        layers: [
          createLayer({
            name: "Five",
            signature: { count: 4, unit: 4 },
            subdivision: 5,
            pan: -0.72,
            sound: "high",
          }),
          createLayer({
            name: "Four",
            signature: { count: 4, unit: 4 },
            subdivision: 4,
            pan: 0.72,
            sound: "low",
          }),
        ],
      };

    case "4/4 + 3/4":
      return {
        bpm: 112,
        masterVolume: 0.8,
        layers: [
          createLayer({
            name: "4/4",
            signature: { count: 4, unit: 4 },
            subdivision: 1,
            pan: -0.72,
            sound: "high",
          }),
          createLayer({
            name: "3/4",
            signature: { count: 3, unit: 4 },
            subdivision: 1,
            pan: 0.72,
            sound: "low",
          }),
        ],
      };

    case "7/8 · 2+2+3":
      return {
        bpm: 108,
        masterVolume: 0.8,
        layers: [
          createLayer({
            name: "7/8 · 2+2+3",
            signature: { count: 7, unit: 8 },
            subdivision: 1,
            steps: [
              STEP.ACCENT,
              STEP.HIT,
              STEP.ACCENT,
              STEP.HIT,
              STEP.ACCENT,
              STEP.HIT,
              STEP.HIT,
            ],
            pan: 0,
            sound: "wood",
          }),
        ],
      };

    case "3:2":
    default:
      return {
        bpm: 96,
        masterVolume: 0.8,
        layers: [
          createLayer({
            name: "Three",
            signature: { count: 2, unit: 4 },
            subdivision: 3,
            pan: -0.72,
            sound: "high",
          }),
          createLayer({
            name: "Two",
            signature: { count: 2, unit: 4 },
            subdivision: 2,
            pan: 0.72,
            sound: "low",
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
