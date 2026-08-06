import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createConfiguration } from "../configuration.js";
import { ENVELOPE } from "../model.js";
import { MetronomeEngine } from "../metronome.js";

/**
 * How much work the engine asks the audio graph to do, per second of transport
 * run, counted exactly.
 *
 * Nothing here is timed. A whole scheduler tick measures under 0.02 ms against
 * the 25 ms interval, so there is no duration worth thresholding and no
 * threshold that would survive a shared runner. What there is, and what this
 * file holds, is *traffic*: every node the engine allocates and every
 * `AudioParam` automation call it issues is a control message from the main
 * thread to the rendering thread, and the count is a property of this code
 * rather than of the machine it runs on. It is identical on every runner.
 *
 * The counts are taken against the real `metronome.js`, driven through the
 * `options.createContext` seam the engine already exposes, so what is measured
 * is the shipped scheduler and not a restatement of it.
 *
 * Two findings are pinned here deliberately.
 *
 * The first is that node allocation is proportional to clicks and nothing else.
 * Two nodes per click is the Web Audio specification's own design — §1.1.6
 * describes source nodes created per note and never removed — so the assertion
 * is an equality against the clicks actually sounded, and it fails if anything
 * starts allocating per tick instead of per event.
 *
 * The second is that `#schedule()` calls `#syncNodes()` on every tick, which
 * re-asserts the master gain and every layer's gain and pan forty times a
 * second whether or not the mix moved. At the default Configuration that is 120
 * `setTargetAtTime` calls per second against the six a click needs — 95% of all
 * automation traffic restating values already in force. That is not a
 * regression, it is the state of the code, and it is ratcheted here so that
 * fixing it shows up as a number falling rather than as nothing at all.
 *
 * See `docs/research/performance-optimisation-and-regression-testing.md`.
 */

const SCHEDULER_INTERVAL_SECONDS = 0.025;
const TICKS_PER_SECOND = 1 / SCHEDULER_INTERVAL_SECONDS;
/** Long enough that the per-tick traffic dominates the one-off setup, short enough to stay quick. */
const SECONDS = 20;
const TICKS = SECONDS * TICKS_PER_SECOND;

class CountingParam {
  constructor(counts, value) {
    this.counts = counts;
    this.value = value;
  }

  #record(method) {
    this.counts.automation.total += 1;
    this.counts.automation[method] = (this.counts.automation[method] ?? 0) + 1;
  }

  setValueAtTime(value) {
    this.#record("setValueAtTime");
    this.value = value;
    return this;
  }

  setTargetAtTime(value) {
    this.#record("setTargetAtTime");
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime() {
    this.#record("exponentialRampToValueAtTime");
    return this;
  }

  linearRampToValueAtTime() {
    this.#record("linearRampToValueAtTime");
    return this;
  }

  cancelScheduledValues() {
    this.#record("cancelScheduledValues");
    return this;
  }
}

class CountingNode {
  constructor(counts) {
    this.counts = counts;
  }

  connect(target) {
    this.counts.connects += 1;
    return target;
  }

  disconnect() {
    this.counts.disconnects += 1;
  }
}

class CountingGain extends CountingNode {
  constructor(counts) {
    super(counts);
    this.gain = new CountingParam(counts, 1);
  }
}

class CountingPanner extends CountingNode {
  constructor(counts) {
    super(counts);
    this.pan = new CountingParam(counts, 0);
  }
}

/**
 * Dispatches `ended` when the render clock passes its stop time, which is what
 * lets the engine's `{once: true}` listener drain `#scheduledSources`. Without
 * it the set would grow for the length of the run and the leak assertion below
 * would pass against a double that could not have caught one.
 */
class CountingOscillator extends EventTarget {
  constructor(context) {
    super();
    this.context = context;
    this.counts = context.counts;
    this.frequency = new CountingParam(context.counts, 440);
    this.detune = new CountingParam(context.counts, 0);
    this.startedAt = null;
    this.stopAt = null;
    this.stopCalls = 0;
  }

  connect(target) {
    this.counts.connects += 1;
    return target;
  }

