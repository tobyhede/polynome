import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createConfiguration, describeConfiguration } from "../configuration.ts";
import { SOUND, STEP } from "../model.ts";
import {
  CLICK_ENVELOPE,
  SOUND_PROFILES,
  STEP_PITCH_RATIOS,
  MetronomeEngine,
  scheduleClickVoice,
} from "../metronome.ts";

/**
 * A hand-written AudioContext test double.
 *
 * It models the parts of WebKit's behaviour that make an iPhone metronome fail
 * silently: a controllable `state`, a `currentTime` that only moves when the
 * test says so, a `resume()` whose settling behaviour is chosen per test, and
 * recording nodes that log what was scheduled and when.
 *
 * Every field below is `declare`d rather than written as a bare class field,
 * because a bare field is not a type annotation. It is real runtime syntax: it
 * defines the property, as `undefined`, at the point in construction the class
 * body names it — after `super()` has returned, before the constructor's own
 * assignments — so restating an inherited field on a subclass would erase what
 * the base constructor had already stored there. `declare` states the type and
 * emits nothing, so it provably cannot change what any of these doubles do,
 * which is the only guarantee worth having in a file Node runs by stripping
 * annotations it never parses.
 */

/**
 * The states a context can report. `interrupted` is not in the specification —
 * it is WebKit's, and it is the state most of these tests exist to explore, so
 * a union without it would type away the case the double was written for.
 */
type FakeContextState = "suspended" | "running" | "interrupted" | "closed";

/** How a test wants a context lifecycle operation to settle, or refuse to. */
type RecoveryBehaviour = "resolve" | "hang" | "reject" | "transition";

interface FakeContextOptions {
  state?: FakeContextState;
  currentTime?: number;
  resume?: RecoveryBehaviour;
  suspend?: RecoveryBehaviour;
}

/**
 * One recorded automation call. Every method records into the same list so that
 * their order relative to each other is observable, which is why the fields not
 * every method carries are optional rather than this being a union of one shape
 * per method: `cancelScheduledValues` has no value to record.
 */
interface AutomationEntry {
  method:
    | "setValueAtTime"
    | "setTargetAtTime"
    | "exponentialRampToValueAtTime"
    | "linearRampToValueAtTime"
    | "cancelScheduledValues";
  value?: number;
  when: number;
  timeConstant?: number;
}

/**
 * One committed click, as the hardware would have seen it. Both the requested
 * and the effective times are kept, because a click whose start was pulled
 * forward past its own stop is scheduled and silent, and only the pair shows it.
 */
interface FakeClick {
  when: number;
  contextState: FakeContextState;
  effectiveStart: number;
  stopAt: number | null;
  effectiveStop: number | null;
}

class FakeAudioParam {
  declare context: FakeAudioContext;
  declare name: string;
  declare value: number;
  declare automation: AutomationEntry[];

  constructor(context: FakeAudioContext, name: string, value: number) {
    this.context = context;
    this.name = name;
    this.value = value;
    this.automation = [];
  }

  setValueAtTime(value: number, when: number) {
    this.automation.push({ method: "setValueAtTime", value, when });
    return this;
  }

  setTargetAtTime(value: number, when: number, timeConstant: number) {
    this.automation.push({ method: "setTargetAtTime", value, when, timeConstant });
    this.context.noteGraphSync();
    return this;
  }

  exponentialRampToValueAtTime(value: number, when: number) {
    this.automation.push({ method: "exponentialRampToValueAtTime", value, when });
    return this;
  }

  linearRampToValueAtTime(value: number, when: number) {
    this.automation.push({ method: "linearRampToValueAtTime", value, when });
    return this;
  }

  cancelScheduledValues(when: number) {
    this.automation.push({ method: "cancelScheduledValues", when });
    return this;
  }
}

class FakeAudioNode {
  declare context: FakeAudioContext;
  declare kind: string;
  declare outputs: FakeAudioNode[];
  declare disconnections: number;

  constructor(context: FakeAudioContext, kind: string) {
    this.context = context;
    this.kind = kind;
    this.outputs = [];
    this.disconnections = 0;
  }

  connect(target: FakeAudioNode) {
    this.outputs.push(target);
    return target;
  }

  disconnect() {
    this.disconnections += 1;
    this.outputs = [];
  }
}

class FakeGainNode extends FakeAudioNode {
  declare gain: FakeAudioParam;

  constructor(context: FakeAudioContext) {
    super(context, "gain");
    this.gain = new FakeAudioParam(context, "gain", 1);
  }
}

class FakeStereoPannerNode extends FakeAudioNode {
  declare pan: FakeAudioParam;

  constructor(context: FakeAudioContext) {
    super(context, "panner");
    this.pan = new FakeAudioParam(context, "pan", 0);
  }
}

class FakeOscillatorNode extends EventTarget {
  declare context: FakeAudioContext;
  declare kind: string;
  declare type: string;
  declare frequency: FakeAudioParam;
  declare detune: FakeAudioParam;
  declare outputs: FakeAudioNode[];
  declare click: FakeClick | null;
  declare stopped: boolean;

  constructor(context: FakeAudioContext) {
    super();
    this.context = context;
    this.kind = "oscillator";
    this.type = "sine";
    this.frequency = new FakeAudioParam(context, "frequency", 440);
    this.detune = new FakeAudioParam(context, "detune", 0);
    this.outputs = [];
    this.click = null;
    this.stopped = false;
  }

  connect(target: FakeAudioNode) {
    this.outputs.push(target);
    return target;
  }

  disconnect() {
    this.outputs = [];
  }

  start(when: number = this.context.currentTime) {
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

  stop(when: number = this.context.currentTime) {
    if (arguments.length === 0) this.stopped = true;
    if (!this.click || this.click.stopAt !== null) return;
    this.click.stopAt = when;
    this.click.effectiveStop = Math.max(when, this.context.currentTime);
  }
}

class FakeAudioContext extends EventTarget {
  #clock = 0;
  #graphSyncAdvance = 0;
  #snapshotAdvance = 0;
  #snapshotArmed = false;

  declare state: FakeContextState;
  declare sampleRate: number;
  declare destination: FakeAudioNode;
  declare clicks: FakeClick[];
  declare gains: FakeGainNode[];
  declare panners: FakeStereoPannerNode[];
  declare oscillators: FakeOscillatorNode[];
  declare resumeCalls: number;
  declare resumeBehaviour: RecoveryBehaviour;
  declare suspendCalls: number;
  declare suspendBehaviour: RecoveryBehaviour;

