import test from "node:test";
import assert from "node:assert/strict";

import { createConfiguration } from "../configuration.js";
import { MetronomeEngine } from "../metronome.js";

/**
 * A hand-written AudioContext test double.
 *
 * It models the parts of WebKit's behaviour that make an iPhone metronome fail
 * silently: a controllable `state`, a `currentTime` that only moves when the
 * test says so, a `resume()` whose settling behaviour is chosen per test, and
 * recording nodes that log what was scheduled and when.
 */

class FakeAudioParam {
  constructor(context, name, value) {
    this.context = context;
    this.name = name;
    this.value = value;
    this.automation = [];
  }

  setValueAtTime(value, when) {
    this.automation.push({ method: "setValueAtTime", value, when });
    return this;
  }

  setTargetAtTime(value, when, timeConstant) {
    this.automation.push({ method: "setTargetAtTime", value, when, timeConstant });
    this.context.consumeGraphSyncAdvance();
    return this;
  }

  exponentialRampToValueAtTime(value, when) {
    this.automation.push({ method: "exponentialRampToValueAtTime", value, when });
    return this;
  }

  linearRampToValueAtTime(value, when) {
    this.automation.push({ method: "linearRampToValueAtTime", value, when });
    return this;
  }

  cancelScheduledValues(when) {
    this.automation.push({ method: "cancelScheduledValues", when });
    return this;
  }
}

class FakeAudioNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = [];
    this.disconnections = 0;
  }

  connect(target) {
    this.outputs.push(target);
    return target;
  }

  disconnect() {
    this.disconnections += 1;
    this.outputs = [];
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor(context) {
    super(context, "gain");
    this.gain = new FakeAudioParam(context, "gain", 1);
  }
}

class FakeStereoPannerNode extends FakeAudioNode {
  constructor(context) {
    super(context, "panner");
    this.pan = new FakeAudioParam(context, "pan", 0);
  }
}

class FakeOscillatorNode extends EventTarget {
  constructor(context) {
    super();
    this.context = context;
    this.kind = "oscillator";
    this.type = "sine";
    this.frequency = new FakeAudioParam(context, "frequency", 440);
    this.detune = new FakeAudioParam(context, "detune", 0);
    this.outputs = [];
    this.click = null;
  }

  connect(target) {
    this.outputs.push(target);
    return target;
  }

  disconnect() {
    this.outputs = [];
  }

  start(when = this.context.currentTime) {
    // A click is only audible if the render thread was alive when it was
    // committed; the effective times model the spec rule that a start time in
    // the past is pulled forward to `currentTime`.
    this.click = {
      when,
      contextState: this.context.state,
      effectiveStart: Math.max(when, this.context.currentTime),
      stopAt: null,
      effectiveStop: null,
    };
    this.context.clicks.push(this.click);
  }

  stop(when = this.context.currentTime) {
    if (!this.click || this.click.stopAt !== null) return;
    this.click.stopAt = when;
    this.click.effectiveStop = Math.max(when, this.context.currentTime);
  }
}

class FakeAudioContext extends EventTarget {
  constructor({ state = "suspended", currentTime = 0, resume = "resolve" } = {}) {
    super();
    this.state = state;
    this.currentTime = currentTime;
    this.sampleRate = 48000;
    this.destination = new FakeAudioNode(this, "destination");
    this.clicks = [];
    this.gains = [];
    this.panners = [];
    this.oscillators = [];
    this.resumeCalls = 0;
    this.resumeBehaviour = resume;
    this.pendingGraphSyncAdvance = 0;
  }

  /**
   * Make the render clock move on by `seconds` during the next graph sync,
   * which is what the engine does at the top of a scheduler tick after it has
   * already read `currentTime`. Every rhythm event in that tick is then late
   * by that much by the time it is committed.
   */
  advanceDuringNextGraphSync(seconds) {
    this.pendingGraphSyncAdvance = seconds;
  }

  consumeGraphSyncAdvance() {
    if (!this.pendingGraphSyncAdvance) return;
    this.currentTime += this.pendingGraphSyncAdvance;
    this.pendingGraphSyncAdvance = 0;
  }

  createGain() {
    const node = new FakeGainNode(this);
    this.gains.push(node);
    return node;
  }

  createStereoPanner() {
    const node = new FakeStereoPannerNode(this);
    this.panners.push(node);
    return node;
  }

  createOscillator() {
    const node = new FakeOscillatorNode(this);
    this.oscillators.push(node);
    return node;
  }

  resume() {
    this.resumeCalls += 1;
    if (this.resumeBehaviour === "hang") return new Promise(() => {});
    if (this.resumeBehaviour === "reject") {
      return Promise.reject(new Error("not allowed to start"));
    }
    return Promise.resolve();
  }

  /** Move to a new state exactly as WebKit does: fire `statechange` every time. */
  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.dispatchEvent(new Event("statechange"));
  }

  /** Clicks the hardware would actually have made a sound for. */
  audibleClicks() {
    return this.clicks.filter(
      (click) =>
        click.contextState === "running"
        && click.effectiveStop !== null
        && click.effectiveStop > click.effectiveStart,
    );
  }
}

const timers = { nextId: 1, callbacks: new Map() };

globalThis.window = {
  setInterval(callback, delay) {
    const id = timers.nextId;
    timers.nextId += 1;
    timers.callbacks.set(id, { callback, delay });
    return id;
  },
  clearInterval(id) {
    timers.callbacks.delete(id);
  },
};

const tick = (times = 1) => {
  for (let count = 0; count < times; count += 1) {
    for (const timer of [...timers.callbacks.values()]) timer.callback();
  }
};