  disconnect() {}

  start(when) {
    this.counts.starts += 1;
    this.startedAt = when;
  }

  stop(when) {
    this.stopCalls += 1;
    this.counts.stops += 1;
    if (this.stopAt === null) this.stopAt = when;
  }
}

class CountingAudioContext extends EventTarget {
  constructor() {
    super();
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48_000;
    this.counts = {
      oscillators: 0,
      gains: 0,
      panners: 0,
      connects: 0,
      disconnects: 0,
      starts: 0,
      stops: 0,
      automation: { total: 0 },
    };
    this.destination = new CountingNode(this.counts);
    this.live = new Set();
  }

  createGain() {
    this.counts.gains += 1;
    return new CountingGain(this.counts);
  }

  createStereoPanner() {
    this.counts.panners += 1;
    return new CountingPanner(this.counts);
  }

  createOscillator() {
    this.counts.oscillators += 1;
    const node = new CountingOscillator(this);
    this.live.add(node);
    return node;
  }

  resume() {
    return Promise.resolve();
  }

  suspend() {
    return Promise.resolve();
  }

  /** Move the render clock and retire every source whose stop time has passed. */
  advance(seconds) {
    this.currentTime += seconds;
    for (const node of [...this.live]) {
      if (node.stopAt === null || node.stopAt > this.currentTime) continue;
      this.live.delete(node);
      node.dispatchEvent(new Event("ended"));
    }
  }

  /** Everything counted since the last call, so setup can be excluded from steady state. */
  reset() {
    this.counts.oscillators = 0;
    this.counts.gains = 0;
    this.counts.panners = 0;
    this.counts.connects = 0;
    this.counts.disconnects = 0;
    this.counts.starts = 0;
    this.counts.stops = 0;
    this.counts.automation = { total: 0 };
  }
}

const timers = { nextId: 1, intervals: new Map(), timeouts: new Map() };

const windowStub = {
  setInterval(callback) {
    const id = timers.nextId++;
    timers.intervals.set(id, callback);
    return id;
  },
  clearInterval(id) {
    timers.intervals.delete(id);
  },
  setTimeout(callback) {
    const id = timers.nextId++;
    timers.timeouts.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    timers.timeouts.delete(id);
  },
};

const installGlobal = (name, value) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
};

let restoreWindow = null;

before(() => {
  restoreWindow = installGlobal("window", windowStub);
});

after(() => {
  restoreWindow?.();
  restoreWindow = null;
});

const configurationOf = ({ bpm, rhythms, envelope }) =>
  createConfiguration({
    bpm,
    masterVolume: 0.8,
    sequence: { cycles: [{ repetitions: 1, rhythms, envelope }] },
  });

/**
 * Starts the engine, discards the setup counts, and runs a fixed number of
 * scheduler ticks. What comes back is steady-state traffic only: the graph the
 * run needed to exist is built before the counters are zeroed, so every number
 * below is work the engine chose to do *again* on a tick.
 */
async function runTicks(configuration, ticks = TICKS) {
  timers.intervals.clear();
  timers.timeouts.clear();
  const context = new CountingAudioContext();
  const engine = new MetronomeEngine({ createContext: () => context });

  await engine.start(configuration);
  context.reset();

  for (let index = 0; index < ticks; index += 1) {
    context.advance(SCHEDULER_INTERVAL_SECONDS);
    for (const callback of [...timers.intervals.values()]) callback();
  }

  // Past every scheduled stop, so every source has had its `ended`.
  context.advance(1);
  const perSecond = (value) => Number((value / (ticks * SCHEDULER_INTERVAL_SECONDS)).toFixed(1));

  engine.stop();
  return { context, counts: context.counts, perSecond };
}

