import test from "node:test";
import assert from "node:assert/strict";

import { changeConfiguration, createConfiguration } from "../configuration.ts";
import { MetronomeEngine } from "../metronome.ts";

/**
 * ADR-0003 claims that only a structural edit interrupts the transport run:
 * changing a Step voice or a mix value has to be audible without restarting
 * the pattern. That promise is kept by the routing from an edit's consequence
 * to an engine method, so these tests drive the routing directly and leave the
 * audio graph alone.
 *
 * `playing` is a getter over a private field the parent sets only by opening an
 * AudioContext, so the subclass overrides the getter rather than the state.
 * `isPlaying` is therefore deliberately not `playing`: the getter is the whole
 * point of the subclass, and a field of that name could not coexist with it.
 */

/** A method the routing chose, and the Configuration it was handed. */
type RecordedCall = [method: string, configuration: unknown];

class RoutingEngine extends MetronomeEngine {
  // `declare` rather than a bare class field, which is runtime syntax that
  // defines the property as `undefined` after `super()` and before the
  // constructor assigns to it. `declare` states the type and emits nothing, so
  // the subclass cannot acquire a behaviour from being annotated.
  declare isPlaying: boolean;
  declare calls: RecordedCall[];

  constructor(playing = false) {
    super();
    this.isPlaying = playing;
    this.calls = [];
  }

  get playing() {
    return this.isPlaying;
  }

  async restart(configuration) {
    this.calls.push(["restart", configuration]);
  }

  updateStepVoices(configuration) {
    this.calls.push(["updateStepVoices", configuration]);
  }

  updateConfiguration(configuration) {
    this.calls.push(["updateConfiguration", configuration]);
  }

  updateMix(configuration) {
    this.calls.push(["updateMix", configuration]);
  }
}

const configuration = Object.freeze({ marker: "configuration" });

test("a structural consequence restarts a running transport", async () => {
  const engine = new RoutingEngine(true);

  await engine.applyConsequence("restart-transport-run", configuration);

  assert.deepEqual(engine.calls, [["restart", configuration]]);
});

test("a Cycle envelope edit restarts one running transport", async () => {
  const configuration = createConfiguration();
  const result = changeConfiguration(configuration, {
    type: "set-cycle-envelope",
    cycleId: configuration.sequence.cycles[0].id,
    shape: "up",
    amount: 20,
  });
  const engine = new RoutingEngine(true);

  await engine.applyConsequence(result.consequence, result.configuration);

  assert.deepEqual(engine.calls, [["restart", result.configuration]]);
});

/**
 * A stopped transport has no run to preserve, and `restart` on an engine that
 * never opened a context would only re-sync anyway. Routing it to the mix path
 * keeps the stopped engine on one code path.
 */
test("a structural consequence re-syncs a stopped transport instead", async () => {
  const engine = new RoutingEngine(false);

  await engine.applyConsequence("restart-transport-run", configuration);

  assert.deepEqual(engine.calls, [["updateMix", configuration]]);
});

test("a step-voice consequence never restarts the transport", async () => {
  for (const playing of [true, false]) {
    const engine = new RoutingEngine(playing);

    await engine.applyConsequence("update-step-voices", configuration);

    assert.deepEqual(engine.calls, [["updateStepVoices", configuration]]);
  }
});

test("a mix consequence never restarts the transport", async () => {
  for (const playing of [true, false]) {
    const engine = new RoutingEngine(playing);

    await engine.applyConsequence("update-mix", configuration);

    assert.deepEqual(engine.calls, [["updateMix", configuration]]);
  }
});

test("a configuration-only consequence updates state without touching audio", async () => {
  for (const playing of [true, false]) {
    const engine = new RoutingEngine(playing);

    await engine.applyConsequence("update-configuration", configuration);

    assert.deepEqual(engine.calls, [["updateConfiguration", configuration]]);
  }
});

