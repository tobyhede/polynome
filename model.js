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

const NOTE_UNITS = Object.freeze([1, 2, 4, 8, 16, 32]);

export function stepLevel(step) {
  return STEP_LEVELS[step] ?? 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normaliseNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function normaliseUnit(value, fallback = 4) {
  const parsed = Number(value);
  return NOTE_UNITS.includes(parsed) ? parsed : fallback;
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
    : [{ signature: { count: 4, unit: 4 } }];
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

export function stepDurationSeconds(bpm, rhythm) {
  const safeBpm = normaliseNumber(bpm, 96, 1, 1000);
  const unit = normaliseUnit(rhythm?.signature?.unit, 4);
  const subdivision = Math.round(
    normaliseNumber(rhythm?.subdivision, 1, 1, 5),
  );
  return (60 / safeBpm) * (4 / unit) / subdivision;
}

export function panLabel(value) {
  const pan = normaliseNumber(value, 0, -1, 1);
  if (Math.abs(pan) < 0.04) return "Centre";
  const percentage = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `Left ${percentage}%` : `Right ${percentage}%`;
}