const schedulerRunning = () => timers.callbacks.size > 0;

const harness = (contextOptions = {}) => {
  timers.callbacks.clear();
  const context = new FakeAudioContext(contextOptions);
  const engine = new MetronomeEngine({ createContext: () => context });
  return { context, engine };
};

/**
 * Fixtures are repaired by the same `createConfiguration` the application uses,
 * so a Configuration the engine is started with here cannot drift from the one
 * it is started with in the browser. Identifiers are left to that function: it
 * only trusts the shape it issues itself, and nothing below names a rhythm.
 */
const configurationOf = (bpm, rhythms) => createConfiguration({
  bpm,
  masterVolume: 0.8,
  sequence: { cycles: [{ repetitions: 1, rhythms }] },
});

/** One rhythm event per second at 60 bpm. */
const pulsePerSecond = () =>
  configurationOf(60, [{ signature: { count: 1, unit: 4 }, subdivision: 1 }]);

/** A meter-relative grid with one rhythm event every 50 ms at 150 bpm. */
const fiftyMillisecondGrid = () =>
  configurationOf(150, [{ signature: { count: 4, unit: 32 }, subdivision: 1 }]);

test("an injected audio context factory supplies the whole audio graph", async () => {
  let created = 0;
  const context = new FakeAudioContext({ state: "running" });
  const engine = new MetronomeEngine({
    createContext: () => {
      created += 1;
      return context;
    },
  });
  timers.callbacks.clear();

  await engine.start(pulsePerSecond());

  assert.equal(created, 1);
  assert.equal(context.gains.length >= 2, true);
  assert.deepEqual(context.gains[0].outputs, [context.destination]);
  assert.equal(context.panners.length, 1);
  assert.deepEqual(context.panners[0].outputs, [context.gains[0]]);
  assert.equal(context.oscillators.length >= 1, true);

  engine.stop();
});

test(
  "a resume that never settles still installs the look-ahead scheduler",
  { timeout: 2000 },
  async () => {
    const { context, engine } = harness({ state: "suspended", resume: "hang" });

    await engine.start(pulsePerSecond());

    assert.equal(engine.playing, true);
    assert.equal(schedulerRunning(), true);
    assert.deepEqual(context.audibleClicks(), []);

    context.currentTime = 0.95;
    context.setState("running");
    tick();

    assert.equal(context.audibleClicks().length > 0, true);

    engine.stop();
  },
);

test("a rejected resume neither stops the scheduler nor escapes unhandled", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "reject" });

  await engine.start(pulsePerSecond());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.playing, true);
  assert.equal(schedulerRunning(), true);

  context.currentTime = 0.95;
  context.setState("running");
  tick();

  assert.equal(context.audibleClicks().length > 0, true);

  engine.stop();
});

test("an interrupted context is resumed and sounds no rhythm event until it runs", async () => {
  const { context, engine } = harness({ state: "interrupted" });

  await engine.start(pulsePerSecond());

  assert.equal(context.resumeCalls, 1);
  assert.deepEqual(context.audibleClicks(), []);

  context.currentTime = 0.95;
  context.setState("running");
  tick();

  assert.equal(context.audibleClicks().length > 0, true);

  engine.stop();
});

test("the transport origin is anchored on the first running scheduler tick", async () => {
  const { context, engine } = harness({ state: "suspended", currentTime: 0 });

  await engine.start(pulsePerSecond());
  tick(3);

  assert.deepEqual(context.audibleClicks(), []);

  // The render thread wakes with a clock that moved on without the main thread.
  context.currentTime = 5.5;
  context.setState("running");
  tick();

  assert.equal(engine.origin, 5.56);
  assert.deepEqual(
    context.audibleClicks().map((click) => click.when),
    [5.56],
  );

  engine.stop();
});

test("a transport run recovers from an interruption without replaying past events", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(pulsePerSecond());
  assert.deepEqual(
    context.audibleClicks().map((click) => click.when),
    [0.06],
  );

  // A call, an app switch, or a screen lock: the clock freezes here.
  context.setState("interrupted");
  assert.equal(context.resumeCalls, 1);

  const scheduledWhileInterrupted = context.clicks.length;
  tick(3);
  assert.equal(context.clicks.length, scheduledWhileInterrupted);

  context.setState("running");
  context.currentTime = 0.95;
  tick();

  // The transport origin survives the interruption, so the run stays in phase.
  assert.equal(engine.origin, 0.06);
  assert.deepEqual(
    context.audibleClicks().map((click) => click.when),
    [0.06, 1.06],
  );
  assert.equal(
    context.clicks.every((click) => click.when >= click.effectiveStart),
    true,
  );

  engine.stop();
});

test("a marginally late rhythm event is sounded rather than silently dropped", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.equal(context.audibleClicks().length, 2);

  context.currentTime = 0.12;
  context.advanceDuringNextGraphSync(0.085);
  tick();

  assert.equal(context.audibleClicks().length, 4);

  engine.stop();
});

test("a hopelessly stale rhythm event is skipped rather than dragged forward", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.equal(context.clicks.length, 2);

  context.currentTime = 0.12;
  context.advanceDuringNextGraphSync(0.13);
  tick();

  // Two events were planned; the one 90 ms behind the clock is abandoned.
  assert.equal(context.clicks.length, 3);
  assert.equal(context.audibleClicks().length, 3);

  engine.stop();
});

test("without a factory the engine still reports an unsupported Web Audio API", async () => {
  timers.callbacks.clear();
  const engine = new MetronomeEngine();

  await assert.rejects(
    () => engine.start(pulsePerSecond()),
    /does not support the Web Audio API/,
  );
  assert.equal(schedulerRunning(), false);
});