test("a no-op consequence leaves the transport untouched", async () => {
  const engine = new RoutingEngine(true);

  await engine.applyConsequence("none", configuration);

  assert.deepEqual(engine.calls, []);
});

/**
 * Only the restart path is asynchronous. It returns its promise so the caller
 * can report a failed restart; the synchronous paths return null so a caller
 * that always reports rejections does not have to guard against one.
 */
test("only the restart path yields a promise the caller can catch", () => {
  const running = new RoutingEngine(true);
  const restart = running.applyConsequence("restart-transport-run", configuration);
  assert.equal(typeof restart?.then, "function");

  const stopped = new RoutingEngine(false);
  assert.equal(stopped.applyConsequence("update-mix", configuration), null);
  assert.equal(stopped.applyConsequence("update-step-voices", configuration), null);
  assert.equal(stopped.applyConsequence("update-configuration", configuration), null);
  assert.equal(stopped.applyConsequence("none", configuration), null);
});

/**
 * The narrowest audio graph a start can be driven through: enough for the node
 * sync and one scheduler tick, and nothing else. `test/metronome-audio.test.ts`
 * owns the double that models WebKit's clock, its interruptions and its
 * refusals, and the test below needs none of that — it asks only whether the
 * run knows what it is playing.
 */
class StubAudioParam {
  declare value: number;

  constructor(value: number) {
    this.value = value;
  }

  setValueAtTime() {
    return this;
  }

  setTargetAtTime() {
    return this;
  }

  exponentialRampToValueAtTime() {
    return this;
  }

  cancelScheduledValues() {
    return this;
  }
}

class StubAudioNode {
  connect() {}
  disconnect() {}
}

class StubGainNode extends StubAudioNode {
  gain = new StubAudioParam(1);
}

class StubStereoPannerNode extends StubAudioNode {
  pan = new StubAudioParam(0);
}

class StubOscillatorNode extends EventTarget {
  type = "sine";
  frequency = new StubAudioParam(440);

  connect() {}
  start() {}
  stop() {}
}

class StubAudioContext extends EventTarget {
  state = "running";
  currentTime = 0;
  destination = new StubAudioNode();
  oscillators: StubOscillatorNode[] = [];

  createGain() {
    return new StubGainNode();
  }

  createStereoPanner() {
    return new StubStereoPannerNode();
  }

  createOscillator() {
    const node = new StubOscillatorNode();
    this.oscillators.push(node);
    return node;
  }
}

/**
 * The engine installs its scheduler through `window`, which Node has no reason
 * to define. Defining rather than assigning, and restoring afterwards, because
 * nothing isolates the tests inside one file from each other.
 */
const installWindow = (t) => {
  const callbacks = new Map();
  let nextId = 1;
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");

  Object.defineProperty(globalThis, "window", {
    value: {
      setInterval(callback) {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      },
      clearInterval(id) {
        callbacks.delete(id);
      },
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });

  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  });
};

/**
 * `start()` records the Configuration it was handed in the field every audible
 * part of a run then reads: without it the node sync builds no layer output and
 * a tick anchors no transport, so an engine that stopped recording it would
 * report `playing` while sounding nothing at all. The tempo is what is asserted
 * rather than the fact of a run, because only the argument could have supplied
 * it: a run holding no Configuration reports no tempo, and one holding the
 * wrong Configuration reports the wrong tempo.
 */
test("a run anchors its transport on the Configuration it was started with", async (t) => {
  installWindow(t);
  const context = new StubAudioContext();
  const engine = new MetronomeEngine({ createContext: () => context });
  const started = createConfiguration({
    bpm: 90,
    sequence: {
      cycles: [{ repetitions: 1, rhythms: [{ signature: { count: 1, unit: 4 }, subdivision: 1 }] }],
    },
  });

  await engine.start(started);

  assert.equal(engine.playing, true);
  assert.equal(engine.activeBpm(), 90, "the run anchored no transport");
  assert.equal(context.oscillators.length > 0, true, "the run scheduled no click");

  engine.stop();
});
