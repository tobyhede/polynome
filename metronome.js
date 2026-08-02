import { SharedTransport } from "./shared-transport.js";

const LOOK_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.06;

const SOUND_PROFILES = Object.freeze({
  high: { frequency: 1240, type: "triangle", length: 0.032 },
  low: { frequency: 690, type: "triangle", length: 0.042 },
  wood: { frequency: 930, type: "sine", length: 0.026 },
});

export function scheduleClickVoice(context, output, sound, level, when) {
  if (!(level > 0)) return null;

  const profile = SOUND_PROFILES[sound] || SOUND_PROFILES.high;
  const peak = 0.92 * level;
  const end = when + profile.length;

  const oscillator = new OscillatorNode(context, {
    type: profile.type,
    frequency: profile.frequency,
  });
  const envelope = new GainNode(context, { gain: 0.0001 });

  oscillator.connect(envelope);
  envelope.connect(output);

  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.exponentialRampToValueAtTime(peak, when + 0.0015);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.start(when);
  oscillator.stop(end + 0.002);
  return oscillator;
}

export function createLayerOutput(context, destination, layer) {
  const gain = new GainNode(context, {
    gain: layer.muted ? 0 : layer.volume,
  });
  const panner = new StereoPannerNode(context, { pan: layer.pan });
  gain.connect(panner);
  panner.connect(destination);
  return { gain, panner };
}

export class MetronomeEngine extends EventTarget {
  #context = null;
  #master = null;
  #layers = new Map();
  #state = null;
  #playing = false;
  #transport = new SharedTransport();
  #timer = null;
  #scheduledSources = new Set();

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

    if (this.#context.state === "suspended") {
      await this.#context.resume();
    }

    this.stop({ preserveContext: true, emit: false });
    this.#state = state;
    this.#playing = true;
    this.#transport.start(
      state,
      this.#context.currentTime + START_DELAY_SECONDS,
    );
    this.#syncNodes();
    try {
      this.#schedule();
    } catch (error) {
      this.stop({ preserveContext: true, emit: false });
      throw error;
    }
    this.#timer = window.setInterval(
      () => {
        try {
          this.#schedule();
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
    if (!this.#playing || !this.#context) return null;
    return this.#transport.patternPosition(layer.id, this.#context.currentTime);
  }

  activePosition() {
    if (!this.#playing || !this.#context) return null;
    return this.#transport.position(this.#context.currentTime);
  }

  #ensureContext() {
    if (this.#context) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("This browser does not support the Web Audio API.");
    }

    this.#context = new AudioContextClass({ latencyHint: "interactive" });
    this.#master = new GainNode(this.#context, { gain: 0.8 });
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

    const oscillator = scheduleClickVoice(
      this.#context,
      output,
      layer.sound,
      level,
      when,
    );
    if (!oscillator) return;

    this.#scheduledSources.add(oscillator);
    oscillator.addEventListener(
      "ended",
      () => this.#scheduledSources.delete(oscillator),
      { once: true },
    );
  }
}
