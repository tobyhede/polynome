import { canonicalPattern, controls, DISPLAY_MODES, repairPattern } from "./grid.ts";
import {
  createSequenceTempoCurves,
  ENVELOPE,
  ENVELOPE_DEFAULT_AMOUNT,
  ENVELOPE_LIMIT,
  lookup,
  METER_COUNT_LIMIT,
  METER_UNITS,
  normaliseMeterUnit,
  normaliseNumber,
  SOUND,
  STEP,
  SUBDIVISION_LIMIT,
  subdivisionLabel,
  subdivisionLabelWithoutUnit,
  TEMPO_LIMIT,
  TIMING_MODE,
} from "./model.ts";

/**
 * What arrives from outside this module and has not been checked yet: a parsed
 * store, a Preset written by an older version, a caller's partial object. It
 * carries the type `JSON.parse` returns because that is where most of it comes
 * from and because nothing about it is known.
 *
 * Naming the shape instead would assert the guarantee these functions exist to
 * establish. Every property below is read through a normaliser that supplies
 * the canonical value when it is missing, of the wrong type, or out of range,
 * so a declared shape would describe the output and describe the input wrongly
 * — and the checker would then object to exactly the defensive reads that make
 * the claim true.
 */
type Unvalidated = any;

/**
 * A limit and the choices offered for it are one domain, so the list is built
 * from the limit rather than restated beside it, where the two could drift into
 * offering a choice that repair then clamps away.
 */
function choiceRange({ minimum, maximum }) {
  return Object.freeze(
    Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index),
  );
}

const STEP_VOICE_CHOICES = Object.freeze(Object.values(STEP));
const SOUNDS = Object.freeze(Object.values(SOUND));
const SUBDIVISIONS = choiceRange(SUBDIVISION_LIMIT);
const METER_COUNTS = choiceRange(METER_COUNT_LIMIT);
const REPETITION_LIMIT = Object.freeze({ minimum: 0, maximum: 8 });
const REPETITIONS = choiceRange(REPETITION_LIMIT);
const TIMING_MODES = Object.freeze(Object.values(TIMING_MODE));
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
  return typeof candidate === "string" && GENERATED_IDENTIFIER.exec(candidate)?.[1] === prefix
    ? candidate
    : makeIdentifier(prefix);
}

function createRhythm(overrides: Unvalidated = {}) {
  const signature = {
    count: Math.round(
      normaliseNumber(
        overrides.signature?.count,
        4,
        METER_COUNT_LIMIT.minimum,
        METER_COUNT_LIMIT.maximum,
      ),
    ),
    unit: normaliseMeterUnit(overrides.signature?.unit),
  };
  const subdivision = Math.round(
    normaliseNumber(overrides.subdivision, 1, SUBDIVISION_LIMIT.minimum, SUBDIVISION_LIMIT.maximum),
  );
  return {
    id: safeIdentifier(overrides.id, "layer"),
    signature,
    subdivision,
    displayMode: DISPLAY_MODES.includes(overrides.displayMode) ? overrides.displayMode : "beat",
    steps: repairPattern(overrides.steps, signature.count, subdivision),
    // A value the Level slider can actually hold. Its step is `MIX_STEP` in
    // `model.ts`, and a default off that grid is rounded onto it by the control
    // itself without an event, leaving the thumb, this Configuration and the
    // audio graph on three different numbers. Written as the literal it is
    // rather than counted out in steps, because a count is a product and
    // `14 * 0.05` is `0.7000000000000001`, which is the same bug again.
    // `test/model.test.ts` holds every default here to its control's grid.
    volume: normaliseNumber(overrides.volume, 0.7, 0, 1),
    pan: normaliseNumber(overrides.pan, 0, -1, 1),
    sound: SOUNDS.includes(overrides.sound) ? overrides.sound : SOUND.HIGH,
    muted: Boolean(overrides.muted),
  };
}

/**
 * Every Cycle carries an envelope, and a Cycle carrying nothing carries Flat 0.
 * That is what makes this addition storage-compatible without retiring a key:
 * a Configuration written before envelopes existed has no `envelope` at all,
 * and normalises to the state that plays exactly as it always did.
 *
 * An unknown shape is Flat zero rather than refused, and zero rather than the
 * amount stored beside it. The amount alone reads like a number a listener
 * chose, but it was chosen for a shape that is not there, and a Flat spends its
 * whole change on its Cycle's first beat: keeping it turns data nobody can read
 * into a step nobody asked for, which is the one repair that is audible.
 *
 * Where the shape is one this vocabulary knows, the amount is rounded and then
 * clamped into whichever range that shape offers, which is the only place Flat's
 * reach below zero is decided.
 */
