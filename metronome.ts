import { lookup, SOUND, STEP, stepDurationSeconds } from "./model.ts";
import { SharedTransport } from "./shared-transport.ts";

const LOOK_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.06;
// The output stage is fixed: loudness is the device's to control. The node
// remains because stopping silences the graph through it.
const MASTER_GAIN = 0.8;

/**
 * How long a run may report `playing` while its context has never once been
 * running before the engine says so out loud.
 *
 * Long enough that an ordinary start — a context that takes a few hundred
 * milliseconds to be granted — never trips it, and short enough that a user
 * staring at a silent metronome is told why before deciding the app is broken.
 */
const STUCK_CONTEXT_TIMEOUT_MS = 2000;
const STUCK_CONTEXT_TICKS = Math.ceil(STUCK_CONTEXT_TIMEOUT_MS / SCHEDULER_INTERVAL_MS);

const RECOVERY_ATTEMPT_TIMEOUT_MS = 1000;
const FOREGROUND_CLOCK_GRACE_MS = 250;

/**
 * How late a planned click may be and still be worth sounding: the committing
 * side of the two lateness policies this metronome runs.
 *
 * The planning side is `LATENESS_TOLERANCE_SECONDS` in `shared-transport.ts`,
 * an order of magnitude tighter at 4 ms. `plan()` will not emit an event that
 * is already further behind than that, so every event reaching this method
 * started out comfortably inside these limits. What makes them reachable is the
 * render clock advancing between the tick's scheduling snapshot and the moment
 * the click is committed. These limits govern that window only; they are not a
 * looser restatement of the transport's rule and must not be read as one.
 *
 * Two limits, because lateness has two costs and they bind on different grids.
 *
 * The absolute limit bounds how far a click may be displaced from where the
 * listener expects it: past roughly 50 ms a nudged click stops reading as the
 * beat and starts reading as a mistake.
 *
 * The relative limit protects the grid. A clamped click keeps its own start
 * time but its successor keeps the original grid time, so clamping always eats
 * into the gap that follows. Capping the pull at a quarter of a step leaves at
 * least three quarters of the grid spacing intact, which is a nudge; anything
 * more collapses toward the next click and is heard as a flam. 45 ms is
 * negligible on a 500 ms step at 120 bpm and nearly a whole step on the 50 ms
 * step of a 32nd-note grid, so the same absolute lateness has to be judged
 * differently on each.
 */
const MAX_CLICK_LATENESS_SECONDS = 0.05;
const MAX_CLICK_LATENESS_STEPS = 0.25;

/**
 * How each sound in the vocabulary is voiced. `durationSeconds` rather than
 * `length`, because it is a span of time and its siblings in `CLICK_ENVELOPE`
 * already say so; `length` on an object reads as a count of something.
 */
export const SOUND_PROFILES = lookup({
  [SOUND.HIGH]: Object.freeze({ frequency: 1240, type: "triangle", durationSeconds: 0.032 }),
  [SOUND.LOW]: Object.freeze({ frequency: 690, type: "triangle", durationSeconds: 0.042 }),
  [SOUND.WOOD]: Object.freeze({ frequency: 930, type: "sine", durationSeconds: 0.026 }),
});

export const CLICK_ENVELOPE = Object.freeze({
  peakGain: 0.92,
  silenceGain: 0.0001,
  attackSeconds: 0.0015,
  releaseSeconds: 0.002,
});

/**
 * The pitch of each audible Step voice, as a ratio against the selected sound
 * profile's frequency. Four semitones apart, so the three voices outline an
 * augmented triad and stay distinguishable on a small speaker without any of
 * them being quieter than the others.
 *
 * `off` is deliberately absent rather than present as a silent entry: a voice
 * this table cannot price is a voice the scheduler must not play, which makes
 * the lookup itself the audibility test.
 */
export const STEP_PITCH_RATIOS = lookup({
  [STEP.TERTIARY]: 2 ** (-8 / 12),
  [STEP.SECONDARY]: 2 ** (-4 / 12),
  [STEP.PRIMARY]: 1,
});