  constructor({
    state = "suspended",
    currentTime = 0,
    resume = "resolve",
    suspend = "resolve",
  }: FakeContextOptions = {}) {
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
    this.suspendCalls = 0;
    this.suspendBehaviour = suspend;
  }

  /**
   * The render clock. Reading it is what arms `advanceAfterSchedulingSnapshot`,
   * so the drift lands between two engine reads rather than at a point the test
   * has to count reads to reach.
   */
  get currentTime() {
    if (this.#snapshotArmed) {
      this.#clock += this.#snapshotAdvance;
      this.#snapshotAdvance = 0;
      this.#snapshotArmed = false;
    } else if (this.#snapshotAdvance) {
      this.#snapshotArmed = true;
    }
    return this.#clock;
  }

  set currentTime(seconds: number) {
    this.#clock = seconds;
  }

  /**
   * Drift *before* the scheduling snapshot: the render clock moves on by
   * `seconds` while the engine is pushing parameter automation into the graph.
   * Whether that manufactures lateness depends entirely on whether the engine
   * reads `currentTime` before or after the sync, which is the point.
   */
  advanceDuringNextGraphSync(seconds: number) {
    this.#graphSyncAdvance = seconds;
  }

  /**
   * Drift *after* the scheduling snapshot: the clock jumps forward by `seconds`
   * immediately after the reading a tick plans against, so every click that
   * tick commits is exactly that late. Modelling it as "the read after the
   * snapshot read" keeps it independent of where in `#schedule()` the snapshot
   * is taken, which is why it survives the reordering that neuters
   * `advanceDuringNextGraphSync`.
   *
   * Reads that feed parameter automation are graph-sync housekeeping rather
   * than a scheduling snapshot, so `noteGraphSync` disarms them again.
   */
  advanceAfterSchedulingSnapshot(seconds: number) {
    this.#snapshotAdvance = seconds;
    this.#snapshotArmed = false;
  }

