import test from "node:test";
import assert from "node:assert/strict";

import { STEP } from "../model.js";
import { SharedTransport } from "../shared-transport.js";

let rhythmId = 0;
const createLayer = (overrides = {}) => {
  const signature = overrides.signature || { count: 4, unit: 4 };
  const subdivision = overrides.subdivision || 1;
  const length = signature.count * subdivision;
  const supplied = overrides.steps || [];
  return {
    id: overrides.id || `rhythm-${++rhythmId}`,
    signature,
    subdivision,
    steps: Array.from(
      { length },
      (_, index) => supplied[index] || (index === 0 ? STEP.PRIMARY : STEP.SECONDARY),
    ),
  };
};

const sequence = (bpm, rhythms, repetitions = 1) => ({
  bpm,
  sequence: {
    cycles: [{ id: "cycle", repetitions, rhythms }],
  },
});

test("legacy flat rhythm shapes are not valid shared-transport input", () => {
  const rhythm = createLayer({ id: "legacy" });

  assert.throws(
    () =>
      new SharedTransport().start(
        {
          bpm: 60,
          cycles: [{ id: "legacy-cycle", repetitions: 1, rhythms: [rhythm] }],
        },
        0,
      ),
    TypeError,
  );
  assert.throws(() => new SharedTransport().start({ bpm: 60, layers: [rhythm] }, 0), TypeError);
});

test("cycles play sequentially after their complete repetitions and the sequence loops", () => {
  const first = createLayer({
    id: "first",
    signature: { count: 1, unit: 4 },
  });
  const second = createLayer({
    id: "second",
    signature: { count: 1, unit: 4 },
  });
  const transport = new SharedTransport();

  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          { id: "first-cycle", repetitions: 2, rhythms: [first] },
          { id: "second-cycle", repetitions: 1, rhythms: [second] },
        ],
      },
    },
    10,
  );

  assert.deepEqual(
    transport.plan(9.9, 14).map(({ layerId, audioTime }) => ({ layerId, audioTime })),
    [
      { layerId: "first", audioTime: 10 },
      { layerId: "first", audioTime: 11 },
      { layerId: "second", audioTime: 12 },
      { layerId: "first", audioTime: 13 },
    ],
  );
});

test("transport position identifies the active cycle and repetition", () => {
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          {
            id: "four-four-cycle",
            repetitions: 2,
            rhythms: [createLayer({ signature: { count: 4, unit: 4 } })],
          },
          {
            id: "three-four-cycle",
            repetitions: 2,
            rhythms: [createLayer({ signature: { count: 3, unit: 4 } })],
          },
        ],
      },
    },
    10,
  );

  assert.deepEqual(transport.position(14.5), {
    cycleId: "four-four-cycle",
    cycleIndex: 0,
    repetitionIndex: 1,
  });
  assert.deepEqual(transport.position(18.5), {
    cycleId: "three-four-cycle",
    cycleIndex: 1,
    repetitionIndex: 0,
  });
  assert.deepEqual(transport.position(24.5), {
    cycleId: "four-four-cycle",
    cycleIndex: 0,
    repetitionIndex: 0,
  });
});

test("inactive cycles are skipped by scheduling and transport position", () => {
  const inactive = createLayer({ id: "inactive", signature: { count: 1, unit: 4 } });
  const active = createLayer({ id: "active", signature: { count: 1, unit: 4 } });
  const transport = new SharedTransport();

  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          { id: "off-cycle", repetitions: 0, rhythms: [inactive] },
          { id: "on-cycle", repetitions: 1, rhythms: [active] },
        ],
      },
    },
    10,
  );

  assert.deepEqual(transport.position(9.9), {
    cycleId: "on-cycle",
    cycleIndex: 0,
    repetitionIndex: 0,
  });
  assert.deepEqual(
    transport.plan(9.9, 11).map(({ layerId, audioTime }) => ({ layerId, audioTime })),
    [{ layerId: "active", audioTime: 10 }],
  );
});

