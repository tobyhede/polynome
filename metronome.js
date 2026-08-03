import { stepDurationSeconds } from "./model.js";
import { SharedTransport } from "./shared-transport.js";

const LOOK_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.06;

/**
 * How long a run may report `playing` while its context has never once been
 * running before the engine says so out loud.
 *
 * Long enough that an ordinary start — a context that takes a few hundred
 * milliseconds to be granted — never trips it, and short enough that a user
 * staring at a silent metronome is told why before deciding the app is broken.
 */
const STUCK_CONTEXT_TIMEOUT_MS = 2000;
const STUCK_CONTEXT_TICKS = Math.ceil(
  STUCK_CONTEXT_TIMEOUT_MS / SCHEDULER_INTERVAL_MS,
);

/**
 * How often a run that has lost `running` asks for its context back.
 *
 * The `statechange` handler asks once on the way out of `running`, but a
 * refused `resume()` fires no `statechange` at all, so that one request is also
 * the last one the handler will ever make. The gate it was refused on is
 * transient user activation, which the page can regain at any moment from a tap
 * that has nothing to do with the metronome — and no event tells the engine
 * that it has. Asking again on a slow cadence is the only way to take that
 * chance up.
 *
 * A second a part is far longer than a user notices against an interruption
 * they are already living through, and rare enough that a permanently refused
 * context costs one parked promise a second rather than one per tick.
 *
 * Deliberately not guarded by a "resume already pending" flag. WebKit parks the
 * promise and settles it neither way for exactly the refusals this retry exists
 * to survive, so such a flag would latch on the first refusal and disable every
 * later attempt — the failure it was added to prevent.
 */
const RESUME_RETRY_TIMEOUT_MS = 1000;
const RESUME_RETRY_TICKS = Math.ceil(
  RESUME_RETRY_TIMEOUT_MS / SCHEDULER_INTERVAL_MS,
);

/**
 * How late a planned click may be and still be worth sounding: the committing
 * side of the two lateness policies this metronome runs.
 *
 * The planning side is `LATENESS_TOLERANCE_SECONDS` in `shared-transport.js`,
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

export const SOUND_PROFILES = Object.freeze({
  high: Object.freeze({ frequency: 1240, type: "triangle", length: 0.032 }),
  low: Object.freeze({ frequency: 690, type: "triangle", length: 0.042 }),
  wood: Object.freeze({ frequency: 930, type: "sine", length: 0.026 }),
});

export const CLICK_ENVELOPE = Object.freeze({
  peakGain: 0.92,
  silenceGain: 0.0001,
  attackSeconds: 0.0015,
  releaseSeconds: 0.002,
});

/**
 * Nodes come from the context's own factory methods rather than the global
 * constructors, so whatever context is handed in supplies the entire graph.
 * That is what lets an injected test double observe the voicing, and it costs
 * a real context nothing: the factory methods are the same nodes by another
 * name.
 */