  noteGraphSync() {
    this.#snapshotArmed = false;
    if (!this.#graphSyncAdvance) return;
    this.#clock += this.#graphSyncAdvance;
    this.#graphSyncAdvance = 0;
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
    if (this.resumeBehaviour === "transition") this.setState("running");
    return Promise.resolve();
  }

  suspend() {
    this.suspendCalls += 1;
    if (this.suspendBehaviour === "hang") return new Promise(() => {});
    if (this.suspendBehaviour === "reject") {
      return Promise.reject(new Error("not allowed to suspend"));
    }
    if (this.suspendBehaviour === "transition") this.setState("suspended");
    return Promise.resolve();
  }

  /** Move to a new state exactly as WebKit does: fire `statechange` every time. */
  setState(next: FakeContextState) {
    if (this.state === next) return;
    this.state = next;
    this.dispatchEvent(new Event("statechange"));
  }

  /** Clicks the hardware would actually have made a sound for. */
  audibleClicks() {
    return this.clicks.filter(
      (click) =>
        click.contextState === "running" &&
        click.effectiveStop !== null &&
        click.effectiveStop > click.effectiveStart,
    );
  }
}

const timers = { nextId: 1, callbacks: new Map(), deadlines: new Map() };

const windowStub = {
  setInterval(callback, delay) {
    const id = timers.nextId;
    timers.nextId += 1;
    timers.callbacks.set(id, { callback, delay });
    return id;
  },
  clearInterval(id) {
    timers.callbacks.delete(id);
  },
  setTimeout(callback, delay) {
    const id = timers.nextId;
    timers.nextId += 1;
    timers.deadlines.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    timers.deadlines.delete(id);
  },
};

/**
 * Installs a global and hands back its undo.
 *
 * Defining rather than assigning, because `globalThis.navigator` is an accessor
 * property in Node and a module is always strict: assigning to it throws.
 * Capturing the original descriptor is likewise the only way back out. The
 * runner isolates test files from each other, but nothing isolates the tests
 * inside this one, so a fake left installed would silently change how every
 * test after it reads the audio session.
 */
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

/**
 * The engine's stuck-context threshold, restated.
 *
 * `SCHEDULER_INTERVAL_MS` is private to `metronome.ts`, so the boundary these
 * tests aim at is derived here exactly as the engine derives it. The mirror is
 * self-checking: a test that reports one tick early and one that reports on
 * time cannot both hold if the two derivations ever disagree.
 */
const SCHEDULER_INTERVAL_MS = 25;
const STUCK_CONTEXT_TIMEOUT_MS = 2000;
const STUCK_CONTEXT_TICKS = Math.ceil(STUCK_CONTEXT_TIMEOUT_MS / SCHEDULER_INTERVAL_MS);

const tick = (times = 1) => {
  for (let count = 0; count < times; count += 1) {
    for (const timer of [...timers.callbacks.values()]) timer.callback();
  }
};

const runNextDeadline = () => {
  const next = [...timers.deadlines.entries()].sort(
    ([firstId, first], [secondId, second]) => first.delay - second.delay || firstId - secondId,
  )[0];
  assert.ok(next, "no engine deadline was installed");
  const [id, { callback }] = next;
  timers.deadlines.delete(id);
  callback();
};

const schedulerRunning = () => timers.callbacks.size > 0;

const harness = (contextOptions: FakeContextOptions = {}) => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const context = new FakeAudioContext(contextOptions);
  const engine = new MetronomeEngine({ createContext: () => context });
  return { context, engine };
};

/**
 * A `navigator.audioSession` that remembers every type it was given, in order.
 * The session is a single global the whole page shares, so what matters is not
 * only where it ends up but that the engine never leaves it somewhere it has no
 * claim to be.
 */
const recordingAudioSession = () => {
  const types = [];
  return {
    types,
    audioSession: {
      get type() {
        return types.at(-1) ?? "auto";
      },
      set type(next) {
        types.push(next);
      },
    },
  };
};

/** Installs a fake `navigator` for one test and takes it away again after. */
const withNavigator = (t, value) => {
  t.after(installGlobal("navigator", value));
};

/** Everything the engine reported through `audioerror`, in order. */
const audioErrorsOf = (engine) => {
  const errors = [];
  engine.addEventListener("audioerror", (event) => errors.push(event.detail));
  return errors;
};

/**
 * Fixtures are repaired by the same `createConfiguration` the application uses,
 * so a Configuration the engine is started with here cannot drift from the one
 * it is started with in the browser. Identifiers are left to that function: it
 * only trusts the shape it issues itself, and nothing below names a rhythm.
 */
const configurationOf = (bpm, rhythms) =>
  createConfiguration({
    bpm,
    masterVolume: 0.8,
    sequence: { cycles: [{ repetitions: 1, rhythms }] },
  });

/** One rhythm event per second at 60 bpm. */
const pulsePerSecond = () =>
  configurationOf(60, [{ signature: { count: 1, unit: 4 }, subdivision: 1 }]);

/** A subdivided primary-beat grid with one rhythm event every 50 ms. */
const fiftyMillisecondGrid = () =>
  configurationOf(300, [{ signature: { count: 4, unit: 8 }, subdivision: 4 }]);

/** Audio times are sums of binary fractions; a nanosecond is not a defect. */
const roundSeconds = (value: number) => Math.round(value * 1e6) / 1e6;

/** The instants the engine committed each audible click to start at. */
const clickStarts = (context: FakeAudioContext) =>
  context.audibleClicks().map((click) => roundSeconds(click.when));

/** The spacing a listener actually hears between consecutive clicks. */
const gapsBetween = (starts: number[]) =>
  starts.slice(1).map((start, index) => roundSeconds(start - starts[index]));

/** Voices one `scheduleClickVoice` call each, in their own contexts. */
const voiceClicks = (voices) =>
  voices.map((voice) => {
    const context = new FakeAudioContext();
    const oscillator = scheduleClickVoice(context, context.destination, {
      sound: "high",
      voice,
      when: 1,
    });
    return { context, oscillator };
  });

test("every audible Step voice shares one gain envelope and its own pitch", () => {
  const [tertiary, secondary, primary] = voiceClicks([STEP.TERTIARY, STEP.SECONDARY, STEP.PRIMARY]);

  for (const { context } of [tertiary, secondary]) {
    assert.deepEqual(context.gains[0].gain.automation, primary.context.gains[0].gain.automation);
  }
  assert.equal(primary.context.gains[0].gain.automation[1].value, CLICK_ENVELOPE.peakGain);

  for (const [voice, { oscillator }] of [
    [STEP.TERTIARY, tertiary],
    [STEP.SECONDARY, secondary],
    [STEP.PRIMARY, primary],
  ]) {
    assert.equal(
      oscillator.frequency.value,
      SOUND_PROFILES.high.frequency * STEP_PITCH_RATIOS[voice],
    );
  }
  assert.ok(tertiary.oscillator.frequency.value < secondary.oscillator.frequency.value);
  assert.ok(secondary.oscillator.frequency.value < primary.oscillator.frequency.value);
});

/**
 * `scheduleClickVoice` is public surface (ADR-0004), so it is reached with
 * values the Configuration repair never saw. Silence is the only safe answer:
 * an unrecognised voice has no pitch to play, and guessing one puts a
 * full-gain click on the grid at a position the listener switched off.
 */
test("a Step voice outside the vocabulary schedules silence", () => {
  const unrecognised = [
    STEP.OFF,
    "full",
    "bogus",
    undefined,
    null,
    "",
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
  ];

  for (const voice of unrecognised) {
    const context = new FakeAudioContext();
    const oscillator = scheduleClickVoice(context, context.destination, {
      sound: "high",
      voice,
      when: 1,
    });

    assert.equal(oscillator, null, `${String(voice)} scheduled a click`);
    assert.deepEqual(context.clicks, [], `${String(voice)} reached the graph`);
    assert.deepEqual(context.oscillators, [], `${String(voice)} built a node`);
  }
});

/**
 * The same claim one seam out. `plan()` filters only `off`, so an unrecognised
 * voice arrives at the engine as an ordinary event and is refused at the pitch
 * table — the single audibility decision ADR-0008 describes. What matters is
 * that refusing it costs the rest of the grid nothing: the surrounding clicks
 * keep the start times they would have had, so the hole is one silent position
 * rather than a shifted rhythm.
 */
test("an unrecognised voice leaves a silent position and an intact grid", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  const grid = fiftyMillisecondGrid();
  grid.sequence.cycles[0].rhythms[0].steps[1] = "full";

  await engine.start(grid);
  for (const clock of [0.12, 0.24, 0.36]) {
    context.currentTime = clock;
    tick();
  }

  // The on-time grid without its second position: 0.11 is silent and 0.16
  // still lands where it always did.
  assert.deepEqual(clickStarts(context), [0.06, 0.16, 0.21, 0.26, 0.31, 0.36, 0.41, 0.46]);

  engine.stop();
});

test("an unrecognised sound falls back to the high profile, inherited or not", () => {
  for (const sound of ["bogus", undefined, "constructor", "toString"]) {
    const context = new FakeAudioContext();
    const oscillator = scheduleClickVoice(context, context.destination, {
      sound,
      voice: STEP.PRIMARY,
      when: 1,
    });

    assert.equal(
      oscillator.frequency.value,
      SOUND_PROFILES.high.frequency,
      `${String(sound)} did not fall back to the high profile`,
    );
    assert.equal(oscillator.type, SOUND_PROFILES.high.type);
  }
});

/**
 * The sound names were written out in three places: the profile table that
 * tunes them, the repair that validates them, and the choice list the interface
 * renders. Nothing failed when only one of the three learned a new name — the
 * profile simply sat there unreachable, because repair rejected the name that
 * would have selected it. These assertions are what make that drift loud.
 */
test("one sound vocabulary reaches the profiles, the repair, and the interface", () => {
  const names = Object.values(SOUND);

  assert.deepEqual(Object.keys(SOUND_PROFILES).sort(), [...names].sort());
  assert.deepEqual(describeConfiguration(createConfiguration()).choices.sounds, names);

  // The choice list is what the interface offers; repair is what decides
  // whether choosing it survives being saved and read back. A name the list
  // offers and repair rejects would silently return every rhythm to `high`.
  for (const sound of names) {
    const repaired = createConfiguration({
      sequence: { cycles: [{ rhythms: [{ sound }] }] },
    });

    assert.equal(
      repaired.sequence.cycles[0].rhythms[0].sound,
      sound,
      `repair did not preserve the ${sound} sound`,
    );
  }
});

