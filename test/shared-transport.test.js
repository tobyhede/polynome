import test from "node:test";
import assert from "node:assert/strict";

import { STEP, createLayer, createPreset } from "../model.js";
import { SharedTransport } from "../shared-transport.js";

const sequence = (bpm, rhythms, repetitions = 1) => ({
  bpm,
  cycles: [{ id: "cycle", repetitions, rhythms }],
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

  transport.start({
    bpm: 60,
    cycles: [
      { id: "first-cycle", repetitions: 2, rhythms: [first] },
      { id: "second-cycle", repetitions: 1, rhythms: [second] },
    ],
  }, 10);

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
  transport.start({
    bpm: 60,
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
  }, 10);

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

  transport.start({
    bpm: 60,
    cycles: [
      { id: "off-cycle", repetitions: 0, rhythms: [inactive] },
      { id: "on-cycle", repetitions: 1, rhythms: [active] },
    ],
  }, 10);

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
  transport.start({
    bpm: 60,
    cycles: [
      { id: "one", repetitions: 1, rhythms: [first] },
      { id: "two", repetitions: 1, rhythms: [second] },
    ],
  }, 0);

  assert.equal(transport.patternPosition("first", 1.25), null);
  assert.equal(transport.patternPosition("second", 1.25), 0);
});