test("inactive rhythms have no visual pattern position", () => {
  const first = createLayer({ id: "first", signature: { count: 1, unit: 4 } });
  const second = createLayer({ id: "second", signature: { count: 1, unit: 4 } });
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          { id: "one", repetitions: 1, rhythms: [first] },
          { id: "two", repetitions: 1, rhythms: [second] },
        ],
      },
    },
    0,
  );

  assert.equal(transport.patternPosition("first", 1.25), null);
  assert.equal(transport.patternPosition("second", 1.25), 0);
});

test("a polymeter cycle does not advance until every rhythm returns to downbeat", () => {
  const four = createLayer({ id: "four", signature: { count: 4, unit: 4 } });
  const three = createLayer({ id: "three", signature: { count: 3, unit: 4 } });
  const next = createLayer({ id: "next", signature: { count: 1, unit: 4 } });
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          { id: "polymeter", repetitions: 1, rhythms: [four, three] },
          { id: "next-cycle", repetitions: 1, rhythms: [next] },
        ],
      },
    },
    0,
  );

  const events = transport.plan(0, 13);
  assert.equal(events.find((event) => event.layerId === "next").audioTime, 12);
  assert.deepEqual(
    events.filter((event) => event.layerId === "four").map((event) => event.audioTime),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    events.filter((event) => event.layerId === "three").map((event) => event.audioTime),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
});