test("every sound profile carries the same tuning shape", () => {
  for (const name of Object.values(SOUND)) {
    const profile = SOUND_PROFILES[name];

    assert.ok(profile.frequency > 0, `${name} has no frequency`);
    assert.equal(typeof profile.type, "string");
    assert.ok(profile.durationSeconds > 0, `${name} has no durationSeconds`);
    assert.ok(Object.isFrozen(profile));
  }
});

test("the Step pitch table answers only to the vocabulary model.ts defines", () => {
  assert.deepEqual(
    Object.keys(STEP_PITCH_RATIOS).sort(),
    [STEP.PRIMARY, STEP.SECONDARY, STEP.TERTIARY].sort(),
  );
  assert.equal(Object.getPrototypeOf(STEP_PITCH_RATIOS), null);
  for (const inherited of ["constructor", "toString", "valueOf"]) {
    assert.equal(STEP_PITCH_RATIOS[inherited], undefined);
  }
});

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
  // The output stage is a constant, not a mix value read from state.
  assert.equal(context.gains[0].gain.value, 0.8);

  engine.stop();
});

test("restarting audio replaces its context and begins a fresh Transport run", async () => {
  timers.callbacks.clear();
  const failed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 8 });
  const contexts = [failed, replacement];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const configuration = pulsePerSecond();

  await engine.start(configuration);
  const staleSources = [...failed.oscillators];
  const failedOrigin = engine.origin;

  await engine.restartAudio(configuration);

  assert.equal(engine.playing, true);
  assert.equal(failedOrigin, 0.06);
  assert.equal(engine.origin, 8.06);
  assert.deepEqual(clickStarts(replacement), [8.06]);
  assert.equal(
    staleSources.every((source) => source.stopped && source.outputs.length === 0),
    true,
  );
  assert.deepEqual(contexts, []);

  engine.stop();
});

test("simultaneous audio restarts coalesce into one replacement", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const original = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 10 });
  const laterReplacement = new FakeAudioContext({ state: "running", currentTime: 20 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [original, replacement, laterReplacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const configuration = pulsePerSecond();

  await engine.start(configuration);
  let replacementRuns = 0;
  engine.addEventListener("playstate", () => {
    replacementRuns += 1;
  });

  const first = engine.restartAudio(configuration);
  const simultaneous = engine.restartAudio(configuration);
  await Promise.all([first, simultaneous]);

  assert.equal(replacementRuns, 1);
  assert.equal(engine.origin, 10.06);
  assert.deepEqual(contexts, [laterReplacement, unexpected]);

  await engine.restartAudio(configuration);

  assert.equal(replacementRuns, 2);
  assert.equal(engine.origin, 20.06);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a replacement context recovers independently of an abandoned hanging recovery", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const abandoned = new FakeAudioContext({ state: "running", currentTime: 0 });
  abandoned.resumeBehaviour = "hang";
  const replacement = new FakeAudioContext({ state: "running", currentTime: 10 });
  const recovered = new FakeAudioContext({ state: "running", currentTime: 20 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [abandoned, replacement, recovered, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const errors = audioErrorsOf(engine);
  const configuration = pulsePerSecond();

  await engine.start(configuration);
  abandoned.setState("suspended");
  engine.checkAudioAfterForeground();
  assert.equal(abandoned.resumeCalls, 1);

  await engine.restartAudio(configuration);
  replacement.resumeBehaviour = "reject";
  replacement.setState("suspended");
  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(replacement.resumeCalls, 1);
  assert.equal(engine.origin, 20.06);
  assert.deepEqual(contexts, [unexpected]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not allowed to start/i);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.origin, 20.06);
  assert.deepEqual(contexts, [unexpected]);
  assert.equal(errors.length, 1);

  engine.stop();
});

test("an audio render error replaces the context and begins a fresh Transport run", async () => {
  timers.callbacks.clear();
  const failed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 12 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 20 });
  const contexts = [failed, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  failed.dispatchEvent(new Event("error"));

  assert.equal(engine.origin, 12.06);
  assert.deepEqual(clickStarts(replacement), [12.06]);
  assert.deepEqual(contexts, [unexpected]);

  failed.dispatchEvent(new Event("error"));

  assert.equal(engine.origin, 12.06);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a render error reports one failed replacement and abandons playback", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  timers.callbacks.clear();
  const failed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const constructionError = new Error("cannot replace AudioContext");
  let constructions = 0;
  const engine = new MetronomeEngine({
    createContext: () => {
      constructions += 1;
      if (constructions === 1) return failed;
      throw constructionError;
    },
  });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  const playstates = [];
  engine.addEventListener("playstate", () => playstates.push(engine.playing));
  failed.dispatchEvent(new Event("error"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [constructionError]);
  assert.deepEqual(playstates, [false]);
  assert.equal(engine.playing, false);
  assert.equal(schedulerRunning(), false);
  assert.deepEqual(types, ["playback", "auto"]);

  failed.dispatchEvent(new Event("error"));
  tick(4);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [constructionError]);
  assert.deepEqual(playstates, [false]);
  assert.equal(constructions, 2);
});

test("a rejected suspended-context recovery begins a fresh Transport run", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const suspended = new FakeAudioContext({ state: "running", currentTime: 0 });
  suspended.resumeBehaviour = "reject";
  const replacement = new FakeAudioContext({ state: "running", currentTime: 15 });
  const contexts = [suspended, replacement];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  suspended.setState("suspended");
  tick(STUCK_CONTEXT_TICKS * 2);

  assert.equal(suspended.resumeCalls, 0);
  assert.equal(engine.origin, 0.06);
  assert.deepEqual(contexts, [replacement]);

  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(suspended.resumeCalls, 1);
  assert.equal(engine.origin, 15.06);
  assert.deepEqual(clickStarts(replacement), [15.06]);
  assert.deepEqual(contexts, []);
  assert.equal(timers.deadlines.size, 0);

  engine.stop();
});

test("a visible suspended transition recovers immediately", async (t) => {
  t.after(installGlobal("document", { visibilityState: "visible" }));
  timers.callbacks.clear();
  timers.deadlines.clear();
  const suspended = new FakeAudioContext({ state: "running", currentTime: 0 });
  suspended.resumeBehaviour = "reject";
  const replacement = new FakeAudioContext({ state: "running", currentTime: 16 });
  const contexts = [suspended, replacement];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  suspended.setState("suspended");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(suspended.resumeCalls, 1);
  assert.equal(engine.origin, 16.06);
  assert.deepEqual(clickStarts(replacement), [16.06]);
  assert.deepEqual(contexts, []);

  engine.stop();
});

test("an unchanged suspended episode gets only one recovery attempt", async (t) => {
  t.after(installGlobal("document", { visibilityState: "visible" }));
  timers.callbacks.clear();
  timers.deadlines.clear();
  const suspended = new FakeAudioContext({ state: "running", currentTime: 0 });
  const engine = new MetronomeEngine({ createContext: () => suspended });

  await engine.start(pulsePerSecond());
  suspended.setState("suspended");
  await new Promise((resolve) => setImmediate(resolve));

  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(suspended.resumeCalls, 1);

  suspended.setState("running");
  suspended.setState("suspended");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(suspended.resumeCalls, 2);

  engine.stop();
});

test("a timed-out visible suspended recovery reports once and replaces once", async (t) => {
  t.after(installGlobal("document", { visibilityState: "visible" }));
  timers.callbacks.clear();
  timers.deadlines.clear();
  const suspended = new FakeAudioContext({ state: "running", currentTime: 0 });
  suspended.resumeBehaviour = "hang";
  const replacement = new FakeAudioContext({ state: "running", currentTime: 19 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [suspended, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  suspended.setState("suspended");
  assert.equal(suspended.resumeCalls, 1);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /recovery.*timed out/i);
  assert.equal(engine.origin, 19.06);
  assert.deepEqual(clickStarts(replacement), [19.06]);
  assert.deepEqual(contexts, [unexpected]);

  suspended.dispatchEvent(new Event("error"));
  suspended.setState("running");
  tick(STUCK_CONTEXT_TICKS * 2);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.equal(engine.origin, 19.06);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a visible closed transition is replaced immediately", async (t) => {
  t.after(installGlobal("document", { visibilityState: "visible" }));
  timers.callbacks.clear();
  timers.deadlines.clear();
  const closed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 17 });
  const contexts = [closed, replacement];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  closed.setState("closed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed.resumeCalls, 0);
  assert.equal(closed.suspendCalls, 0);
  assert.equal(engine.origin, 17.06);
  assert.deepEqual(clickStarts(replacement), [17.06]);
  assert.deepEqual(contexts, []);

  engine.stop();
});

/** Every automated value the master gain was given, oldest first. */
const masterGainAutomation = (context: FakeAudioContext) =>
  context.gains[0].gain.automation
    .filter((entry) => entry.method !== "cancelScheduledValues")
    .map((entry) => entry.value);

/**
 * `stop()` zeroes the master to silence the graph, and a preserved context hands
 * the same node back on the next run. Nothing else restores it, so a run that
 * did not put the gain back would be inaudible with every other assertion here
 * still passing: the clicks are scheduled, connected and correctly voiced,
 * behind a gain of zero.
 */
test("a restart on a preserved context lifts the master gain off zero", async () => {
  const { context, engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());
  assert.equal(context.gains[0].gain.value, 0.8);

  engine.stop();
  assert.equal(masterGainAutomation(context).at(-1), 0);

  await engine.start(pulsePerSecond());
  assert.equal(masterGainAutomation(context).at(-1), 0.8);
  // The same node throughout: a fresh gain would have masked a missing restore.
  assert.equal(context.gains[0].outputs.length, 1);
  assert.deepEqual(context.gains[0].outputs, [context.destination]);

  engine.stop();
});

/**
 * A Configuration stored before ADR-0007 still carries `masterVolume`. Repair
 * drops the field rather than migrating it, so the engine must never see it —
 * and the output stage must sit at the constant either way.
 */
test("a stored master volume does not reach the output stage", async () => {
  const { context, engine } = harness({ state: "running" });
  const legacy = createConfiguration({
    bpm: 60,
    masterVolume: 0.11,
    sequence: {
      cycles: [
        {
          repetitions: 1,
          rhythms: [{ signature: { count: 1, unit: 4 }, subdivision: 1, steps: [STEP.PRIMARY] }],
        },
      ],
    },
  });

  assert.equal("masterVolume" in legacy, false);

  await engine.start(legacy);
  assert.equal(context.gains[0].gain.value, 0.8);
  assert.equal(masterGainAutomation(context).includes(0.11), false);

  engine.stop();
});

test("a resume that never settles still installs the look-ahead scheduler", {
  timeout: 2000,
}, async () => {
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
});

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
  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));
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

