import test from "node:test";
import assert from "node:assert/strict";

import { STEP } from "../model.ts";
import { SharedTransport } from "../shared-transport.ts";

let rhythmId = 0;
/**
 * A rhythm layer of the shape `createConfiguration` produces, so that a test
 * asking for a property of one gets a layer that has it. `muted` is carried
 * through and defaulted the way `configuration.ts` defaults it, because a
 * helper that silently dropped it would hand a test about mute an unmuted
 * layer and let it pass without ever reaching the behaviour it names.
 */
const createLayer = (
  overrides: {
    id?: string;
    signature?: { count: number; unit: number };
    subdivision?: number;
    muted?: boolean;
    steps?: string[];
  } = {},
) => {
  const signature = overrides.signature || { count: 4, unit: 4 };
  const subdivision = overrides.subdivision || 1;
  const length = signature.count * subdivision;
  const supplied = overrides.steps || [];
  return {
    id: overrides.id || `rhythm-${++rhythmId}`,
    signature,
    subdivision,
    muted: Boolean(overrides.muted),
    steps: Array.from(
      { length },
      (_, index) => supplied[index] || (index === 0 ? STEP.PRIMARY : STEP.SECONDARY),
    ),
  };
};

/**
 * A shape the transport is meant to refuse, widened to the one its methods
 * declare. The signatures already rule these out, so no typed call can pose the
 * question at all — but the input these guards exist for arrives from storage or
 * from a Configuration written before the Sequence wrapper, where nothing was
 * checked, and the refusal under test is the runtime one. Widening happens here,
 * at the one call boundary, so that every other call in the file stays checked
 * against the real signature.
 */
const refused = (shape: object) => shape as Parameters<SharedTransport["start"]>[0];

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
        refused({
          bpm: 60,
          cycles: [{ id: "legacy-cycle", repetitions: 1, rhythms: [rhythm] }],
        }),
        0,
      ),
    TypeError,
  );
  assert.throws(
    () => new SharedTransport().start(refused({ bpm: 60, layers: [rhythm] }), 0),
    TypeError,
  );
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

test("an Up envelope schedules Rhythm events from exact musical positions", () => {
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          {
            id: "up-cycle",
            envelope: { shape: "up", amount: 60 },
            repetitions: 1,
            rhythms: [createLayer({ id: "ramp", signature: { count: 4, unit: 4 } })],
          },
        ],
      },
    },
    0,
  );

  assert.deepEqual(
    transport.plan(0, 2.7).map(({ audioTime }) => audioTime),
    [0, 0.8925742052568391, 1.6218604324326575, 2.2384631517416906],
  );
});

test("a following Cycle inherits the audible endpoint and a Sequence loop resets it", () => {
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          {
            id: "rise",
            envelope: { shape: "up", amount: 60 },
            repetitions: 1,
            rhythms: [createLayer({ id: "first", signature: { count: 1, unit: 4 } })],
          },
          {
            id: "inherit",
            envelope: null,
            repetitions: 1,
            rhythms: [createLayer({ id: "second", signature: { count: 1, unit: 4 } })],
          },
        ],
      },
    },
    0,
  );

  const events = transport.plan(0, 1.3);
  assert.deepEqual(
    events.map(({ layerId, audioTime }) => ({ layerId, audioTime })),
    [
      { layerId: "first", audioTime: 0 },
      { layerId: "second", audioTime: Math.LN2 },
      { layerId: "first", audioTime: Math.LN2 + 0.5 },
    ],
  );
  assert.equal(transport.currentBpm(0.4054651081081644), 90);
  assert.equal(transport.currentBpm(events[2].audioTime), 60);
});

test("Cycle repetitions lengthen one continuous envelope", () => {
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          {
            id: "long-rise",
            envelope: { shape: "up", amount: 60 },
            repetitions: 2,
            rhythms: [createLayer({ id: "pulse", signature: { count: 1, unit: 4 } })],
          },
        ],
      },
    },
    0,
  );

  assert.deepEqual(
    transport.plan(0, 1).map(({ audioTime }) => audioTime),
    [0, 0.8109302162163288],
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

test("polymeter Rhythm layers stay phase-locked throughout a continuous envelope", () => {
  const four = createLayer({ id: "ramped-four", signature: { count: 4, unit: 4 } });
  const three = createLayer({ id: "ramped-three", signature: { count: 3, unit: 4 } });
  const next = createLayer({ id: "after-ramp", signature: { count: 1, unit: 4 } });
  const transport = new SharedTransport();
  transport.start(
    {
      bpm: 60,
      sequence: {
        cycles: [
          {
            id: "ramped-polymeter",
            envelope: { shape: "up", amount: 60 },
            repetitions: 1,
            rhythms: [four, three],
          },
          { id: "after", envelope: null, repetitions: 1, rhythms: [next] },
        ],
      },
    },
    0,
  );

  const events = transport.plan(0, 8.4);
  const times = (layerId) =>
    events.filter((event) => event.layerId === layerId).map((event) => event.audioTime);
  assert.deepEqual(times("ramped-four"), times("ramped-three"));
  assert.equal(times("after-ramp")[0], 12 * Math.LN2);
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

  assert.throws(
    () => transport.updateStepVoices(refused({ bpm: 60, layers: [rhythm] })),
    TypeError,
  );
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

/**
 * Mute is a gain of zero applied when a click is committed, in `metronome.ts`.
 * Nothing about it belongs to planning, so a muted layer keeps every event it
 * would otherwise have had: unmuting mid-run resumes in phase rather than
 * starting a rhythm that was never being counted.
 */
test("mute does not change a rhythm layer event timeline", () => {
  const layer = createLayer({
    id: "muted",
    muted: true,
    signature: { count: 1, unit: 4 },
    steps: [STEP.PRIMARY],
  });
  const transport = new SharedTransport();

  // The layer this asserts against has to be the muted one. Compared against an
  // unmuted layer the assertion below holds for a reason that says nothing
  // about mute, and would go on holding if mute did silence the planner.
  assert.equal(layer.muted, true);

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
  // No timing means no tempo to report either, which is the reading `app.ts`
  // falls back to the stored tempo on.
  assert.equal(transport.currentBpm(10.5), null);
});

/**
 * The readout asks for the tempo at whatever instant the frame lands on, and a
 * frame can land before the origin: a run is anchored a little ahead of the
 * clock so the first click has time to be committed, and the interface is
 * already drawing during that gap. What it should read there is the tempo the
 * run is about to start at, not a position extrapolated backwards off the front
 * of the first Cycle.
 */
test("a tempo read before the origin is the tempo the run will start at", () => {
  const transport = new SharedTransport();

  transport.start(
    {
      bpm: 90,
      sequence: {
        cycles: [
          {
            id: "rising",
            envelope: { shape: "up", amount: 60 },
            repetitions: 1,
            rhythms: [createLayer({ id: "pulse", signature: { count: 4, unit: 4 } })],
          },
        ],
      },
    },
    10,
  );

  assert.equal(transport.currentBpm(9.5), 90);
  assert.equal(transport.currentBpm(10), 90);
  // A Flat Cycle starts at its own stepped tempo rather than the one it
  // inherited, so the reading before the origin follows the curve, not the bpm.
  const stepped = new SharedTransport();
  stepped.start(
    {
      bpm: 90,
      sequence: {
        cycles: [
          {
            id: "flat",
            envelope: { shape: "flat", amount: -30 },
            repetitions: 1,
            rhythms: [createLayer({ id: "pulse" })],
          },
        ],
      },
    },
    10,
  );
  assert.equal(stepped.currentBpm(9.5), 60);
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