test("4/4 with one pulse per quarter plans four quarter-note events", () => {
  const layer = createLayer({
    id: "four-four-k1",
    signature: { count: 4, unit: 4 },
    subdivision: 1,
    steps: [STEP.PRIMARY, STEP.SECONDARY, STEP.SECONDARY, STEP.SECONDARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 10);

  assert.deepEqual(transport.plan(9.9, 14), [
    {
      layerId: "four-four-k1",
      absoluteStep: 0,
      patternPosition: 0,
      voice: STEP.PRIMARY,
      audioTime: 10,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 1,
      patternPosition: 1,
      voice: STEP.SECONDARY,
      audioTime: 11,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 2,
      patternPosition: 2,
      voice: STEP.SECONDARY,
      audioTime: 12,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 3,
      patternPosition: 3,
      voice: STEP.SECONDARY,
      audioTime: 13,
    },
  ]);
});

test("4/4 with two pulses per quarter plans half-quarter intervals", () => {
  const layer = createLayer({
    id: "four-four-k2",
    signature: { count: 4, unit: 4 },
    subdivision: 2,
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 1.1).map((event) => event.audioTime),
    [0, 0.5, 1],
  );
});

test("4/4 with three pulses per quarter plans triplet intervals", () => {
  const layer = createLayer({
    id: "four-four-k3",
    signature: { count: 4, unit: 4 },
    subdivision: 3,
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 1.1).map((event) => event.audioTime),
    [0, 0.3333333333333333, 0.6666666666666666, 1],
  );
});

test("5/4 with one pulse per quarter plans five positions per meter", () => {
  const layer = createLayer({
    id: "five-four",
    signature: { count: 5, unit: 4 },
    subdivision: 1,
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 2.5).map((event) => event.audioTime),
    [0, 0.5, 1, 1.5, 2],
  );
});

test("7/8 at 60 BPM plans seven primary beats one second apart", () => {
  const layer = createLayer({
    id: "seven-eight",
    signature: { count: 7, unit: 8 },
    subdivision: 1,
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 7).map((event) => event.audioTime),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

/**
 * BPM names the shared primary beat. The denominator describes that beat in
 * the written Meter but does not give one layer a faster clock than another.
 * Numerators still determine when independently repeating Meters return to a
 * downbeat together.
 */
test("different Meter denominators share the primary beat and numerator span", () => {
  const whole = createLayer({ id: "four-one", signature: { count: 4, unit: 1 } });
  const quarter = createLayer({ id: "two-four", signature: { count: 2, unit: 4 } });
  const transport = new SharedTransport();
  const at = (time) => Number(time.toFixed(6));

  transport.start(sequence(60, [whole, quarter]), 0);
  const events = transport.plan(0, 5);
  const times = (id) =>
    events.filter((event) => event.layerId === id).map((event) => at(event.audioTime));

  assert.deepEqual(times("four-one"), [0, 1, 2, 3, 4]);
  assert.deepEqual(times("two-four"), [0, 1, 2, 3, 4]);
});

test("a computed fractional event exactly at the horizon remains excluded", () => {
  const layer = createLayer({
    id: "fractional-boundary",
    signature: { count: 1, unit: 1 },
    subdivision: 3,
    steps: [STEP.PRIMARY, STEP.SECONDARY, STEP.SECONDARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(30, [layer]), 12345.678);

  assert.deepEqual(
    transport.plan(12345.67, 12347.011333333334).map((event) => ({
      absoluteStep: event.absoluteStep,
      audioTime: event.audioTime,
    })),
    [
      { absoluteStep: 0, audioTime: 12345.678 },
      { absoluteStep: 1, audioTime: 12346.344666666666 },
    ],
  );
});

test("an off step produces no rhythm event", () => {
  const layer = createLayer({
    id: "off-steps",
    signature: { count: 4, unit: 4 },
    steps: [STEP.PRIMARY, STEP.OFF, STEP.SECONDARY, STEP.OFF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 2).map((event) => event.patternPosition),
    [0, 2],
  );
});

test("rhythm events expose every audible Step voice by name", () => {
  const layer = createLayer({
    id: "voices",
    signature: { count: 3, unit: 4 },
    steps: [STEP.TERTIARY, STEP.SECONDARY, STEP.PRIMARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(transport.plan(0, 3), [
    {
      layerId: "voices",
      absoluteStep: 0,
      patternPosition: 0,
      voice: STEP.TERTIARY,
      audioTime: 0,
    },
    {
      layerId: "voices",
      absoluteStep: 1,
      patternPosition: 1,
      voice: STEP.SECONDARY,
      audioTime: 1,
    },
    {
      layerId: "voices",
      absoluteStep: 2,
      patternPosition: 2,
      voice: STEP.PRIMARY,
      audioTime: 2,
    },
  ]);
});

/**
 * Only `off` is filtered here, and that is the whole of the planning side's
 * involvement in audibility. ADR-0008 puts the decision in one place — the
 * pitch table `scheduleClickVoice` reads — so a voice this module has never
 * heard of is carried through by name rather than guessed at. Planning is not
 * where a repair belongs: a second opinion on the vocabulary would be a second
 * place to change when it moves.
 */
test("a voice outside the vocabulary is planned by name, not filtered", () => {
  const layer = createLayer({
    id: "stranger",
    signature: { count: 2, unit: 4 },
    steps: [STEP.PRIMARY, "full"],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 2).map((event) => event.voice),
    [STEP.PRIMARY, "full"],
  );
});

test("Step-voice edits preserve transport position and affect future events", () => {
  const layer = createLayer({
    id: "live-voice",
    signature: { count: 2, unit: 4 },
    steps: [STEP.PRIMARY, STEP.SECONDARY],
  });
  const state = sequence(60, [layer]);
  const transport = new SharedTransport();

  transport.start(state, 10);
  transport.plan(9.9, 10.5);
  layer.steps[1] = STEP.TERTIARY;
  transport.updateStepVoices(state);

  assert.equal(transport.origin, 10);
  assert.deepEqual(transport.plan(10.4, 11.1), [
    {
      layerId: "live-voice",
      absoluteStep: 1,
      patternPosition: 1,
      voice: STEP.TERTIARY,
      audioTime: 11,
    },
  ]);
});

test("Step-voice updates reject legacy flat rhythm shapes", () => {
  const rhythm = createLayer({ id: "legacy-voices" });
  const transport = new SharedTransport();

  transport.start(sequence(60, [rhythm]), 0);

  assert.throws(() => transport.updateStepVoices({ bpm: 60, layers: [rhythm] }), TypeError);
});

test("overlapping polls plan each absolute step only once", () => {
  const layer = createLayer({
    id: "steady",
    signature: { count: 4, unit: 4 },
    steps: [STEP.PRIMARY, STEP.SECONDARY, STEP.SECONDARY, STEP.SECONDARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 5);
  transport.plan(4.9, 6.1);

  assert.deepEqual(transport.plan(5.98, 6.6), [
    {
      layerId: "steady",
      absoluteStep: 3,
      patternPosition: 3,
      voice: STEP.SECONDARY,
      audioTime: 6.5,
    },
  ]);
});

test("a late poll discards missed events without restarting transport phase", () => {
  const layer = createLayer({
    id: "phase",
    signature: { count: 4, unit: 4 },
    steps: [STEP.PRIMARY, STEP.SECONDARY, STEP.SECONDARY, STEP.SECONDARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 10);

  assert.deepEqual(transport.plan(12.2, 13.1), [
    {
      layerId: "phase",
      absoluteStep: 5,
      patternPosition: 1,
      voice: STEP.SECONDARY,
      audioTime: 12.5,
    },
    {
      layerId: "phase",
      absoluteStep: 6,
      patternPosition: 2,
      voice: STEP.SECONDARY,
      audioTime: 13,
    },
  ]);
});

test("a transport run retains its starting timing snapshot", () => {
  const layer = createLayer({
    id: "snapshot",
    signature: { count: 2, unit: 4 },
    steps: [STEP.PRIMARY, STEP.OFF],
  });
  const state = sequence(60, [layer]);
  const transport = new SharedTransport();

  transport.start(state, 20);
  state.bpm = 120;
  layer.subdivision = 5;
  layer.steps[1] = STEP.SECONDARY;

  assert.deepEqual(transport.plan(19.9, 22), [
    {
      layerId: "snapshot",
      absoluteStep: 0,
      patternPosition: 0,
      voice: STEP.PRIMARY,
      audioTime: 20,
    },
  ]);
});

test("visual pattern position derives from the transport origin", () => {
  const layer = createLayer({
    id: "playhead",
    signature: { count: 1, unit: 4 },
    subdivision: 3,
    steps: [STEP.PRIMARY, STEP.SECONDARY, STEP.SECONDARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 30);

  assert.equal(transport.patternPosition("playhead", 29.9), 0);
  assert.equal(transport.patternPosition("playhead", 30.8), 2);
});

test("visual pattern position aligns with a planned fractional event boundary", () => {
  const layer = createLayer({
    id: "fractional-playhead",
    signature: { count: 1, unit: 2 },
    subdivision: 3,
  });
  const transport = new SharedTransport();

  transport.start(sequence(96, [layer]), 0.06);
  const event = transport.plan(0, 1).find((candidate) => candidate.absoluteStep === 2);

  assert.equal(event.audioTime, 0.4766666666666667);
  assert.equal(event.patternPosition, 2);
  assert.equal(
    transport.patternPosition("fractional-playhead", event.audioTime),
    event.patternPosition,
  );
  assert.equal(
    transport.patternPosition("fractional-playhead", event.audioTime - Number.EPSILON),
    1,
  );
});

test("mute does not change a rhythm layer event timeline", () => {
  const layer = createLayer({
    id: "muted",
    muted: true,
    signature: { count: 1, unit: 4 },
    steps: [STEP.PRIMARY],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 50);

  assert.deepEqual(transport.plan(49.9, 51), [
    {
      layerId: "muted",
      absoluteStep: 0,
      patternPosition: 0,
      voice: STEP.PRIMARY,
      audioTime: 50,
    },
  ]);
});

test("a sequence with no active cycles schedules nothing and reports no position", () => {
  const transport = new SharedTransport();

  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          { id: "first-cycle", repetitions: 0, rhythms: [createLayer({ id: "first" })] },
          { id: "second-cycle", repetitions: 0, rhythms: [createLayer({ id: "second" })] },
        ],
      },
    },
    10,
  );

  assert.deepEqual(transport.plan(10.5, 12), []);
  assert.equal(transport.position(10.5), null);
  assert.equal(transport.patternPosition("first", 10.5), null);
});

test("starting a new transport run resets origin and scheduling position together", () => {
  const layer = createLayer({
    id: "restart",
    signature: { count: 1, unit: 4 },
    steps: [STEP.PRIMARY],
  });
  const transport = new SharedTransport();
  const state = sequence(60, [layer]);

  transport.start(state, 60);
  transport.plan(59.9, 61);
  transport.start(state, 70);

  assert.equal(transport.origin, 70);
  assert.deepEqual(transport.plan(69.9, 71), [
    {
      layerId: "restart",
      absoluteStep: 0,
      patternPosition: 0,
      voice: STEP.PRIMARY,
      audioTime: 70,
    },
  ]);
});