/**
 * Nodes come from the context's own factory methods rather than the global
 * constructors, so whatever context is handed in supplies the entire graph.
 * That is what lets an injected test double observe the voicing, and it costs
 * a real context nothing: the factory methods are the same nodes by another
 * name.
 */
export function scheduleClickVoice(context, output, { sound, voice, when }) {
  const pitchRatio = STEP_PITCH_RATIOS[voice];
  if (!pitchRatio) return null;

  const profile = SOUND_PROFILES[sound] || SOUND_PROFILES[SOUND.HIGH];
  const { peakGain, silenceGain, attackSeconds, releaseSeconds } = CLICK_ENVELOPE;
  const end = when + profile.durationSeconds;

  const oscillator = context.createOscillator();
  oscillator.type = profile.type;
  oscillator.frequency.value = profile.frequency * pitchRatio;
  const envelope = context.createGain();
  envelope.gain.value = silenceGain;

  oscillator.connect(envelope);
  envelope.connect(output);

  envelope.gain.setValueAtTime(silenceGain, when);
  envelope.gain.exponentialRampToValueAtTime(peakGain, when + attackSeconds);
  envelope.gain.exponentialRampToValueAtTime(silenceGain, end);

  oscillator.start(when);
  oscillator.stop(end + releaseSeconds);
  return oscillator;
}

export function createLayerOutput(context, destination, layer) {
  const gain = context.createGain();
  gain.gain.value = layer.muted ? 0 : layer.volume;
  const panner = context.createStereoPanner();
  panner.pan.value = layer.pan;
  gain.connect(panner);
  panner.connect(destination);
  return { gain, panner };
}

function createBrowserContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser does not support the Web Audio API.");
  }

  return new AudioContextClass({ latencyHint: "interactive" });
}

export class MetronomeEngine extends EventTarget {
  #createContext;
  #context = null;
  #master = null;
  #layers = new Map();
  #state = null;
  #playing = false;
  #transport = new SharedTransport();
  #timer = null;
  #anchored = false;
  #scheduledSources = new Set<AudioScheduledSourceNode>();
  #unstartedTicks = 0;
  #reportedStuckContext = false;
  #holdsAudioSession = false;
  #recovery = null;
  #recoveryAttemptedState = null;
  #softRecoveryContext = null;
  #replacement = null;
  #runGeneration = 0;

  /**
   * WebKit fires `statechange` on every transition. Losing `"running"` during
   * a transport run means a call, an app switch, or a screen lock took the
   * audio session away, so ask for it back. The transport origin is left
   * alone: `currentTime` freezes with the interruption, so the existing origin
   * stays in phase and re-anchoring would only risk replaying past events.
   * Scheduling stays parked until a tick observes `"running"` again.
   */
  #handleStateChange = (event) => {
    if (!this.#playing || event.currentTarget !== this.#context) return;
    if (this.#context.state !== this.#recoveryAttemptedState) {
      this.#recoveryAttemptedState = null;
    }
    if (this.#softRecoveryContext === this.#context) return;
    if (this.#anchored && this.#context.state === "closed") {
      if (globalThis.document?.visibilityState === "visible") {
        this.checkAudioAfterForeground();
      }
      return;
    }
    if (this.#anchored && this.#context.state === "suspended") {
      if (globalThis.document?.visibilityState === "visible") {
        this.#recoverSuspendedContext(this.#context);
      }
      return;
    }
    if (this.#anchored && this.#context.state === "interrupted") {
      return;
    }
    this.#requestResume();
  };

  #handleContextError = (event) => {
    if (!this.#playing || !this.#state || event.currentTarget !== this.#context) return;
    this.restartAudio(this.#state).catch((error) => {
      this.dispatchEvent(new CustomEvent("audioerror", { detail: error }));
    });
  };