const WORKLOADS = {
  default: {
    name: "one 4/4 layer at 120 BPM",
    build: () =>
      configurationOf({
        bpm: 120,
        rhythms: [{ signature: { count: 4, unit: 4 }, subdivision: 1 }],
        envelope: { shape: ENVELOPE.FLAT, amount: 0 },
      }),
    clicksPerSecond: 2,
    layers: 1,
  },
  maximum: {
    name: "twelve 8/4 layers at subdivision four, 300 BPM",
    build: () =>
      configurationOf({
        bpm: 300,
        rhythms: Array.from({ length: 12 }, () => ({
          signature: { count: 8, unit: 4 },
          subdivision: 4,
        })),
        envelope: { shape: ENVELOPE.FLAT, amount: 0 },
      }),
    clicksPerSecond: 240,
    layers: 12,
  },
};

for (const workload of Object.values(WORKLOADS)) {
  test(`node allocation is proportional to clicks, not to ticks — ${workload.name}`, async () => {
    const { counts, perSecond } = await runTicks(workload.build());

    // The equalities are the assertion. A regression that allocated per tick
    // rather than per event would leave the rate plausible and break these.
    assert.equal(counts.oscillators, counts.starts, "every oscillator is started exactly once");
    assert.equal(counts.oscillators, counts.stops, "every oscillator is stopped exactly once");
    assert.equal(
      counts.gains,
      counts.oscillators,
      "one envelope gain per click and no gain allocated on a bare tick",
    );
    assert.equal(
      counts.connects,
      counts.oscillators * 2,
      "two connections per click: oscillator to envelope, envelope to the layer output",
    );
    assert.equal(counts.panners, 0, "a steady-state tick allocates no panner");

    assert.equal(
      perSecond(counts.oscillators),
      workload.clicksPerSecond,
      `expected ${workload.clicksPerSecond} clicks per second`,
    );
  });

  test(`no source outlives its click — ${workload.name}`, async () => {
    const { context } = await runTicks(workload.build());

    assert.equal(
      context.live.size,
      0,
      "a scheduled source never fired `ended`, so the engine's set of live sources would grow for the length of the run",
    );
  });
}

/**
 * The ratchet that names the waste.
 *
 * `#syncNodes()` runs inside `#schedule()`, so a run issues `40 × (1 + 2L)`
 * `setTargetAtTime` calls per second regardless of whether anything about the
 * mix changed — one for the master gain and two per layer. Every one of them is
 * a control message to the rendering thread restating a value already in force.
 *
 * These are ceilings set where the code stands, in the spirit of the coverage
 * ratchet: raise deliberately if the real figure rises, never lower one to make
 * a change fit. Removing the per-tick sync — the highest-value optimisation the
 * research identified — drops the `setTargetAtTime` figure to near zero, and
 * lowering these numbers is then the deliberate act that records it.
 */
const AUTOMATION_BUDGETS = {
  default: { total: 128, setTargetAtTime: 120 },
  maximum: { total: 1725, setTargetAtTime: 1000 },
};

for (const [key, workload] of Object.entries(WORKLOADS)) {
  test(`AudioParam traffic per second stays inside its budget — ${workload.name}`, async () => {
    const { counts, perSecond } = await runTicks(workload.build());
    const budget = AUTOMATION_BUDGETS[key];

    const total = perSecond(counts.automation.total);
    const reassertions = perSecond(counts.automation.setTargetAtTime ?? 0);

    assert.ok(
      total <= budget.total,
      `${total} AudioParam calls per second, over the ${budget.total} budget`,
    );
    assert.ok(
      reassertions <= budget.setTargetAtTime,
      `${reassertions} setTargetAtTime calls per second, over the ${budget.setTargetAtTime} budget`,
    );

    // Stated as an expectation rather than left implicit: the per-tick sync
    // issues one call for the master gain and two per layer, forty times a
    // second. If this stops holding, the sync changed and the budget above is
    // measuring something else.
    assert.equal(
      reassertions,
      TICKS_PER_SECOND * (1 + 2 * workload.layers),
      "the per-tick graph sync is no longer re-asserting exactly the master gain and every layer's gain and pan",
    );

    console.log(
      `${workload.name}: ${total} AudioParam calls/s, ${reassertions} of them mix re-assertion (${Math.round((reassertions / total) * 100)}%)`,
    );
  });
}