test("foreground recovery asks once for an interrupted run and preserves its origin", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const interrupted = new FakeAudioContext({ state: "running", currentTime: 0 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 20 });
  const contexts = [interrupted, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  const origin = engine.origin;
  interrupted.setState("interrupted");
  tick(STUCK_CONTEXT_TICKS * 2);

  assert.equal(interrupted.resumeCalls, 0);

  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(interrupted.resumeCalls, 1);
  interrupted.setState("running");
  interrupted.currentTime = 0.95;
  tick();

  assert.equal(engine.origin, origin);
  assert.deepEqual(clickStarts(interrupted), [0.06, 1.06]);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("an unchanged interrupted episode gets only one foreground recovery attempt", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const interrupted = new FakeAudioContext({ state: "running", currentTime: 0 });
  const engine = new MetronomeEngine({ createContext: () => interrupted });

  await engine.start(pulsePerSecond());
  interrupted.setState("interrupted");

  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));
  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(interrupted.resumeCalls, 1);

  interrupted.setState("running");
  interrupted.setState("interrupted");
  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(interrupted.resumeCalls, 2);

  engine.stop();
});

test("a rejected foreground recovery replaces an interrupted context once", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const interrupted = new FakeAudioContext({ state: "running", currentTime: 0 });
  interrupted.resumeBehaviour = "reject";
  const replacement = new FakeAudioContext({ state: "running", currentTime: 18 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [interrupted, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  interrupted.setState("interrupted");
  tick(STUCK_CONTEXT_TICKS * 2);
  assert.equal(interrupted.resumeCalls, 0);

  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(interrupted.resumeCalls, 1);
  assert.equal(engine.origin, 18.06);
  assert.deepEqual(clickStarts(replacement), [18.06]);
  assert.deepEqual(contexts, [unexpected]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not allowed to start/i);

  tick(STUCK_CONTEXT_TICKS * 2);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(contexts, [unexpected]);
  assert.equal(errors.length, 1);

  engine.stop();
});

test("a clock that begins advancing just after foreground grace is left running", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const running = new FakeAudioContext({
    state: "running",
    currentTime: 3,
    suspend: "transition",
    resume: "transition",
  });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [running, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  const origin = engine.origin;
  engine.checkAudioAfterForeground();

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));
  running.currentTime = 3.1;
  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(running.suspendCalls, 0);
  assert.equal(running.resumeCalls, 0);
  assert.equal(engine.origin, origin);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a frozen running clock gets one soft recovery and preserves its Transport run", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const running = new FakeAudioContext({
    state: "running",
    currentTime: 4,
    suspend: "transition",
    resume: "transition",
  });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [running, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  const origin = engine.origin;
  engine.checkAudioAfterForeground();

  assert.equal(running.suspendCalls, 0);
  assert.equal(running.resumeCalls, 0);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(running.suspendCalls, 0);
  assert.equal(running.resumeCalls, 0);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));
  running.currentTime = 4.5;
  tick();

  assert.equal(running.suspendCalls, 1);
  assert.equal(running.resumeCalls, 1);
  assert.equal(engine.origin, origin);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a clock still frozen after soft recovery begins a fresh Transport run", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const frozen = new FakeAudioContext({
    state: "running",
    currentTime: 6,
    suspend: "transition",
    resume: "transition",
  });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 24 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [frozen, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  engine.checkAudioAfterForeground();

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frozen.suspendCalls, 0);
  assert.equal(frozen.resumeCalls, 0);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frozen.suspendCalls, 1);
  assert.equal(frozen.resumeCalls, 1);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.origin, 24.06);
  assert.deepEqual(clickStarts(replacement), [24.06]);
  assert.deepEqual(contexts, [unexpected]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /clock.*not advancing/i);

  tick(STUCK_CONTEXT_TICKS * 2);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a rejected soft recovery reports once and begins a fresh Transport run", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const frozen = new FakeAudioContext({
    state: "running",
    currentTime: 7,
    suspend: "reject",
  });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 25 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 30 });
  const contexts = [frozen, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  engine.checkAudioAfterForeground();
  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frozen.suspendCalls, 0);

  runNextDeadline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frozen.suspendCalls, 1);
  assert.equal(frozen.resumeCalls, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not allowed to suspend/i);
  assert.equal(engine.origin, 25.06);
  assert.deepEqual(clickStarts(replacement), [25.06]);
  assert.deepEqual(contexts, [unexpected]);

  tick(STUCK_CONTEXT_TICKS * 2);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("foreground recovery immediately replaces a closed context", async () => {
  timers.callbacks.clear();
  timers.deadlines.clear();
  const closed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 32 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 40 });
  const contexts = [closed, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  closed.setState("closed");
  engine.checkAudioAfterForeground();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed.resumeCalls, 0);
  assert.equal(closed.suspendCalls, 0);
  assert.equal(engine.origin, 32.06);
  assert.deepEqual(clickStarts(replacement), [32.06]);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

