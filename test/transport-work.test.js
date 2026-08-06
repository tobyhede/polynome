import test from "node:test";
import assert from "node:assert/strict";

import { createConfiguration } from "../configuration.js";
import { ENVELOPE, STEP } from "../model.js";
import { SharedTransport } from "../shared-transport.js";

/**
 * What `plan()` produces over a long run, asserted as counts and invariants
 * rather than as time.
 *
 * The timing is not the point and deliberately so. Measured, a whole scheduler
 * tick costs under 0.02 ms against the 25 ms interval it has to fit inside,
 * which is 0.07% of the budget in the worst case the domain permits — so no
 * plausible slowdown here is audible, and a duration threshold loose enough to
 * survive a shared CI runner would be loose enough to catch nothing. What a
 * regression in this module actually looks like is a different set of events:
 * a step emitted twice, a step dropped, an event outside the window the engine
 * will commit, a loop bound quietly changed. Those are exact, and they are what
 * this file holds.
 *
 * `plan()` is deterministic to the last event — 200 identical runs of the
 * worst-case workload returned one distinct count — so the totals below are
 * equalities, not budgets. A number that moves is a behaviour that changed, and
 * the invariants alongside it say which one.
 *
 * See `docs/research/performance-optimisation-and-regression-testing.md`.
 */

/** The engine's own scheduler geometry, restated: it is private to `metronome.js`. */
const SCHEDULER_INTERVAL_SECONDS = 0.025;
const LOOK_AHEAD_SECONDS = 0.12;
/** `shared-transport.js`'s planning-side lateness tolerance, restated for the window assertion. */
const LATENESS_TOLERANCE_SECONDS = 0.004;

const TICKS = 400;

const configurationOf = ({ bpm, rhythms, envelope, repetitions = 1 }) =>
  createConfiguration({
    bpm,
    masterVolume: 0.8,
    sequence: { cycles: [{ repetitions, rhythms, envelope }] },
  });

/** One 4/4 layer, undivided, at 120 BPM: what the application opens on. */
const defaultRhythms = () => [{ signature: { count: 4, unit: 4 }, subdivision: 1 }];

/**
 * The worst case the domain permits: `MAX_RHYTHMS` layers at the widest meter
 * and the finest subdivision, which is 384 pattern positions — the same shape
 * ADR-0009 measured the renderer against.
 */
const maximumRhythms = () =>
  Array.from({ length: 12 }, () => ({ signature: { count: 8, unit: 4 }, subdivision: 4 }));

/**
 * Runs the transport through a fixed number of scheduler ticks and returns
 * everything that can be asserted without consulting a clock.
 *
 * The tick geometry is the engine's, so what this counts is what the engine
 * would have committed. Nothing here reads wall time.
 */
function planOverTicks(configuration, ticks = TICKS) {
  const transport = new SharedTransport();
  const origin = 0.06;
  transport.start(configuration, origin);

  const events = [];
  const windowViolations = [];
  const perTickOutOfOrder = [];
  let previousAudioTime = Number.NEGATIVE_INFINITY;
  let acrossTickOutOfOrder = 0;

  for (let index = 0; index < ticks; index += 1) {
    const now = origin + index * SCHEDULER_INTERVAL_SECONDS;
    const horizon = now + LOOK_AHEAD_SECONDS;
    const planned = transport.plan(now, horizon);

    let previousInTick = Number.NEGATIVE_INFINITY;
    for (const event of planned) {
      if (event.audioTime < previousInTick) perTickOutOfOrder.push(event);
      previousInTick = event.audioTime;

      // The contract the engine is written against: nothing already too late to
      // commit, and nothing beyond the horizon it asked for.
      if (event.audioTime < now - LATENESS_TOLERANCE_SECONDS || event.audioTime >= horizon) {
        windowViolations.push({ tick: index, event });
      }

      if (event.audioTime < previousAudioTime) acrossTickOutOfOrder += 1;
      previousAudioTime = Math.max(previousAudioTime, event.audioTime);
    }
    events.push(...planned);
  }

  return { events, windowViolations, perTickOutOfOrder, acrossTickOutOfOrder };
}