test("a polymeter cycle does not advance until every rhythm returns to downbeat", () => {
  const four = createLayer({ id: "four", signature: { count: 4, unit: 4 } });
  const three = createLayer({ id: "three", signature: { count: 3, unit: 4 } });
  const next = createLayer({ id: "next", signature: { count: 1, unit: 4 } });
  const transport = new SharedTransport();
  transport.start({
    bpm: 60,
    cycles: [
      { id: "polymeter", repetitions: 1, rhythms: [four, three] },
      { id: "next-cycle", repetitions: 1, rhythms: [next] },
    ],
  }, 0);

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
    steps: [STEP.FULL, STEP.HALF, STEP.HALF, STEP.HALF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 10);

  assert.deepEqual(transport.plan(9.9, 14), [
    {
      layerId: "four-four-k1",
      absoluteStep: 0,
      patternPosition: 0,
      level: 1,
      audioTime: 10,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 1,
      patternPosition: 1,
      level: 0.5,
      audioTime: 11,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 2,
      patternPosition: 2,
      level: 0.5,
      audioTime: 12,
    },
    {
      layerId: "four-four-k1",
      absoluteStep: 3,
      patternPosition: 3,
      level: 0.5,
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

test("7/8 with one pulse per eighth plans seven eighth-note positions", () => {
  const layer = createLayer({
    id: "seven-eight",
    signature: { count: 7, unit: 8 },
    subdivision: 1,
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 3.5).map((event) => event.audioTime),
    [0, 0.5, 1, 1.5, 2, 2.5, 3],
  );
});

test("a computed fractional event exactly at the horizon remains excluded", () => {
  const layer = createLayer({
    id: "fractional-boundary",
    signature: { count: 1, unit: 1 },
    subdivision: 3,
    steps: [STEP.FULL, STEP.HALF, STEP.HALF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(30, [layer]), 12345.678);

  assert.deepEqual(
    transport.plan(12345.67, 12351.011333333334).map((event) => ({
      absoluteStep: event.absoluteStep,
      audioTime: event.audioTime,
    })),
    [
      { absoluteStep: 0, audioTime: 12345.678 },
      { absoluteStep: 1, audioTime: 12348.344666666666 },
    ],
  );
});

test("an off step produces no rhythm event", () => {
  const layer = createLayer({
    id: "off-steps",
    signature: { count: 4, unit: 4 },
    steps: [STEP.FULL, STEP.OFF, STEP.HALF, STEP.OFF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 0);

  assert.deepEqual(
    transport.plan(0, 2).map((event) => event.patternPosition),
    [0, 2],
  );
});

test("rhythm events expose numeric step levels", () => {
  const layer = createLayer({
    id: "levels",
    signature: { count: 3, unit: 4 },
    steps: [STEP.QUARTER, STEP.HALF, STEP.FULL],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 0);

  assert.deepEqual(transport.plan(0, 3), [
    {
      layerId: "levels",
      absoluteStep: 0,
      patternPosition: 0,
      level: 0.25,
      audioTime: 0,
    },
    {
      layerId: "levels",
      absoluteStep: 1,
      patternPosition: 1,
      level: 0.5,
      audioTime: 1,
    },
    {
      layerId: "levels",
      absoluteStep: 2,
      patternPosition: 2,
      level: 1,
      audioTime: 2,
    },
  ]);
});

test("step-level edits preserve transport position and affect future events", () => {
  const layer = createLayer({
    id: "live-level",
    signature: { count: 2, unit: 4 },
    steps: [STEP.FULL, STEP.HALF],
  });
  const state = sequence(60, [layer]);
  const transport = new SharedTransport();

  transport.start(state, 10);
  transport.plan(9.9, 10.5);
  layer.steps[1] = STEP.QUARTER;
  transport.updateStepLevels(state);

  assert.equal(transport.origin, 10);
  assert.deepEqual(transport.plan(10.4, 11.1), [
    {
      layerId: "live-level",
      absoluteStep: 1,
      patternPosition: 1,
      level: 0.25,
      audioTime: 11,
    },
  ]);
});

test("overlapping polls plan each absolute step only once", () => {
  const layer = createLayer({
    id: "steady",
    signature: { count: 4, unit: 4 },
    steps: [STEP.FULL, STEP.HALF, STEP.HALF, STEP.HALF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 5);
  transport.plan(4.9, 6.1);

  assert.deepEqual(transport.plan(5.98, 6.6), [
    {
      layerId: "steady",
      absoluteStep: 3,
      patternPosition: 3,
      level: 0.5,
      audioTime: 6.5,
    },
  ]);
});

test("a late poll discards missed events without restarting transport phase", () => {
  const layer = createLayer({
    id: "phase",
    signature: { count: 4, unit: 4 },
    steps: [STEP.FULL, STEP.HALF, STEP.HALF, STEP.HALF],
  });
  const transport = new SharedTransport();

  transport.start(sequence(120, [layer]), 10);

  assert.deepEqual(transport.plan(12.2, 13.1), [
    {
      layerId: "phase",
      absoluteStep: 5,
      patternPosition: 1,
      level: 0.5,
      audioTime: 12.5,
    },
    {
      layerId: "phase",
      absoluteStep: 6,
      patternPosition: 2,
      level: 0.5,
      audioTime: 13,
    },
  ]);
});

test("a transport run retains its starting timing snapshot", () => {
  const layer = createLayer({
    id: "snapshot",
    signature: { count: 2, unit: 4 },
    steps: [STEP.FULL, STEP.OFF],
  });
  const state = sequence(60, [layer]);
  const transport = new SharedTransport();

  transport.start(state, 20);
  state.bpm = 120;
  layer.subdivision = 5;
  layer.steps[1] = STEP.HALF;

  assert.deepEqual(transport.plan(19.9, 22), [
    {
      layerId: "snapshot",
      absoluteStep: 0,
      patternPosition: 0,
      level: 1,
      audioTime: 20,
    },
  ]);
});

test("visual pattern position derives from the transport origin", () => {
  const layer = createLayer({
    id: "playhead",
    signature: { count: 1, unit: 4 },
    subdivision: 3,
    steps: [STEP.FULL, STEP.HALF, STEP.HALF],
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
  const event = transport
    .plan(0, 1)
    .find((candidate) => candidate.absoluteStep === 2);

  assert.equal(event.audioTime, 0.8933333333333333);
  assert.equal(event.patternPosition, 2);
  assert.equal(
    transport.patternPosition("fractional-playhead", event.audioTime),
    event.patternPosition,
  );
  assert.equal(
    transport.patternPosition(
      "fractional-playhead",
      event.audioTime - Number.EPSILON,
    ),
    1,
  );
});

test("mute does not change a rhythm layer event timeline", () => {
  const layer = createLayer({
    id: "muted",
    muted: true,
    signature: { count: 1, unit: 4 },
    steps: [STEP.FULL],
  });
  const transport = new SharedTransport();

  transport.start(sequence(60, [layer]), 50);

  assert.deepEqual(transport.plan(49.9, 51), [
    {
      layerId: "muted",
      absoluteStep: 0,
      patternPosition: 0,
      level: 1,
      audioTime: 50,
    },
  ]);
});

test("a sequence with no active cycles schedules nothing and reports no position", () => {
  const transport = new SharedTransport();

  transport.start({
    bpm: 60,
    cycles: [
      { id: "first-cycle", repetitions: 0, rhythms: [createLayer({ id: "first" })] },
      { id: "second-cycle", repetitions: 0, rhythms: [createLayer({ id: "second" })] },
    ],
  }, 10);

  assert.deepEqual(transport.plan(10.5, 12), []);
  assert.equal(transport.position(10.5), null);
  assert.equal(transport.patternPosition("first", 10.5), null);
});

test("starting a new transport run resets origin and scheduling position together", () => {
  const layer = createLayer({
    id: "restart",
    signature: { count: 1, unit: 4 },
    steps: [STEP.FULL],
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
      level: 1,
      audioTime: 70,
    },
  ]);
});