test("a context that closes during a foreground clock probe is replaced", async (t) => {
  t.after(installGlobal("document", { visibilityState: "visible" }));
  timers.callbacks.clear();
  timers.deadlines.clear();
  const closed = new FakeAudioContext({ state: "running", currentTime: 0 });
  const replacement = new FakeAudioContext({ state: "running", currentTime: 33 });
  const unexpected = new FakeAudioContext({ state: "running", currentTime: 40 });
  const contexts = [closed, replacement, unexpected];
  const engine = new MetronomeEngine({ createContext: () => contexts.shift() });

  await engine.start(pulsePerSecond());
  engine.checkAudioAfterForeground();
  closed.setState("closed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.origin, 33.06);
  assert.deepEqual(clickStarts(replacement), [33.06]);
  assert.deepEqual(contexts, [unexpected]);

  engine.stop();
});

/**
 * A context that never reaches `running` is the silent failure with no symptom:
 * `playing` reports true, the scheduler ticks on, and nothing is ever heard.
 * The five tests below fix when the engine is allowed to say so, how often, and
 * what it must not give up in order to say it.
 */

test("a context that never starts reports itself once the threshold passes", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "hang" });
  const errors = audioErrorsOf(engine);

  // `start()` runs the run's first tick itself, so the run is one tick in.
  await engine.start(pulsePerSecond());
  tick(STUCK_CONTEXT_TICKS - 2);

  assert.deepEqual(errors, []);

  tick();

  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof Error, true);
  assert.match(errors[0].message, /audio/i);
  assert.deepEqual(context.audibleClicks(), []);

  engine.stop();
});

test("a run that never started is reported rather than retried", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "hang" });

  await engine.start(pulsePerSecond());
  assert.equal(context.resumeCalls, 1);

  // This run is told to tap play again, and that tap carries the activation a
  // resume needs; asking on a timer instead would spend requests on the one
  // gate that a timer can never open.
  tick(STUCK_CONTEXT_TICKS * 2);

  assert.equal(context.resumeCalls, 1);

  engine.stop();
});

test("reporting a stuck context does not abandon the run", async () => {
  const { engine } = harness({ state: "suspended", resume: "hang" });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  tick(STUCK_CONTEXT_TICKS - 1);
  assert.equal(errors.length, 1);

  // Recovery is still the point: a user who answers a phone call and comes back
  // must still get their metronome, which needs the scheduler still installed.
  assert.equal(engine.playing, true);
  assert.equal(schedulerRunning(), true);

  tick(STUCK_CONTEXT_TICKS * 3);

  assert.equal(errors.length, 1);

  engine.stop();
});

test("a context that starts before the threshold never reports", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "hang" });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  tick(2);
  context.setState("running");
  tick(STUCK_CONTEXT_TICKS * 2);

  assert.deepEqual(errors, []);
  assert.equal(context.audibleClicks().length > 0, true);

  engine.stop();
});

test("a run that reported a stuck context still plays once it starts", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "hang" });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  tick(STUCK_CONTEXT_TICKS - 1);
  assert.equal(errors.length, 1);

  context.currentTime = 0.95;
  context.setState("running");
  tick();

  assert.equal(engine.origin, 1.01);
  assert.deepEqual(
    context.audibleClicks().map((click) => click.when),
    [1.01],
  );

  engine.stop();
});

