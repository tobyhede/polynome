import test from "node:test";
import assert from "node:assert/strict";

import { changeConfiguration, createConfiguration } from "../configuration.js";
import { MetronomeEngine } from "../metronome.js";

/**
 * ADR-0003 claims that only a structural edit interrupts the transport run:
 * changing a Step voice or a mix value has to be audible without restarting
 * the pattern. That promise is kept by the routing from an edit's consequence
 * to an engine method, so these tests drive the routing directly and leave the
 * audio graph alone.
 *
 * `playing` is a getter over a private field the parent sets only by opening an
 * AudioContext, so the subclass overrides the getter rather than the state.
 */
class RoutingEngine extends MetronomeEngine {
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
