import { stepDurationSeconds } from "./model.js";
import { SharedTransport } from "./shared-transport.js";

const LOOK_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.06;

/**
 * How late a planned click may be and still be worth sounding. Two limits,
 * because lateness has two costs and they bind on different grids.
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
    this.#ensureContext();

    this.#requestResume();

    this.stop({ preserveContext: true, emit: false });
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

  stop({ preserveContext = true, emit = true } = {}) {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#playing = false;
    this.#anchored = false;

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
   * Web Audio is mapped to the iOS `Ambient` audio session, which the hardware
   * Ring/Silent switch and the lock screen both silence. Asking for the
   * `playback` type is the only available mitigation, and it also waives the
   * background-interruption restriction. Safari 16.4+; a no-op everywhere else,
   * and silently ignored when the Permissions Policy withholds it.
   */
  #requestPlaybackAudioSession() {
    try {
      const audioSession = globalThis.navigator?.audioSession;
      if (audioSession) audioSession.type = "playback";
    } catch {
      // Best effort only: never let this break starting the metronome.
    }
  }

  #ensureContext() {
    if (this.#context) return;

    this.#requestPlaybackAudioSession();
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
   * One scheduler tick. `currentTime` is frozen at zero while a context is
   * suspended or interrupted and never catches up, so the transport origin is
   * anchored from the first tick at which the context is genuinely running.
   */
  #tick() {
    if (!this.#playing || !this.#context || !this.#state) return;
    if (this.#context.state !== "running") return;

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

    const now = this.#context.currentTime;
    const horizon = now + LOOK_AHEAD_SECONDS;

    this.#syncNodes();

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