test("a later run reports its own silence", async () => {
  const { engine } = harness({ state: "suspended", resume: "hang" });
  const errors = audioErrorsOf(engine);

  await engine.start(pulsePerSecond());
  tick(STUCK_CONTEXT_TICKS - 1);
  assert.equal(errors.length, 1);

  engine.stop();

  await engine.start(pulsePerSecond());
  tick(STUCK_CONTEXT_TICKS - 2);
  assert.equal(errors.length, 1);

  tick();
  assert.equal(errors.length, 2);

  engine.stop();
});

/**
 * The `playback` audio session type is not free: it is nonmixable, so claiming
 * it interrupts whatever else is playing, and a backing track is a metronome's
 * most likely companion. The engine may hold it while it is sounding and must
 * hand it back when it stops. All of it is best effort — the type is Safari
 * 16.4+, and a Permissions Policy may refuse it outright — so none of it may
 * ever be load-bearing for starting or stopping.
 */

test("starting playback claims the playback audio session", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  const { engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());

  assert.deepEqual(types, ["playback"]);

  engine.stop();
});

test("stopping playback hands the audio session back", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  const { engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());
  engine.stop();

  assert.equal(audioSession.type, "auto");
  assert.deepEqual(types, ["playback", "auto"]);
});

test("the audio session is claimed before the context is created", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  timers.callbacks.clear();
  const context = new FakeAudioContext({ state: "running" });
  let typeWhenCreated = null;
  const engine = new MetronomeEngine({
    createContext: () => {
      typeWhenCreated = audioSession.type;
      return context;
    },
  });

  await engine.start(pulsePerSecond());

  // A context created under `Ambient` keeps that session for its whole life.
  assert.equal(typeWhenCreated, "playback");
  assert.deepEqual(types, ["playback"]);

  engine.stop();
});

test("a start, stop and start cycle leaves the session where the run is", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  const { engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());
  engine.stop();
  await engine.start(pulsePerSecond());

  assert.deepEqual(types, ["playback", "auto", "playback"]);

  engine.stop();

  assert.equal(audioSession.type, "auto");
});

test("restarting a run holds the session it already has", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  const { engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());
  // Editing a signature mid-run clears the transport and starts it again, but
  // the metronome never falls silent, so nothing else on the device should hear
  // the session go down and come back up.
  await engine.restart(fiftyMillisecondGrid());

  assert.deepEqual(types, ["playback"]);

  engine.stop();

  assert.deepEqual(types, ["playback", "auto"]);
});

test("a start that cannot build a context hands the session straight back", async (t) => {
  const { types, audioSession } = recordingAudioSession();
  withNavigator(t, { audioSession });
  timers.callbacks.clear();
  // The browser refusing another AudioContext: the session is already claimed
  // by the time the refusal lands, and nothing downstream will release it —
  // `app.ts` reports the rejection and does not call `stop()`.
  const refusal = new Error("cannot construct another AudioContext");
  const engine = new MetronomeEngine({
    createContext: () => {
      throw refusal;
    },
  });

  // The original failure is what the caller has to show the user, so releasing
  // must not replace it with a failure of its own.
  await assert.rejects(
    () => engine.start(pulsePerSecond()),
    (error) => error === refusal,
  );

  assert.deepEqual(types, ["playback", "auto"]);
  assert.equal(audioSession.type, "auto");
  assert.equal(engine.playing, false);
  assert.equal(schedulerRunning(), false);
});

test("a browser without an audio session starts and stops as usual", async (t) => {
  withNavigator(t, {});
  const { context, engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());

  assert.equal(engine.playing, true);
  assert.equal(context.audibleClicks().length > 0, true);

  engine.stop();

  assert.equal(engine.playing, false);
  assert.equal(schedulerRunning(), false);
});

test("an audio session that refuses the type starts and stops as usual", async (t) => {
  withNavigator(t, {
    audioSession: {
      get type() {
        return "auto";
      },
      set type(next) {
        throw new Error(`Permissions Policy refused ${next}`);
      },
    },
  });
  const { context, engine } = harness({ state: "running" });

  await engine.start(pulsePerSecond());

  assert.equal(engine.playing, true);
  assert.equal(context.audibleClicks().length > 0, true);

  engine.stop();

  assert.equal(engine.playing, false);
  assert.equal(schedulerRunning(), false);
});

/**
 * Lateness is only meaningful against the grid it is measured on, so the four
 * tests below fix the resulting start times rather than counting clicks: a
 * click that is sounded in the wrong place is not a click that was sounded.
 */

test("an on-time transport run puts every click exactly on the grid", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  for (const clock of [0.12, 0.24, 0.36]) {
    context.currentTime = clock;
    tick();
  }

  const starts = clickStarts(context);
  assert.deepEqual(starts, [0.06, 0.11, 0.16, 0.21, 0.26, 0.31, 0.36, 0.41, 0.46]);
  assert.deepEqual(gapsBetween(starts), Array(8).fill(0.05));

  engine.stop();
});

test("a marginally late rhythm event is nudged forward rather than dropped", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());

  // The clock lands 5 ms past the event planned for 0.16: a tenth of a step.
  // Sounding it 5 ms late is a smaller error than the 100 ms hole that
  // dropping it would leave.
  context.currentTime = 0.12;
  context.advanceAfterSchedulingSnapshot(0.045);
  tick();

  const starts = clickStarts(context);
  assert.deepEqual(starts, [0.06, 0.11, 0.165, 0.21]);
  assert.deepEqual(gapsBetween(starts), [0.05, 0.055, 0.045]);

  engine.stop();
});

test("a rhythm event most of a step late is dropped so the grid survives", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.deepEqual(clickStarts(context), [0.06, 0.11]);

  // 45 ms is 90% of a 50 ms step. Dragging the 0.16 event up to the clock
  // would put it 5 ms in front of the 0.21 event, which is a flam, not a
  // metronome. A gap keeps the remaining events on the grid.
  context.currentTime = 0.12;
  context.advanceAfterSchedulingSnapshot(0.085);
  tick();

  const starts = clickStarts(context);
  assert.deepEqual(starts, [0.06, 0.11, 0.21]);
  assert.deepEqual(gapsBetween(starts), [0.05, 0.1]);

  engine.stop();
});

