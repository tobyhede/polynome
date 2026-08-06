import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createConfiguration } from "../configuration.ts";
import { ENVELOPE } from "../model.ts";
import { MetronomeEngine } from "../metronome.ts";

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
 * The counts are taken against the real `metronome.ts`, driven through the
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
 * The second is that steady-state scheduler ticks issue no mix automation.
 * `start()` and `updateMix()` synchronize the graph at the moment its state
 * changes, so repeating the master gain and every layer's gain and pan forty
 * times a second would only restate values already in force.
 *
 * See `docs/research/performance-optimisation-and-regression-testing.md`.
 */

/** Long enough to make the click rate representative, short enough to stay quick. */
const SECONDS = 20;

interface AutomationCounts {
  total: number;
  [method: string]: number;
}

interface WorkCounts {
  oscillators: number;
  gains: number;
  panners: number;
  connects: number;
  disconnects: number;
  starts: number;
  stops: number;
  automation: AutomationCounts;
}

class CountingParam {
  declare counts: WorkCounts;
  declare value: number;

  constructor(counts: WorkCounts, value: number) {
    this.counts = counts;
    this.value = value;
  }

  #record(method: string) {
    this.counts.automation.total += 1;
    this.counts.automation[method] = (this.counts.automation[method] ?? 0) + 1;
  }

  setValueAtTime(value: number) {
    this.#record("setValueAtTime");
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number) {
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
  declare counts: WorkCounts;

  constructor(counts: WorkCounts) {
    this.counts = counts;
  }

  connect(target: CountingNode) {
    this.counts.connects += 1;
    return target;
  }

  disconnect() {
    this.counts.disconnects += 1;
  }
}

class CountingGain extends CountingNode {
  declare gain: CountingParam;

  constructor(counts: WorkCounts) {
    super(counts);
    this.gain = new CountingParam(counts, 1);
  }
}

class CountingPanner extends CountingNode {
  declare pan: CountingParam;

  constructor(counts: WorkCounts) {
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
  declare context: CountingAudioContext;
  declare counts: WorkCounts;
  declare frequency: CountingParam;
  declare detune: CountingParam;
  declare startedAt: number | null;
  declare stopAt: number | null;
  declare stopCalls: number;

  constructor(context: CountingAudioContext) {
    super();
    this.context = context;
    this.counts = context.counts;
    this.frequency = new CountingParam(context.counts, 440);
    this.detune = new CountingParam(context.counts, 0);
    this.startedAt = null;
    this.stopAt = null;
    this.stopCalls = 0;
  }

  connect(target: CountingNode) {
    this.counts.connects += 1;
    return target;
  }

  disconnect() {}

  start(when: number) {
    this.counts.starts += 1;
    this.startedAt = when;
  }

  stop(when: number) {
    this.stopCalls += 1;
    this.counts.stops += 1;
    if (this.stopAt === null) this.stopAt = when;
  }
}

class CountingAudioContext extends EventTarget {
  declare state: string;
  declare currentTime: number;
  declare sampleRate: number;
  declare counts: WorkCounts;
  declare destination: CountingNode;
  declare live: Set<CountingOscillator>;

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
  advance(seconds: number) {
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

interface CountingInterval {
  callback: () => void;
  delay: number;
}

const timers = {
  nextId: 1,
  intervals: new Map<number, CountingInterval>(),
  timeouts: new Map<number, () => void>(),
};

const windowStub = {
  setInterval(callback: () => void, delay: number) {
    const id = timers.nextId++;
    timers.intervals.set(id, { callback, delay });
    return id;
  },
  clearInterval(id: number) {
    timers.intervals.delete(id);
  },
  setTimeout(callback: () => void) {
    const id = timers.nextId++;
    timers.timeouts.set(id, callback);
    return id;
  },
  clearTimeout(id: number) {
    timers.timeouts.delete(id);
  },
};

const installGlobal = (name: string, value: unknown) => {
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

let restoreWindow: (() => void) | null = null;

before(() => {
  restoreWindow = installGlobal("window", windowStub);
});

after(() => {
  restoreWindow?.();
  restoreWindow = null;
});

interface ConfigurationInput {
  bpm: number;
  rhythms: Array<{
    signature: { count: number; unit: number };
    subdivision: number;
    steps?: string[];
  }>;
  envelope: { shape: string; amount: number };
}

const configurationOf = ({ bpm, rhythms, envelope }: ConfigurationInput) =>
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
async function runTicks(
  configuration: ReturnType<typeof createConfiguration>,
  requestedTicks?: number,
) {
  timers.intervals.clear();
  timers.timeouts.clear();
  const context = new CountingAudioContext();
  const engine = new MetronomeEngine({ createContext: () => context });

  await engine.start(configuration);
  context.reset();

  const [scheduledInterval] = timers.intervals.values();
  const ticks = requestedTicks ?? Math.round(SECONDS / (scheduledInterval.delay / 1_000));
  let elapsedSeconds = 0;
  for (let index = 0; index < ticks; index += 1) {
    for (const { callback, delay } of [...timers.intervals.values()]) {
      const intervalSeconds = delay / 1_000;
      context.advance(intervalSeconds);
      elapsedSeconds += intervalSeconds;
      callback();
    }
  }

  // Past every scheduled stop, so every source has had its `ended`.
  context.advance(1);
  const perSecond = (value: number) => Number((value / elapsedSeconds).toFixed(1));
  const counts = {
    ...context.counts,
    automation: { ...context.counts.automation },
  };

  engine.stop();
  return { context, counts, perSecond };
}

test("the scheduler timer exposes the interval requested by the engine", async () => {
  timers.intervals.clear();
  timers.timeouts.clear();
  const context = new CountingAudioContext();
  const engine = new MetronomeEngine({ createContext: () => context });

  await engine.start(
    configurationOf({
      bpm: 120,
      rhythms: [{ signature: { count: 4, unit: 4 }, subdivision: 1 }],
      envelope: { shape: ENVELOPE.FLAT, amount: 0 },
    }),
  );

  const [interval] = timers.intervals.values();
  assert.ok(
    Number.isFinite(interval?.delay) && interval.delay > 0,
    "the timer boundary discarded the engine's requested interval",
  );
  engine.stop();
});

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
 * The ratchet that proves the waste stays removed.
 *
 * Setup is excluded before the run is counted, so `setTargetAtTime` has no
 * steady-state caller: graph changes synchronize at their edit path and clicks
 * use value and exponential-ramp automation instead.
 *
 * These are ceilings set where the code stands, in the spirit of the coverage
 * ratchet: raise deliberately if the real figure rises, never lower one to make
 * a change fit.
 */
const AUTOMATION_BUDGETS = {
  default: { total: 8, setTargetAtTime: 0 },
  maximum: { total: 725, setTargetAtTime: 0 },
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

    assert.equal(
      reassertions,
      0,
      "a steady-state scheduler tick re-asserted mix values already in force",
    );

    console.log(
      `${workload.name}: ${total} AudioParam calls/s, ${reassertions} of them mix re-assertion (${Math.round((reassertions / total) * 100)}%)`,
    );
  });
}

test("steady-state traffic excludes transport shutdown", async () => {
  const { context, counts } = await runTicks(WORKLOADS.default.build(), 1);

  assert.deepEqual(
    [
      counts === context.counts,
      counts.automation === context.counts.automation,
      counts.automation.cancelScheduledValues ?? 0,
    ],
    [false, false, 0],
    "stopping the engine changed the returned steady-state traffic snapshot",
  );
});