function normaliseEnvelope(candidate) {
  const known = Boolean(ENVELOPE_LIMIT[candidate?.shape]);
  const shape = known ? candidate.shape : ENVELOPE.FLAT;
  const { minimum, maximum } = ENVELOPE_LIMIT[shape];
  const fallback = shape === ENVELOPE.FLAT ? 0 : ENVELOPE_DEFAULT_AMOUNT;
  return {
    shape,
    amount: known ? Math.round(normaliseNumber(candidate.amount, fallback, minimum, maximum)) : 0,
  };
}

function createCycle(overrides: Unvalidated = {}) {
  const rhythms = Array.isArray(overrides.rhythms)
    ? overrides.rhythms.map((rhythm) =>
        createRhythm(rhythm && typeof rhythm === "object" ? rhythm : {}),
      )
    : [];
  return {
    id: safeIdentifier(overrides.id, "cycle"),
    envelope: normaliseEnvelope(overrides.envelope),
    timingMode: TIMING_MODES.includes(overrides.timingMode)
      ? overrides.timingMode
      : TIMING_MODE.POLYMETER,
    repetitions: Math.round(
      normaliseNumber(overrides.repetitions, 1, REPETITION_LIMIT.minimum, REPETITION_LIMIT.maximum),
    ),
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
export function createConfiguration(input?: Unvalidated) {
  const source = input && typeof input === "object" ? input : {};
  let remainingRhythms = MAX_RHYTHMS;
  const sourceCycles = Array.isArray(source.sequence?.cycles) ? source.sequence.cycles : [];
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
  const validCycles = populated.some((cycle) => cycle.repetitions > 0)
    ? populated
    : populated.map((cycle, index) => (index === 0 ? { ...cycle, repetitions: 1 } : cycle));

  return {
    bpm: Math.round(normaliseNumber(source.bpm, 120, TEMPO_LIMIT.minimum, TEMPO_LIMIT.maximum)),
    sequence: { cycles: validCycles },
  };
}

/**
 * The Presets a first run writes into storage. They are examples, not a kind of
 * Preset: once written they are renamed, replaced and deleted like any other,
 * and nothing here is consulted again.
 */
const SEED_PRESETS = Object.freeze([
  {
    name: "4/4 8ths",
    configuration: {
      bpm: 120,
      sequence: {
        cycles: [
          {
            rhythms: [{ subdivision: 2, displayMode: "beat" }],
          },
        ],
      },
    },
  },
  {
    name: "4/4 Triplets",
    configuration: {
      bpm: 120,
      sequence: {
        cycles: [
          {
            rhythms: [{ subdivision: 3, displayMode: "beat" }],
          },
        ],
      },
    },
  },
]);

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
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    Object.keys(candidate).length === Object.keys(repaired).length
  );
}

function sameRhythm(rhythm, candidate) {
  return (
    sameFields(rhythm, candidate) &&
    sameFields(rhythm.signature, candidate.signature) &&
    rhythm.signature.count === candidate.signature.count &&
    rhythm.signature.unit === candidate.signature.unit &&
    rhythm.subdivision === candidate.subdivision &&
    rhythm.displayMode === candidate.displayMode &&
    rhythm.volume === candidate.volume &&
    rhythm.pan === candidate.pan &&
    rhythm.sound === candidate.sound &&
    rhythm.muted === candidate.muted &&
    Array.isArray(candidate.steps) &&
    rhythm.steps.length === candidate.steps.length &&
    rhythm.steps.every((step, position) => step === candidate.steps[position])
  );
}

function sameCycle(cycle, candidate) {
  // Both sides have been through `createCycle`, so both carry an envelope and
  // neither can be missing one. Without this comparison `+ Save` would not
  // notice an envelope edit at all.
  const sameEnvelope =
    cycle.envelope.shape === candidate.envelope?.shape &&
    cycle.envelope.amount === candidate.envelope?.amount;
  return (
    sameFields(cycle, candidate) &&
    cycle.repetitions === candidate.repetitions &&
    cycle.timingMode === candidate.timingMode &&
    sameEnvelope &&
    Array.isArray(candidate.rhythms) &&
    cycle.rhythms.length === candidate.rhythms.length &&
    cycle.rhythms.every((rhythm, index) => sameRhythm(rhythm, candidate.rhythms[index]))
  );
}

/**
 * Whether two Configurations hold the same music. Identifiers are deliberately
 * not compared: they are regenerated on load and on every applied Preset, so
 * two values that sound identical differ by them constantly. The interface asks
 * in order to know whether the current Configuration still is the Preset it came
 * from, and so whether there is anything left to save.
 *
 * Neither argument is repaired here. Both reach this through a door that
 * already did — `createConfiguration` for the live one, `createSavedPresets`
 * for a stored Preset's — and repeating the pass on every render to answer a
 * question about two values the caller is holding is the cost this exists to
 * avoid.
 */