test("a fast grid stops nudging a quarter of a step late", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.deepEqual(clickStarts(context), [0.06, 0.11]);

  // 15 ms is past a quarter of this 50 ms step, and nowhere near the 50 ms
  // that bounds a slow grid. Only the step-relative limit can drop it, so this
  // is what holds the quarter to a quarter.
  context.currentTime = 0.12;
  context.advanceAfterSchedulingSnapshot(0.055);
  tick();

  assert.deepEqual(clickStarts(context), [0.06, 0.11, 0.21]);

  engine.stop();
});

test("the same absolute lateness is nudged forward on a slow grid", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(pulsePerSecond());
  assert.deepEqual(clickStarts(context), [0.06]);

  // The same 45 ms that costs a 50 ms grid its shape is 4.5% of a one-second
  // step, and losing a whole beat is far worse than starting it late.
  context.currentTime = 1;
  context.advanceAfterSchedulingSnapshot(0.105);
  tick();

  const starts = clickStarts(context);
  assert.deepEqual(starts, [0.06, 1.105]);
  assert.equal(roundSeconds(starts[1] - 1.06), 0.045);

  engine.stop();
});

test("a slow grid stops nudging 50 ms late, long before a quarter of its step", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(pulsePerSecond());
  assert.deepEqual(clickStarts(context), [0.06]);

  // 55 ms is a twentieth of this one-second step, so the step-relative limit
  // is nowhere near binding: only the absolute 50 ms can drop this event, and
  // beyond it the sound profile is shorter than the drift.
  context.currentTime = 1;
  context.advanceAfterSchedulingSnapshot(0.115);
  tick();

  assert.deepEqual(clickStarts(context), [0.06]);

  engine.stop();
});

/**
 * Syncing the audio graph is real work on a real render thread, and on a phone
 * waking from an interruption it is not cheap. Whatever it costs is the
 * engine's own overhead, not lateness in the events it is about to plan, so a
 * tick has to plan against the clock the sync leaves behind rather than the one
 * it started with.
 */
test("a tick whose graph sync burns clock time still schedules on the grid", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.deepEqual(clickStarts(context), [0.06, 0.11]);

  // The sync costs more than the entire look-ahead window.
  context.currentTime = 0.12;
  context.advanceDuringNextGraphSync(0.14);
  tick();

  // Nothing is clamped and nothing is abandoned: the events the tick can still
  // reach are the ones from 0.26 on, and each lands exactly on its grid time.
  const starts = clickStarts(context);
  assert.deepEqual(starts, [0.06, 0.11, 0.26, 0.31, 0.36]);
  assert.deepEqual(gapsBetween(starts), [0.05, 0.15, 0.05, 0.05]);

  engine.stop();
});

test("a hopelessly stale rhythm event is skipped rather than dragged forward", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });

  await engine.start(fiftyMillisecondGrid());
  assert.deepEqual(clickStarts(context), [0.06, 0.11]);

  context.currentTime = 0.12;
  context.advanceAfterSchedulingSnapshot(0.13);
  tick();

  // Both planned events are more than a quarter step behind the clock by the
  // time they would be committed, so the tick sounds nothing rather than
  // stacking two clicks onto the same instant.
  assert.deepEqual(clickStarts(context), [0.06, 0.11]);

  engine.stop();
});

test("without a factory the engine still reports an unsupported Web Audio API", async () => {
  timers.callbacks.clear();
  const engine = new MetronomeEngine();

  await assert.rejects(() => engine.start(pulsePerSecond()), /does not support the Web Audio API/);
  assert.equal(schedulerRunning(), false);
});

/**
 * What the interface reads off a run in progress: which Cycle and repetition it
 * is in, which Pattern position each layer is on, and the tempo sounding right
 * now. All three answer `null` unless a run is playing on a context that has
 * actually been anchored to a start time, because `app.ts` falls back to the
 * stored tempo on exactly that reading — a run that has not sounded yet has no
 * position to report, and reporting one would put the playhead on a beat
 * nobody has heard.
 */
test("a run reports no position or tempo until it is anchored and sounding", async () => {
  const { context, engine } = harness({ state: "suspended", resume: "hang" });
  const configuration = pulsePerSecond();

  assert.equal(engine.activeBpm(), null);
  assert.equal(engine.activePosition(), null);

  // Started, but on a context that never reaches `running`, so the transport is
  // never given an origin and there is nothing yet to be positioned against.
  await engine.start(configuration);
  assert.equal(engine.activeBpm(), null);
  assert.equal(engine.activePosition(), null);
  assert.equal(engine.activeStep(configuration.sequence.cycles[0].rhythms[0]), null);

  engine.stop();
  assert.equal(engine.activeBpm(), null);
  assert.equal(context.state, "suspended");
});

/**
 * Anchored, the tempo is read from the Cycle's own curve rather than from the
 * Configuration, which is what makes a BPM envelope audible to the readout: a
 * Flat Cycle reports the one tempo it holds, and a rising one reports a
 * different tempo at each instant it is asked about.
 */
test("an anchored run reports the tempo its envelope is sounding", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });
  const configuration = pulsePerSecond();

  await engine.start(configuration);
  // The transport is anchored a START_DELAY_SECONDS beat ahead of the clock, so
  // the origin itself is where the first tempo is read.
  context.currentTime = 0.06;
  assert.equal(engine.activeBpm(), 60);
  assert.deepEqual(engine.activePosition().repetitionIndex, 0);
  assert.equal(engine.activeStep(configuration.sequence.cycles[0].rhythms[0]), 0);

  engine.stop();
  assert.equal(engine.activeBpm(), null);
});

test("a rising envelope is reported as a different tempo at each instant", async () => {
  const { context, engine } = harness({ state: "running", currentTime: 0 });
  const rising = createConfiguration({
    bpm: 60,
    sequence: {
      cycles: [
        {
          repetitions: 1,
          envelope: { shape: "up", amount: 60 },
          rhythms: [{ signature: { count: 4, unit: 4 }, subdivision: 1 }],
        },
      ],
    },
  });

  await engine.start(rising);
  context.currentTime = 0.06;
  const first = engine.activeBpm();

  // Far enough along the four-beat ramp for the reading to have moved, and
  // short of its end, so this is the curve being read rather than the Cycle
  // having come round again at the tempo it started from.
  context.currentTime = 0.06 + 1.2;
  const later = engine.activeBpm();

  assert.equal(first, 60);
  assert.ok(later > first, `expected a tempo above ${first}, read ${later}`);
  assert.ok(later < 120, `expected a tempo below the 120 target, read ${later}`);

  engine.stop();
});