  /**
   * `options.createContext` is an optional zero-argument factory returning an
   * AudioContext-like object. Without it the engine behaves exactly as before.
   */
  constructor(options: { createContext?: () => any } = {}) {
    super();
    this.#createContext =
      typeof options?.createContext === "function" ? options.createContext : createBrowserContext;
  }

  get playing() {
    return this.#playing;
  }

  get origin() {
    return this.#transport.origin;
  }

  get currentTime() {
    return this.#context?.currentTime ?? 0;
  }

  async start(state) {
    // Ahead of the context creation below, which can throw and is rethrown: a
    // start that fails there leaves the engine holding the state it was asked
    // to play rather than the previous run's.
    this.#state = state;
    // Before the context exists, so the very first one is created under the
    // session this run means to hold rather than the one it is replacing.
    this.#claimAudioSession();
    try {
      this.#ensureContext();
    } catch (error) {
      // A start that never got a context is not playback, and nothing
      // downstream will notice: callers report the rejection rather than
      // stopping an engine that never started. Left claimed, the page holds a
      // nonmixable session — silencing whatever else the device is playing —
      // for a metronome that is not running. Releasing swallows its own
      // failures, so it cannot displace the error the caller has to show.
      this.#releaseAudioSession();
      throw error;
    }

    this.#requestResume();

    // Clearing the previous run is not the end of playback, so the session it
    // was holding carries straight over into this one.
    this.stop({ preserveContext: true, emit: false, releaseAudioSession: false });
    this.#playing = true;
    this.#syncNodes();
    try {
      this.#tick();
    } catch (error) {
      this.stop({ preserveContext: true, emit: false });
      throw error;
    }
    this.#timer = window.setInterval(() => {
      try {
        this.#tick();
      } catch (error) {
        this.stop();
        this.dispatchEvent(new CustomEvent("audioerror", { detail: error }));
      }
    }, SCHEDULER_INTERVAL_MS);
    this.dispatchEvent(new Event("playstate"));
  }

  /**
   * `releaseAudioSession` is false only where `start()` clears the run it is
   * about to replace: the metronome is not falling silent there, so the session
   * must not be handed back and taken again for the sake of one statement.
   */
  stop({ preserveContext = true, emit = true, releaseAudioSession = true } = {}) {
    this.#runGeneration += 1;
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#playing = false;
    this.#anchored = false;
    this.#unstartedTicks = 0;
    this.#reportedStuckContext = false;
    this.#recoveryAttemptedState = null;
    this.#recovery = null;
    this.#softRecoveryContext = null;

    for (const source of this.#scheduledSources) {
      try {
        source.stop();
      } catch {
        // Already stopped sources are harmless.
      }
      try {
        source.disconnect();
      } catch {
        // A source the browser already detached is harmless.
      }
    }
    this.#scheduledSources.clear();

    if (this.#context && this.#master) {
      const now = this.#context.currentTime;
      this.#master.gain.cancelScheduledValues(now);
      this.#master.gain.setValueAtTime(0, now);
    }

    if (!preserveContext) {
      for (const nodes of this.#layers.values()) {
        nodes.gain.disconnect();
        nodes.panner.disconnect();
      }
      this.#layers.clear();
    }

    if (releaseAudioSession) this.#releaseAudioSession();

    if (emit) this.dispatchEvent(new Event("playstate"));
  }

  async toggle(state) {
    if (this.#playing) {
      this.stop();
      return;
    }
    await this.start(state);
  }

  async restart(state) {
    this.#state = state;
    if (!this.#playing) {
      this.#syncNodes();
      return;
    }
    await this.start(state);
  }

  /**
   * Abandons the current audio resource and begins a new Transport run on a
   * newly constructed context. Audio timestamps from separate contexts are
   * unrelated, so replacement must never carry the old Transport origin over.
   */
  restartAudio(state) {
    if (this.#replacement) return this.#replacement;

    const replacement = this.#replaceAudio(state).finally(() => {
      if (this.#replacement === replacement) this.#replacement = null;
    });
    this.#replacement = replacement;
    return replacement;
  }

  async #replaceAudio(state) {
    const context = this.#context;
    const master = this.#master;

    this.#recovery = null;
    this.#recoveryAttemptedState = null;
    this.#softRecoveryContext = null;

    this.stop({ preserveContext: false, emit: false, releaseAudioSession: false });
    context?.removeEventListener("statechange", this.#handleStateChange);
    context?.removeEventListener("error", this.#handleContextError);
    master?.disconnect();
    this.#context = null;
    this.#master = null;

    try {
      const pending = context?.close();
      pending?.catch(() => {
        // The failed resource is already detached; closing it is best effort.
      });
    } catch {
      // The failed resource is already detached; closing it is best effort.
    }

    try {
      await this.start(state);
    } catch (error) {
      this.dispatchEvent(new Event("playstate"));
      throw error;
    }
  }

  checkAudioAfterForeground() {
    const context = this.#context;
    const runGeneration = this.#runGeneration;
    if (!this.#playing || !this.#anchored || !context) {
      return;
    }

    if (context.state === "closed") {
      const recovery = Promise.resolve(
        this.#replaceAfterForegroundFailure(context, null, runGeneration),
      ).finally(() => {
        this.#finishRecovery(recovery, context, runGeneration);
      });
      this.#recovery = recovery;
      return;
    }

    if (this.#recovery) return;

    if (context.state === "suspended") {
      this.#recoverSuspendedContext(context);
      return;
    }

    if (context.state === "interrupted") {
      if (this.#recoveryAttemptedState === "interrupted") return;
      this.#recoveryAttemptedState = "interrupted";
      const recovery = this.#resumeByDeadline(context)
        .catch((recoveryError) => {
          if (context.state !== "interrupted") return null;
          return this.#replaceAfterForegroundFailure(context, recoveryError, runGeneration);
        })
        .finally(() => {
          this.#finishRecovery(recovery, context, runGeneration);
        });
      this.#recovery = recovery;
      return;
    }

    if (context.state !== "running") return;
    const sampledTime = context.currentTime;
    const recovery = new Promise((resolve) => {
      window.setTimeout(resolve, FOREGROUND_CLOCK_GRACE_MS);
    })
      .then(() => {
        if (
          !this.#playing ||
          runGeneration !== this.#runGeneration ||
          context !== this.#context ||
          context.state !== "running" ||
          context.currentTime !== sampledTime
        ) {
          return false;
        }

        const postGraceTime = context.currentTime;
        return new Promise((resolve) => {
          window.setTimeout(resolve, FOREGROUND_CLOCK_GRACE_MS);
        }).then(() => {
          if (
            !this.#playing ||
            runGeneration !== this.#runGeneration ||
            context !== this.#context ||
            context.state !== "running" ||
            context.currentTime !== postGraceTime
          ) {
            return false;
          }

          this.#softRecoveryContext = context;
          return this.#suspendByDeadline(context)
            .then(() => this.#resumeByDeadline(context))
            .then(() => true)
            .finally(() => {
              if (this.#softRecoveryContext === context) this.#softRecoveryContext = null;
            });
        });
      })
      .then((softRecovered) => {
        if (
          !softRecovered ||
          !this.#playing ||
          runGeneration !== this.#runGeneration ||
          context !== this.#context ||
          context.state !== "running"
        ) {
          return null;
        }

        const recoveredTime = context.currentTime;
        return new Promise((resolve) => {
          window.setTimeout(resolve, FOREGROUND_CLOCK_GRACE_MS);
        }).then(() => {
          if (
            !this.#playing ||
            runGeneration !== this.#runGeneration ||
            context !== this.#context ||
            context.state !== "running" ||
            context.currentTime !== recoveredTime
          ) {
            return null;
          }
          return this.#replaceAfterForegroundFailure(
            context,
            new Error("Audio clock is not advancing."),
            runGeneration,
          );
        });
      })
      .catch((recoveryError) => {
        return this.#replaceAfterForegroundFailure(context, recoveryError, runGeneration);
      })
      .finally(() => {
        this.#finishRecovery(recovery, context, runGeneration);
      });
    this.#recovery = recovery;
  }

  #replaceAfterForegroundFailure(context, recoveryError = null, runGeneration) {
    if (
      !this.#playing ||
      !this.#state ||
      context !== this.#context ||
      runGeneration !== this.#runGeneration
    ) {
      return null;
    }
    return this.restartAudio(this.#state).then(
      () => {
        if (recoveryError) {
          this.dispatchEvent(new CustomEvent("audioerror", { detail: recoveryError }));
        }
      },
      (replacementError) => {
        this.dispatchEvent(new CustomEvent("audioerror", { detail: replacementError }));
      },
    );
  }

  #finishRecovery(recovery, context, runGeneration) {
    if (this.#recovery !== recovery) return;
    this.#recovery = null;
    if (
      !this.#playing ||
      !this.#anchored ||
      context !== this.#context ||
      runGeneration !== this.#runGeneration
    ) {
      return;
    }
    if (context.state !== "running") this.checkAudioAfterForeground();
  }

  /**
   * Routes a Configuration edit's consequence to the narrowest method that
   * satisfies it, so that only a structural change interrupts the run. Returns
   * the restart promise on the one asynchronous path and null otherwise,
   * leaving the caller to report a failed restart.
   */
  applyConsequence(consequence, state) {
    if (consequence === "none") return null;
    if (consequence === "restart-transport-run" && this.playing) {
      return this.restart(state);
    }
    if (consequence === "update-step-voices") {
      this.updateStepVoices(state);
      return null;
    }
    if (consequence === "update-configuration") {
      this.updateConfiguration(state);
      return null;
    }
    this.updateMix(state);
    return null;
  }

  updateConfiguration(state) {
    this.#state = state;
  }

  updateMix(state) {
    this.#state = state;
    if (this.#context) this.#syncNodes();
  }

  updateStepVoices(state) {
    this.#state = state;
    if (this.#playing) this.#transport.updateStepVoices(state);
  }

  activeStep(layer) {
    if (!this.#playing || !this.#context || !this.#anchored) return null;
    return this.#transport.patternPosition(layer.id, this.#context.currentTime);
  }

  activePosition() {
    if (!this.#playing || !this.#context || !this.#anchored) return null;
    return this.#transport.position(this.#context.currentTime);
  }

  activeBpm() {
    if (!this.#playing || !this.#context || !this.#anchored) return null;
    return this.#transport.currentBpm(this.#context.currentTime);
  }

  /**
   * WebKit parks the promise returned by `resume()` and never settles it when
   * the context is not allowed to start, so awaiting it would deadlock the
   * start path and leave the scheduler uninstalled. Request it and move on.
   *
   * iOS also parks a context in `"interrupted"`, a WebKit state that predates
   * the specification, so every state other than running and closed is worth
   * a resume request.
   */
  #requestResume() {
    if (!this.#context) return;

    const state = this.#context.state;
    if (state === "running" || state === "closed") return;

    try {
      const pending = this.#context.resume();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          // A refused resume must not become an unhandled rejection.
        });
      }
    } catch {
      // Some contexts throw synchronously; the scheduler still runs.
    }
  }

  #recoverSuspendedContext(context) {
    if (this.#recovery || this.#recoveryAttemptedState === "suspended") return;
    this.#recoveryAttemptedState = "suspended";
    const runGeneration = this.#runGeneration;

    const recovery = this.#resumeByDeadline(context)
      .catch((recoveryError) => {
        if (context.state !== "suspended") return null;
        return this.#replaceAfterForegroundFailure(context, recoveryError, runGeneration);
      })
      .finally(() => {
        this.#finishRecovery(recovery, context, runGeneration);
      });
    this.#recovery = recovery;
  }

  #resumeByDeadline(context) {
    return this.#completeByDeadline(() => context.resume());
  }

  #suspendByDeadline(context) {
    return this.#completeByDeadline(() => context.suspend());
  }

  #completeByDeadline(operation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Audio recovery timed out."));
      }, RECOVERY_ATTEMPT_TIMEOUT_MS);
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(deadline);
        callback(value);
      };

      try {
        Promise.resolve(operation()).then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  /**
   * Takes the `playback` audio session for the duration of a run.
   *
   * Web Audio is mapped to the iOS `Ambient` session, which the hardware
   * Ring/Silent switch and the lock screen both silence, and `playback` is the
   * available mitigation: it lifts both, and waives the background-interruption
   * restriction as well. It is also nonmixable, and Apple is explicit that
   * activating a nonmixable session interrupts any other audio session that is
   * also nonmixable — for a metronome that most likely means the backing track
   * its user is playing along to. That is a real cost, so the claim is scoped
   * to the interval where the metronome has something to claim it for, and
   * `#releaseAudioSession` gives it straight back.
   *
   * The claim is idempotent so that restarting a run mid-flight does not put
   * the session down and pick it up again.
   */
  #claimAudioSession() {
    if (this.#holdsAudioSession) return;
    this.#holdsAudioSession = true;
    this.#setAudioSessionType("playback");
  }

  /**
   * Hands the session back. `auto` maps to no category override at all, which
   * returns the choice to WebKit's own heuristic — `Ambient` again for Web
   * Audio. Only a session this engine claimed is released: nothing else on the
   * page asked it to manage theirs.
   */
  #releaseAudioSession() {
    if (!this.#holdsAudioSession) return;
    this.#holdsAudioSession = false;
    this.#setAudioSessionType("auto");
  }

  /**
   * Safari 16.4+; absent everywhere else, and refused outright when a
   * Permissions Policy withholds it. Best effort in every direction: whatever
   * the session does, starting and stopping the metronome must still work.
   */
  #setAudioSessionType(type) {
    try {
      const audioSession = globalThis.navigator?.audioSession;
      if (audioSession) audioSession.type = type;
    } catch {
      // Best effort only: never let this break starting or stopping.
    }
  }

  #ensureContext() {
    if (this.#context) return;

    this.#context = this.#createContext();
    this.#context.addEventListener("statechange", this.#handleStateChange);
    this.#context.addEventListener("error", this.#handleContextError);
    this.#master = this.#context.createGain();
    this.#master.gain.value = MASTER_GAIN;
    this.#master.connect(this.#context.destination);
  }

  #syncNodes() {
    if (!this.#context || !this.#master || !this.#state) return;

    // MASTER_GAIN is fixed, so on a running graph this ramps the value to
    // itself and changes nothing. It is here for the one case that is not a
    // no-op: stop() zeroes this node to silence the graph, and a preserved
    // context hands the same node back on the next run still at zero.
    this.#master.gain.setTargetAtTime(MASTER_GAIN, this.#context.currentTime, 0.01);

    const rhythms = this.#state.sequence.cycles.flatMap((cycle) => cycle.rhythms);
    const currentIds = new Set(rhythms.map((layer) => layer.id));

    for (const [id, nodes] of this.#layers.entries()) {
      if (!currentIds.has(id)) {
        nodes.gain.disconnect();
        nodes.panner.disconnect();
        this.#layers.delete(id);
      }
    }

    for (const layer of rhythms) {
      let nodes = this.#layers.get(layer.id);
      if (!nodes) {
        nodes = createLayerOutput(this.#context, this.#master, layer);
        this.#layers.set(layer.id, nodes);
      }

      nodes.gain.gain.setTargetAtTime(
        layer.muted ? 0 : layer.volume,
        this.#context.currentTime,
        0.01,
      );
      nodes.panner.pan.setTargetAtTime(layer.pan, this.#context.currentTime, 0.01);
    }
  }

  /**
   * Counts a tick of a run whose context has never once been running, and says
   * so when the count reaches the threshold.
   *
   * A context that is never granted produces no sound and no exception: the
   * scheduler ticks on, `playing` keeps reporting true, and the silence is
   * indistinguishable to the user from a metronome that is simply broken. This
   * is the one place the engine can notice.
   *
   * Reporting deliberately changes nothing else. The run is left playing and
   * the scheduler installed, because the context may still be granted later —
   * a user who answers a call and comes back must still get their metronome,
   * and stopping here is what would take it away. Once per run is enough: the
   * condition is continuous, so repeating it every tick would be noise.
   */
  #countUnstartedTick() {
    if (this.#reportedStuckContext) return;
    this.#unstartedTicks += 1;
    if (this.#unstartedTicks < STUCK_CONTEXT_TICKS) return;

    this.#reportedStuckContext = true;
    this.dispatchEvent(
      new CustomEvent("audioerror", {
        detail: new Error("Audio has not started. Try tapping play again."),
      }),
    );
  }

  /**
   * One scheduler tick. `currentTime` is frozen at zero while a context is
   * suspended or interrupted and never catches up, so the transport origin is
   * anchored from the first tick at which the context is genuinely running.
   */
  #tick() {
    if (!this.#playing || !this.#context || !this.#state) return;
    if (this.#context.state !== "running") {
      // A run that has never sounded is reported rather than retried: it is
      // told to tap play again, and that tap is itself the activation a resume
      // needs. An established run parks scheduling here; statechange and
      // foreground lifecycle handling own its bounded recovery or replacement.
      if (!this.#anchored) this.#countUnstartedTick();
      return;
    }

    if (!this.#anchored) {
      this.#transport.start(this.#state, this.#context.currentTime + START_DELAY_SECONDS);
      this.#anchored = true;
    }

    this.#schedule();
  }

  #schedule() {
    if (!this.#playing || !this.#context || !this.#state) return;

    // Syncing the graph is the engine's own overhead and it costs render time,
    // which on a phone waking from an interruption is not a rounding error.
    // Reading the clock first would charge that cost to the events about to be
    // planned: they would be planned against a clock that had already moved on,
    // committed late through no fault of their own, and the stale horizon would
    // be written back as the transport's scheduling position, shortening the
    // look-ahead by the same amount. Sync first, then take the snapshot.
    this.#syncNodes();

    const now = this.#context.currentTime;
    const horizon = now + LOOK_AHEAD_SECONDS;

    const layersById = new Map(
      this.#state.sequence.cycles
        .flatMap((cycle) => cycle.rhythms)
        .map((layer) => [layer.id, layer]),
    );
    for (const event of this.#transport.plan(now, horizon)) {
      const layer = layersById.get(event.layerId);
      if (layer) {
        this.#scheduleClick(layer, event.voice, event.audioTime);
      }
    }
  }

  #scheduleClick(layer, voice, when) {
    const output = this.#layers.get(layer.id)?.gain;
    if (!output || !this.#context) return;

    // A sound profile is only a few tens of milliseconds long, so any drift
    // larger than that would put the stop time before the start time and the
    // click would produce no sound at all, silently. Pull a marginally late
    // click forward instead, carrying its stop time with it, and abandon a
    // hopelessly stale one deliberately rather than by accident. What counts as
    // marginal depends on this layer's own step, because the pull comes out of
    // the gap before the next click on that layer's grid.
    const now = this.#context.currentTime;
    const maxLateness = Math.min(
      MAX_CLICK_LATENESS_SECONDS,
      stepDurationSeconds(this.#transport.currentBpm(when) ?? this.#state.bpm, layer) *
        MAX_CLICK_LATENESS_STEPS,
    );
    if (when < now - maxLateness) return;

    const oscillator = scheduleClickVoice(this.#context, output, {
      sound: layer.sound,
      voice,
      when: Math.max(when, now),
    });
    if (!oscillator) return;

    this.#scheduledSources.add(oscillator);
    oscillator.addEventListener("ended", () => this.#scheduledSources.delete(oscillator), {
      once: true,
    });
  }
}