export function sameConfiguration(configuration, candidate) {
  return (
    sameFields(configuration, candidate) &&
    configuration.bpm === candidate.bpm &&
    sameFields(configuration.sequence, candidate.sequence) &&
    Array.isArray(candidate.sequence.cycles) &&
    configuration.sequence.cycles.length === candidate.sequence.cycles.length &&
    configuration.sequence.cycles.every((cycle, index) =>
      sameCycle(cycle, candidate.sequence.cycles[index]),
    )
  );
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

function findPresetNamed(presets, name) {
  return presets.findIndex(
    (stored) => normalisedPresetName(stored.name) === normalisedPresetName(name),
  );
}

/**
 * Saved Presets are storage input, so malformed entries are discarded and
 * malformed Configurations are repaired. Repeated names follow save semantics:
 * the later snapshot replaces the earlier one.
 */
export function createSavedPresets(input?: Unvalidated) {
  const candidates = Array.isArray(input) ? input : [];
  return candidates.reduce((presets, candidate) => {
    if (!candidate || typeof candidate !== "object") return presets;
    const name = presetName(candidate.name);
    if (!name) return presets;

    const candidateId = safeIdentifier(candidate.id, "preset");
    const duplicate = findPresetNamed(presets, name);
    // Sharing an identifier with the entry this one replaces is not a
    // collision: that entry is about to stop existing, and regenerating here
    // would move the surviving Preset's identity on every load.
    const collides = presets.some(({ id }, index) => id === candidateId && index !== duplicate);
    const preset = {
      id: collides ? makeIdentifier("preset") : candidateId,
      name,
      configuration: createConfiguration(candidate.configuration),
    };
    // The spread is not what makes this quadratic. Every candidate already
    // scans the accumulator to find a duplicate and rebuilds it through `map`
    // on the line below, so removing the spread alone would leave the
    // complexity exactly where it is while making the immutable style harder
    // to read. A saved-preset list is a person's own, measured in dozens.
    // biome-ignore lint/performance/noAccumulatingSpread: the map below is already O(n)
    if (duplicate < 0) return [...presets, preset];
    return presets.map((stored, index) => (index === duplicate ? preset : stored));
  }, []);
}

/**
 * Fresh copies of the Presets a first run receives. This is also the explicit
 * factory reset boundary: callers get repaired Configurations and newly issued
 * identifiers, never the frozen definitions above or a stored listener value.
 */
export function createFactoryPresets() {
  return createSavedPresets(SEED_PRESETS);
}

/**
 * The one door in from storage, taking the raw stored value so that a key this
 * browser has never written stays distinguishable from one deliberately emptied.
 * Only the first is a first run, and only a first run is seeded with the
 * examples; an empty list is a listener who deleted the last Preset.
 */
export function createStoredPresets(stored) {
  if (stored === null) return createFactoryPresets();
  if (typeof stored !== "string") {
    throw new TypeError("Stored Presets must be the stored string or null");
  }
  try {
    return createSavedPresets(JSON.parse(stored));
  } catch {
    // Written but unreadable. Repair discards what it cannot recognise, and a
    // whole value it cannot even parse is no different.
    return [];
  }
}

export function savePreset(savedPresets, nameCandidate, configuration) {
  if (typeof nameCandidate !== "string") {
    throw new TypeError("Preset name must be a string");
  }
  const presets = createSavedPresets(savedPresets);
  const name = presetName(nameCandidate);
  if (!name) return { presets, preset: null, reason: "invalid-preset-name" };

  const duplicate = presets[findPresetNamed(presets, name)];
  const preset = {
    id: duplicate?.id || makeIdentifier("preset"),
    name,
    configuration: createConfiguration(configuration),
  };
  return {
    presets: duplicate
      ? presets.map((stored) => (stored.id === duplicate.id ? preset : stored))
      : [...presets, preset],
    preset,
    reason: null,
  };
}

/**
 * Whether saving under this name would replace a stored Preset rather than add
 * one. The interface asks so it can label the action before the user commits to
 * it; the answer has to come from here, because the trimming and the
 * case-folding that decide it are the same rules `savePreset` applies and a
 * second copy of them would drift.
 *
 * Every name is answered against the stored list alone. The examples are stored
 * Presets, so a name one of them holds is in use exactly as far as it is stored,
 * and saving under it replaces it like any other.
 *
 * The list is not repaired here, and has to arrive repaired — `createSavedPresets`
 * is the only door that produces one, and every caller comes through it. This is
 * asked on every keystroke in the save field, and the list it is asked about has
 * just been read and repaired to be handed over; repairing it a second time to
 * answer a question about names would deep-repair every stored Configuration
 * again for nothing. `sameConfiguration` above holds the same rule for the same
 * reason.
 */
export function presetNameInUse(savedPresets, nameCandidate) {
  const name = presetName(nameCandidate);
  if (!name) return false;
  return findPresetNamed(savedPresets, name) !== -1;
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
 * Runs on every render, so it repairs nothing: `createStoredPresets` is the only
 * door in from storage, and `configuration` is a repaired Configuration the
 * caller is already holding. Repeating either pass here would rebuild every
 * stored Configuration to reach an answer it was handed.
 */
export function describePresets(configuration, savedPresets) {
  const presets = Array.isArray(savedPresets) ? savedPresets : [];
  return presets.map((preset) => ({
    ...preset,
    selected: sameConfiguration(configuration, preset.configuration),
  }));
}

function availability(available, reason = null) {
  return { available, reason: available ? null : reason };
}

function sequenceRhythmCount(configuration) {
  return configuration.sequence.cycles.reduce((total, cycle) => total + cycle.rhythms.length, 0);
}

function addStructurePolicy(configuration) {
  return availability(sequenceRhythmCount(configuration) < MAX_RHYTHMS, "sequence-rhythm-limit");
}

function removeCyclePolicy(configuration, cycle) {
  if (configuration.sequence.cycles.length === 1) {
    return availability(false, "sequence-requires-cycle");
  }
  const activeCycleCount = configuration.sequence.cycles.filter(
    (candidate) => candidate.repetitions > 0,
  ).length;
  return availability(
    !(cycle.repetitions > 0 && activeCycleCount === 1),
    "sequence-requires-active-cycle",
  );
}

function cycleRepetitionsPolicy(configuration, cycle, repetitions) {
  const activeCycleCount = configuration.sequence.cycles.filter(
    (candidate) => candidate.repetitions > 0,
  ).length;
  return availability(
    !(repetitions === 0 && cycle.repetitions > 0 && activeCycleCount === 1),
    "sequence-requires-active-cycle",
  );
}

function removeRhythmPolicy(cycle) {
  return availability(cycle.rhythms.length > 1, "cycle-requires-rhythm");
}

/**
 * Preset notation is relative and never absolute: a Preset carries the change a
 * Cycle makes, not the tempo that change happened to produce when it was saved.
 * Flat 0 is the no-envelope state, so it gets no suffix at all.
 *
 * The spoken form spells the shape as a direction, which is what carries the
 * sign, and states the span in repetitions so a listener knows how long the
 * change takes. It names no tempo, for the same reason the written form does
 * not: neither is a reading of what is playing.
 */
const ENVELOPE_NOTATION = lookup({
  flat: (amount) => `Flat ${amount > 0 ? "+" : "−"}${Math.abs(amount)}`,
  up: (amount) => `↑${amount}`,
  down: (amount) => `↓${amount}`,
  peak: (amount) => `Peak ${amount}`,
});

const ENVELOPE_PHRASE = lookup({
  flat: (amount) => `stepping ${amount > 0 ? "up" : "down"} ${Math.abs(amount)} bpm`,
  up: (amount) => `rising ${amount} bpm`,
  down: (amount) => `falling ${amount} bpm`,
  peak: (amount) => `rising ${amount} bpm and back`,
});

/**
 * A Flat is one number, because one tempo is all it plays: its whole change
 * lands on the Cycle's first beat and the Cycle holds the result from there.
 * Writing it as a journey said something untrue — that the Cycle travels — and
 * no arrow fixes that, so a Flat has none. What it changed from is the previous
 * Cycle's reading, which is on screen directly above it.
 *
 * The ramps do travel, and say so with the tempos they pass through. The arrows
 * are the whole of the difference: a number is a tempo held, and a number with
 * somewhere to point is a tempo on its way.
 */
function envelopeTempoText(shape, incomingBpm, targetBpm, outgoingBpm) {
  const from = Math.round(incomingBpm);
  const to = Math.round(targetBpm);
  if (shape === ENVELOPE.FLAT) return String(to);
  if (shape === ENVELOPE.PEAK) return `${from} → ${to} → ${Math.round(outgoingBpm)}`;
  return `${from} → ${to}`;
}

export function describeConfiguration(configuration) {
  const valid = createConfiguration(configuration);
  const cycles = createSequenceTempoCurves(valid.bpm, valid.sequence.cycles).map(
    ({ id, active, incomingBpm, targetBpm, outgoingBpm, curve }, index) => {
      // The fold walks these same Cycles in this same order, so the position is
      // the Cycle — searching for the id it was just handed would be a second
      // answer to a question already settled.
      const cycle = valid.sequence.cycles[index];
      const { envelope, repetitions } = cycle;
      const { shape, amount } = envelope;
      const span = ` over ${repetitions} ${repetitions === 1 ? "repetition" : "repetitions"}`;
      return {
        id,
        active,
        rhythms: cycle.rhythms.map((rhythm, rhythmIndex) => {
          const ratio = cycle.timingMode === TIMING_MODE.POLYRHYTHM && rhythmIndex > 0;
          const subdivisions = SUBDIVISIONS.map((value) => {
            return {
              value,
              label: ratio
                ? subdivisionLabelWithoutUnit(value)
                : subdivisionLabel(value, rhythm.signature.unit),
            };
          });
          return {
            id: rhythm.id,
            meter: ratio
              ? `${rhythm.signature.count}:${cycle.rhythms[0].signature.count}`
              : `${rhythm.signature.count}/${rhythm.signature.unit}`,
            subdivision: subdivisions.find(({ value }) => value === rhythm.subdivision).label,
            subdivisions,
            denominatorAvailable: !ratio,
          };
        }),
        incomingBpm,
        // The tempo the Cycle opens on, which is its inherited one for a ramp and
        // its stepped one for a Flat — a Flat spends its whole change on the
        // first beat, so the tempo it inherited is never sounded.
        startBpm: curve.startBpm,
        targetBpm,
        outgoingBpm,
        // An inactive Cycle is skipped by the fold, so what it does to the tempo
        // is nothing at all — whatever envelope it is still holding for the day
        // its repetitions come back.
        tempo: active
          ? envelopeTempoText(shape, incomingBpm, targetBpm, outgoingBpm)
          : String(Math.round(incomingBpm)),
        notation: amount ? ENVELOPE_NOTATION[shape](amount) : "",
        accessibleNotation: amount ? `${ENVELOPE_PHRASE[shape](amount)}${active ? span : ""}` : "",
      };
    },
  );

  /*
   * The span of tempos a complete traversal actually visits, which is narrower
   * than the range the tempo control offers and is what the transport draws its
   * band from. A ramp passes through every tempo between the two it joins, so
   * the endpoints are the whole of what has to be collected; the starting tempo
   * is in there because a Sequence whose first Cycle steps away from it still
   * began by sounding it.
   */
  const visited = cycles
    .filter(({ active }) => active)
    .flatMap(({ incomingBpm, targetBpm, outgoingBpm }) => [incomingBpm, targetBpm, outgoingBpm])
    .concat(valid.bpm);

  /*
   * The narrower span the transport draws its band over: not every tempo a
   * traversal visits, but the stretch it travels continuously through, which is
   * the only one a bar can claim without saying the run played tempos it never
   * sounded.
   *
   * Two things are left out, and they are the two ADR-0016 names as the only
   * intentional discontinuities. A Flat jumps from one tempo to the next and
   * sounds neither of the ones between, so the gap it clears is visited at its
   * ends and travelled nowhere. And a ramp is asked for its endpoints rather
   * than for the amount written down: a ramp held against a limit has both of
   * them on that limit and travels nothing at all, however large the amount it
   * still carries.
   *
   * `null` rather than a range of zero width, so that having nothing to draw is
   * one answer here instead of a comparison every reader has to remember to
   * make.
   *
   * Adjacent ramps meet at their audible endpoint, so a run of them stays one
   * contiguous stretch. A Flat *between* two ramps does not: the two stretches
   * either side of it are still reported as one span, which claims the step it
   * cleared. Saying that exactly needs more than one bar to say it with.
   */
  const travelled = cycles.flatMap(({ active, startBpm, targetBpm, outgoingBpm }, index) =>
    active && valid.sequence.cycles[index].envelope.shape !== ENVELOPE.FLAT
      ? [startBpm, targetBpm, outgoingBpm]
      : [],
  );
  const minimum = Math.min(...travelled);
  const maximum = Math.max(...travelled);

  return {
    cycles,
    tempoRange: { minimum: Math.min(...visited), maximum: Math.max(...visited) },
    travelledRange: travelled.length && minimum !== maximum ? { minimum, maximum } : null,
    choices: {
      meterCounts: [...METER_COUNTS],
      meterUnits: [...METER_UNITS],
      subdivisions: [...SUBDIVISIONS],
      sounds: [...SOUNDS],
      stepVoices: [...STEP_VOICE_CHOICES],
      repetitions: [...REPETITIONS],
    },
    availability: {
      addCycle: addStructurePolicy(valid),
      cycles: Object.fromEntries(
        valid.sequence.cycles.map((cycle) => [
          cycle.id,
          {
            remove: removeCyclePolicy(valid, cycle),
            addRhythm: addStructurePolicy(valid),
            repetitions: Object.fromEntries(
              REPETITIONS.map((repetitions) => [
                repetitions,
                cycleRepetitionsPolicy(valid, cycle, repetitions),
              ]),
            ),
            rhythms: Object.fromEntries(
              cycle.rhythms.map((rhythm) => [
                rhythm.id,
                {
                  remove: removeRhythmPolicy(cycle),
                },
              ]),
            ),
          },
        ]),
      ),
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
      sequence: {
        cycles: current.sequence.cycles.map((candidate) =>
          candidate.id === cycleId
            ? {
                ...candidate,
                rhythms: candidate.rhythms.map((rhythm) =>
                  rhythm.id === rhythmId ? updater(rhythm) : rhythm,
                ),
              }
            : candidate,
        ),
      },
    },
  };
}

/**
 * Every caller reaches this through `changeConfiguration`, which repairs before
 * it edits, so the argument is always one of the four voices. The null
 * prototype is not load-bearing today; it is here so the guarantee is the
 * table's own rather than something a reader has to go and re-derive from the
 * repair path each time.
 */
const NEXT_STEP_VOICE = lookup({
  [STEP.PRIMARY]: STEP.SECONDARY,
  [STEP.SECONDARY]: STEP.TERTIARY,
  [STEP.TERTIARY]: STEP.OFF,
  [STEP.OFF]: STEP.PRIMARY,
});

function nextStepVoice(voice) {
  return NEXT_STEP_VOICE[voice] || STEP.PRIMARY;
}

/**
 * A control carries a numeral, which is narrower than what `Number` reads:
 * `0x10`, `0b100`, `0o10` and `1e1` are all literals a source file may hold and
 * no control ever produces. The gap belongs to every field, so it is closed at
 * the shared Configuration boundary. Surrounding space is not part of it: that
 * is a plain numeral a programmatic caller may pass.
 */
const NUMERAL = /^-?\d+(\.\d+)?$/;

function formNumber(value) {
  if (typeof value === "string" && !NUMERAL.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasString(edit, property) {
  return typeof edit[property] === "string";
}

function hasFormNumber(edit, property) {
  return typeof edit[property] === "number" || typeof edit[property] === "string";
}

function targetsCycle(edit) {
  return hasString(edit, "cycleId");
}

function targetsRhythm(edit) {
  return targetsCycle(edit) && hasString(edit, "rhythmId");
}

function numberInRange(edit, property, minimum, maximum, integer = false) {
  const value = formNumber(edit[property]);
  return (
    value !== null && value >= minimum && value <= maximum && (!integer || Number.isInteger(value))
  );
}

function findCycle(configuration, cycleId) {
  return configuration.sequence.cycles.find(({ id }) => id === cycleId);
}

function findRhythm(configuration, cycleId, rhythmId) {
  return findCycle(configuration, cycleId)?.rhythms.find(({ id }) => id === rhythmId);
}

function unchanged(configuration, reason = null) {
  return { configuration, consequence: "none", reason };
}

function rejectedByPolicy(configuration, policy) {
  return policy.available ? null : unchanged(configuration, policy.reason);
}

function changeRhythm(current, edit, consequence, updater) {
  const result = editRhythm(current, edit.cycleId, edit.rhythmId, updater);
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
      return changed(
        {
          ...current,
          sequence: {
            cycles: [...current.sequence.cycles, createCycle()],
          },
        },
        "restart-transport-run",
      );
    },
  },
  "add-rhythm": {
    validPayload: targetsCycle,
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const rejection = rejectedByPolicy(current, addStructurePolicy(current));
      if (rejection) return rejection;
      return changed(
        {
          ...current,
          sequence: {
            cycles: current.sequence.cycles.map((candidate) =>
              candidate.id === edit.cycleId
                ? { ...candidate, rhythms: [...candidate.rhythms, createRhythm()] }
                : candidate,
            ),
          },
        },
        "restart-transport-run",
      );
    },
  },
  /**
   * One gesture — a listener presses a Grid control — and therefore one edit.
   * What the press means is a property of the layer rather than of the payload:
   * `displayMode` decides how many pattern positions the control runs across,
   * and it is in the Configuration, so this command derives the run rather than
   * being told it. That is what keeps the interface from being able to describe
   * a control the layer does not offer.
   *
   * The run is the whole of what a control addresses, so its voice is the voice
   * of every position inside it: the leading position takes the advanced voice
   * and the rest take the canonical `tertiary` beneath it. `off` is the
   * exception, and it is the one that has to be, because `off` is the only
   * silent voice — a control announced as off with trailing `tertiary`
   * positions would go on sounding under a control that says it does not.
   *
   * In Subdivision Mode a run is one position, so the trailing rule has nothing
   * to write and the `off` exception cannot arise. The two Display modes reach
   * the same code and differ only in the length of the run.
   */
  "advance-control-voice": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "control"),
    validValue: (edit) => numberInRange(edit, "control", 0, Number.MAX_SAFE_INTEGER, true),
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      const rhythm = findRhythm(current, edit.cycleId, edit.rhythmId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      if (!rhythm) return unchanged(current, "rhythm-not-found");
      const control = controls(rhythm)[formNumber(edit.control)];
      if (!control) return unchanged(current, "control-not-found");
      const [firstPosition] = control.positions;
      const nextVoice = nextStepVoice(control.voice);
      const trailingVoice = nextVoice === STEP.OFF ? STEP.OFF : STEP.TERTIARY;
      const run = new Set(control.positions);
      return changeRhythm(current, edit, "update-step-voices", (candidate) => ({
        ...candidate,
        steps: candidate.steps.map((voice, position) => {
          if (position === firstPosition) return nextVoice;
          return run.has(position) ? trailingVoice : voice;
        }),
      }));
    },
  },
  "apply-preset": {
    validPayload: (edit) => Boolean(edit.configuration) && typeof edit.configuration === "object",
    leavesUnchanged: (current, edit) =>
      sameConfiguration(current, createConfiguration(edit.configuration)),
    apply(_current, edit) {
      return changed(freshPresetConfiguration(edit.configuration), "restart-transport-run");
    },
  },
  "remove-cycle": {
    validPayload: targetsCycle,
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const rejection = rejectedByPolicy(current, removeCyclePolicy(current, cycle));
      if (rejection) return rejection;
      return changed(
        createConfiguration({
          ...current,
          sequence: {
            cycles: current.sequence.cycles.filter(({ id }) => id !== edit.cycleId),
          },
        }),
        "restart-transport-run",
      );
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
      return changed(
        {
          ...current,
          sequence: {
            cycles: current.sequence.cycles.map((candidate) =>
              candidate.id === edit.cycleId
                ? {
                    ...candidate,
                    rhythms: candidate.rhythms.filter(({ id }) => id !== edit.rhythmId),
                  }
                : candidate,
            ),
          },
        },
        "restart-transport-run",
      );
    },
  },
  "set-cycle-repetitions": {
    validPayload: (edit) => targetsCycle(edit) && hasFormNumber(edit, "repetitions"),
    validValue: (edit) =>
      numberInRange(edit, "repetitions", REPETITION_LIMIT.minimum, REPETITION_LIMIT.maximum, true),
    leavesUnchanged: (current, edit) =>
      findCycle(current, edit.cycleId)?.repetitions === formNumber(edit.repetitions),
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const repetitions = formNumber(edit.repetitions);
      const rejection = rejectedByPolicy(
        current,
        cycleRepetitionsPolicy(current, cycle, repetitions),
      );
      if (rejection) return rejection;
      return changed(
        {
          ...current,
          sequence: {
            cycles: current.sequence.cycles.map((candidate) =>
              candidate.id === edit.cycleId ? { ...candidate, repetitions } : candidate,
            ),
          },
        },
        "restart-transport-run",
      );
    },
  },
  "set-cycle-timing-mode": {
    validPayload: (edit) => targetsCycle(edit) && hasString(edit, "timingMode"),
    validValue: (edit) => TIMING_MODES.includes(edit.timingMode),
    leavesUnchanged: (current, edit) =>
      findCycle(current, edit.cycleId)?.timingMode === edit.timingMode,
    apply(current, edit) {
      if (!findCycle(current, edit.cycleId)) return unchanged(current, "cycle-not-found");
      return changed(
        {
          ...current,
          sequence: {
            cycles: current.sequence.cycles.map((cycle) =>
              cycle.id === edit.cycleId ? { ...cycle, timingMode: edit.timingMode } : cycle,
            ),
          },
        },
        "restart-transport-run",
      );
    },
  },
  /*
   * The shape and the amount are one edit because they are one value: choosing
   * a shape carries the magnitude across with it, and choosing an amount is
   * choosing it for the shape already selected. Splitting them would let a
   * caller write an amount no shape's range admits.
   *
   * Its consequence is a timing one, the same `set-tempo` produces, so a change
   * made while playing restarts the run once. Opening or closing the drawer is
   * not an edit and never reaches here.
   */
  "set-cycle-envelope": {
    validPayload: (edit) =>
      targetsCycle(edit) && hasString(edit, "shape") && hasFormNumber(edit, "amount"),
    // A whole number inside the range the chosen shape offers, which is what a
    // Meter count and a repetition count are held to as well: a well-formed edit
    // carrying a value the domain rejects reports back rather than committing
    // some other value the author did not ask for. The bound is read from the
    // shape being set, so the same amount can be valid for a Flat and refused
    // for a ramp — Flat's is the only range that reaches zero and below.
    //
    // The normaliser still clamps, and the two do not disagree: it repairs
    // stored data, which arrives with nobody to report back to, while an edit
    // has an author and an interface to say no in.
    validValue: (edit) => {
      const limit = ENVELOPE_LIMIT[edit.shape];
      return Boolean(limit) && numberInRange(edit, "amount", limit.minimum, limit.maximum, true);
    },
    leavesUnchanged: (current, edit) => {
      const envelope = findCycle(current, edit.cycleId)?.envelope;
      const next = normaliseEnvelope({ shape: edit.shape, amount: formNumber(edit.amount) });
      return envelope?.shape === next.shape && envelope.amount === next.amount;
    },
    apply(current, edit) {
      const cycle = findCycle(current, edit.cycleId);
      if (!cycle) return unchanged(current, "cycle-not-found");
      const envelope = normaliseEnvelope({ shape: edit.shape, amount: formNumber(edit.amount) });
      return changed(
        {
          ...current,
          sequence: {
            cycles: current.sequence.cycles.map((candidate) =>
              candidate.id === edit.cycleId ? { ...candidate, envelope } : candidate,
            ),
          },
        },
        "restart-transport-run",
      );
    },
  },
  "set-display-mode": {
    validPayload: (edit) => targetsRhythm(edit) && hasString(edit, "displayMode"),
    validValue: (edit) => DISPLAY_MODES.includes(edit.displayMode),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.displayMode === edit.displayMode,
    apply(current, edit) {
      return changeRhythm(current, edit, "update-step-voices", (rhythm) => ({
        ...rhythm,
        displayMode: edit.displayMode,
        steps: canonicalPattern(rhythm.signature.count, rhythm.subdivision),
      }));
    },
  },
  "set-meter-count": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "count"),
    validValue: (edit) =>
      numberInRange(edit, "count", METER_COUNT_LIMIT.minimum, METER_COUNT_LIMIT.maximum, true),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.signature.count === formNumber(edit.count),
    apply(current, edit) {
      return changeRhythm(current, edit, "restart-transport-run", (rhythm) => {
        const signature = {
          ...rhythm.signature,
          count: formNumber(edit.count),
        };
        return {
          ...rhythm,
          signature,
          steps: canonicalPattern(signature.count, rhythm.subdivision),
        };
      });
    },
  },
  "set-meter-unit": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "unit"),
    validValue: (edit) => METER_UNITS.includes(formNumber(edit.unit)),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.signature.unit === formNumber(edit.unit),
    apply(current, edit) {
      return changeRhythm(current, edit, "update-configuration", (rhythm) => ({
        ...rhythm,
        signature: { ...rhythm.signature, unit: formNumber(edit.unit) },
      }));
    },
  },
  "set-muted": {
    validPayload: (edit) => targetsRhythm(edit) && typeof edit.muted === "boolean",
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.muted === edit.muted,
    apply(current, edit) {
      return changeRhythm(current, edit, "update-mix", (rhythm) => ({
        ...rhythm,
        muted: edit.muted,
      }));
    },
  },
  "set-rhythm-volume": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "volume"),
    validValue: (edit) => numberInRange(edit, "volume", 0, 1),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.volume === formNumber(edit.volume),
    apply(current, edit) {
      return changeRhythm(current, edit, "update-mix", (rhythm) => ({
        ...rhythm,
        volume: formNumber(edit.volume),
      }));
    },
  },
  "set-sound": {
    validPayload: (edit) => targetsRhythm(edit) && hasString(edit, "sound"),
    validValue: (edit) => SOUNDS.includes(edit.sound),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.sound === edit.sound,
    apply(current, edit) {
      return changeRhythm(current, edit, "update-mix", (rhythm) => ({
        ...rhythm,
        sound: edit.sound,
      }));
    },
  },
  "set-stereo-position": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "pan"),
    validValue: (edit) => numberInRange(edit, "pan", -1, 1),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.pan === formNumber(edit.pan),
    apply(current, edit) {
      return changeRhythm(current, edit, "update-mix", (rhythm) => ({
        ...rhythm,
        pan: formNumber(edit.pan),
      }));
    },
  },
  "set-subdivision": {
    validPayload: (edit) => targetsRhythm(edit) && hasFormNumber(edit, "subdivision"),
    validValue: (edit) => SUBDIVISIONS.includes(formNumber(edit.subdivision)),
    leavesUnchanged: (current, edit) =>
      findRhythm(current, edit.cycleId, edit.rhythmId)?.subdivision ===
      formNumber(edit.subdivision),
    apply(current, edit) {
      return changeRhythm(current, edit, "restart-transport-run", (rhythm) => {
        const subdivision = formNumber(edit.subdivision);
        return {
          ...rhythm,
          subdivision,
          steps: canonicalPattern(rhythm.signature.count, subdivision),
        };
      });
    },
  },
  "set-tempo": {
    validPayload: (edit) => hasFormNumber(edit, "bpm"),
    validValue: (edit) =>
      numberInRange(edit, "bpm", TEMPO_LIMIT.minimum, TEMPO_LIMIT.maximum, true),
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