/** Every `(layer, absolute step)` pair that came back more than once. */
function duplicateSteps(events) {
  const seen = new Set();
  const duplicates = [];
  for (const event of events) {
    const key = `${event.layerId}:${event.absoluteStep}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

/**
 * Four workloads: the default and the domain maximum, each on the cheap
 * envelope shape and the expensive one. Peak is the expensive one because
 * `secondsAtBeat` and `beatAtSeconds` rebuild two sub-curves per call on it,
 * and it emits a different number of events from Flat over the same wall
 * interval because the tempo is genuinely moving.
 *
 * `events` is the exact count `plan()` returns over `TICKS` ticks. It is
 * recorded, not derived: a closed form would restate the arithmetic under test
 * and agree with a broken implementation that broke both.
 *
 * The Peak amount is stated rather than defaulted, because the count depends on
 * it: a moving tempo covers a different number of steps in the same 10 seconds
 * of wall time, so `ENVELOPE_DEFAULT_AMOUNT` changing would move these numbers
 * for a reason that has nothing to do with the transport.
 */
const PEAK_AMOUNT = 20;
const WORKLOADS = [
  {
    name: "default Configuration, Flat envelope",
    build: () =>
      configurationOf({
        bpm: 120,
        rhythms: defaultRhythms(),
        envelope: { shape: ENVELOPE.FLAT, amount: 0 },
      }),
    events: 21,
  },
  {
    name: "default Configuration, Peak envelope",
    build: () =>
      configurationOf({
        bpm: 120,
        rhythms: defaultRhythms(),
        envelope: { shape: ENVELOPE.PEAK, amount: PEAK_AMOUNT },
      }),
    events: 22,
  },
  {
    name: "twelve 8/4 layers at subdivision four, Flat envelope",
    build: () =>
      configurationOf({
        bpm: 120,
        rhythms: maximumRhythms(),
        envelope: { shape: ENVELOPE.FLAT, amount: 0 },
      }),
    events: 972,
  },
  {
    name: "twelve 8/4 layers at subdivision four, Peak envelope",
    build: () =>
      configurationOf({
        bpm: 120,
        rhythms: maximumRhythms(),
        envelope: { shape: ENVELOPE.PEAK, amount: PEAK_AMOUNT },
      }),
    events: 1056,
  },
];

for (const workload of WORKLOADS) {
  test(`plan() emits exactly ${workload.events} events over ${TICKS} ticks — ${workload.name}`, () => {
    const { events } = planOverTicks(workload.build());

    assert.equal(
      events.length,
      workload.events,
      `plan() emitted ${events.length} events where ${workload.events} were recorded. If this is intended, re-take the number; if it is not, the invariants in this file say what moved.`,
    );
  });

  test(`plan() emits every event once, in order, inside the window — ${workload.name}`, () => {
    const { events, windowViolations, perTickOutOfOrder, acrossTickOutOfOrder } = planOverTicks(
      workload.build(),
    );

    assert.deepEqual(duplicateSteps(events), [], "an absolute step was scheduled more than once");
    assert.deepEqual(perTickOutOfOrder, [], "a tick returned events out of audio-time order");
    assert.equal(acrossTickOutOfOrder, 0, "a later tick planned an event before an earlier one");
    assert.deepEqual(
      windowViolations,
      [],
      "an event fell outside [currentTime - lateness tolerance, horizon)",
    );
  });
}

/**
 * A silent position must cost nothing downstream. This is the assertion that
 * makes the counts above meaningful: without it, a regression that emitted
 * every position and let the engine filter would leave every other number here
 * unchanged while quadrupling the work the scheduler hands on.
 */
test("plan() emits nothing for an off position", () => {
  const allOff = configurationOf({
    bpm: 120,
    rhythms: [
      {
        signature: { count: 4, unit: 4 },
        subdivision: 4,
        steps: Array.from({ length: 16 }, () => STEP.OFF),
      },
    ],
    envelope: { shape: ENVELOPE.FLAT, amount: 0 },
  });

  const { events } = planOverTicks(allOff);
  assert.equal(events.length, 0);
});

/**
 * The determinism the equalities above rest on, asserted rather than assumed.
 * If `plan()` ever became sensitive to anything but its inputs, every recorded
 * count in this file would silently become a sample.
 */
test("plan() is deterministic across repeated identical runs", () => {
  const counts = new Set();
  for (let run = 0; run < 25; run += 1) {
    counts.add(planOverTicks(WORKLOADS.at(-1).build()).events.length);
  }

  assert.equal(counts.size, 1, `repeated identical runs disagreed: ${[...counts].join(", ")}`);
});