export function scheduleClickVoice(context, output, { sound, level, when }) {
  if (!(level > 0)) return null;

  const profile = SOUND_PROFILES[sound] || SOUND_PROFILES.high;
  const { peakGain, silenceGain, attackSeconds, releaseSeconds } = CLICK_ENVELOPE;
  const peak = peakGain * level;
  const end = when + profile.length;

  const oscillator = context.createOscillator();
  oscillator.type = profile.type;
  oscillator.frequency.value = profile.frequency;
  const envelope = context.createGain();
  envelope.gain.value = silenceGain;

  oscillator.connect(envelope);
  envelope.connect(output);

  envelope.gain.setValueAtTime(silenceGain, when);
  envelope.gain.exponentialRampToValueAtTime(peak, when + attackSeconds);
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
  #scheduledSources = new Set();
  #unstartedTicks = 0;
  #reportedStuckContext = false;
  #ticksSinceResumeRequest = 0;
  #holdsAudioSession = false;

  /**
   * WebKit fires `statechange` on every transition. Losing `"running"` during
   * a transport run means a call, an app switch, or a screen lock took the
   * audio session away, so ask for it back. The transport origin is left
   * alone: `currentTime` freezes with the interruption, so the existing origin
   * stays in phase and re-anchoring would only risk replaying past events.
   * Scheduling stays parked until a tick observes `"running"` again.
   */
  #handleStateChange = () => {
    if (!this.#playing) return;
    this.#requestResume();
  };

  /**
   * `options.createContext` is an optional zero-argument factory returning an
   * AudioContext-like object. Without it the engine behaves exactly as before.
   */
  constructor(options = {}) {
    super();
    this.#createContext = typeof options?.createContext === "function"
      ? options.createContext
      : createBrowserContext;
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
    this.#state = state;
    this.#playing = true;
    this.#syncNodes();
    try {
      this.#tick();
    } catch (error) {
      this.stop({ preserveContext: true, emit: false });
      throw error;
    }
    this.#timer = window.setInterval(
      () => {
        try {
          this.#tick();
        } catch (error) {
          this.stop();
          this.dispatchEvent(
            new CustomEvent("audioerror", { detail: error }),
          );
        }
      },
      SCHEDULER_INTERVAL_MS,
    );
    this.dispatchEvent(new Event("playstate"));
  }

  /**
   * `releaseAudioSession` is false only where `start()` clears the run it is
   * about to replace: the metronome is not falling silent there, so the session
   * must not be handed back and taken again for the sake of one statement.
   */
  stop({ preserveContext = true, emit = true, releaseAudioSession = true } = {}) {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#playing = false;
    this.#anchored = false;
    this.#unstartedTicks = 0;
    this.#reportedStuckContext = false;
    this.#ticksSinceResumeRequest = 0;

    for (const source of this.#scheduledSources) {
      try {
        source.stop();
      } catch {
        // Already stopped sources are harmless.
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
    if (consequence === "update-step-levels") {
      this.updateStepLevels(state);
      return null;
    }
    this.updateMix(state);
    return null;
  }

  updateMix(state) {
    this.#state = state;
    if (this.#context) this.#syncNodes();
  }

  updateStepLevels(state) {
    this.#state = state;
    if (this.#playing) this.#transport.updateStepLevels(state);
  }

  activeStep(layer) {
    if (!this.#playing || !this.#context || !this.#anchored) return null;
    return this.#transport.patternPosition(layer.id, this.#context.currentTime);
  }

  activePosition() {
    if (!this.#playing || !this.#context || !this.#anchored) return null;
    return this.#transport.position(this.#context.currentTime);
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
    this.#master = this.#context.createGain();
    this.#master.gain.value = 0.8;
    this.#master.connect(this.#context.destination);
  }

  #syncNodes() {
    if (!this.#context || !this.#master || !this.#state) return;

    this.#master.gain.setTargetAtTime(
      this.#state.masterVolume,
      this.#context.currentTime,
      0.01,
    );

    const rhythms = this.#state.sequence.cycles
      .flatMap((cycle) => cycle.rhythms);
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
      nodes.panner.pan.setTargetAtTime(
        layer.pan,
        this.#context.currentTime,
        0.01,
      );
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
    this.dispatchEvent(new CustomEvent("audioerror", {
      detail: new Error("Audio has not started. Try tapping play again."),
    }));
  }

  /**
   * Asks for an interrupted run's context back, no more than once every
   * `RESUME_RETRY_TICKS`. The counter is reset by any tick that observes
   * `running` and by `stop()`, so a recovered run starts the next interruption
   * with a full interval rather than part-way through one.
   */
  #retryResume() {
    this.#ticksSinceResumeRequest += 1;
    if (this.#ticksSinceResumeRequest < RESUME_RETRY_TICKS) return;

    this.#ticksSinceResumeRequest = 0;
    this.#requestResume();
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
      // needs. A run that was sounding is told nothing, so asking again is the
      // only way back.
      if (this.#anchored) this.#retryResume();
      else this.#countUnstartedTick();
      return;
    }

    this.#ticksSinceResumeRequest = 0;

    if (!this.#anchored) {
      this.#transport.start(
        this.#state,
        this.#context.currentTime + START_DELAY_SECONDS,
      );
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
        this.#scheduleClick(layer, event.level, event.audioTime);
      }
    }
  }

  #scheduleClick(layer, level, when) {
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
      stepDurationSeconds(this.#state.bpm, layer) * MAX_CLICK_LATENESS_STEPS,
    );
    if (when < now - maxLateness) return;

    const oscillator = scheduleClickVoice(this.#context, output, {
      sound: layer.sound,
      level,
      when: Math.max(when, now),
    });
    if (!oscillator) return;

    this.#scheduledSources.add(oscillator);
    oscillator.addEventListener(
      "ended",
      () => this.#scheduledSources.delete(oscillator),
      { once: true },
    );
  }
}
