import { MetronomeEngine } from "./metronome.js";
import {
  NOTE_UNITS,
  PRESET_NAMES,
  SOUNDS,
  STEP,
  createCycle,
  createDefaultState,
  createLayer,
  createPreset,
  nextStepState,
  normaliseNumber,
  normaliseState,
  panLabel,
  sequenceSummary,
} from "./model.js";

const STORAGE_KEY = "polynome-sequence";
const RETIRED_STORAGE_KEYS = [
  "polynome-meter",
  "polynome",
  "polynome:v1",
  "polyrhythm-metronome:v1",
];
const MAX_RHYTHMS = 12;

const elements = {
  play: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  playLabel: document.querySelector("#play-label"),
  bpm: document.querySelector("#bpm-input"),
  bpmSlider: document.querySelector("#bpm-slider"),
  bpmDown: document.querySelector("#bpm-down"),
  bpmUp: document.querySelector("#bpm-up"),
  masterVolume: document.querySelector("#master-volume"),
  presetList: document.querySelector("#preset-list"),
  summary: document.querySelector("#sequence-summary"),
  cycles: document.querySelector("#cycles"),
  addCycle: document.querySelector("#add-cycle"),
  status: document.querySelector("#status"),
};

const engine = new MetronomeEngine();
let state = loadState();
let activePreset = detectPreset(state);
let animationFrame = null;

function loadState() {
  try {
    for (const key of RETIRED_STORAGE_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normaliseState(JSON.parse(raw)) : createDefaultState();
  } catch {
    return createDefaultState();
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The app still works when storage is unavailable.
  }
}

function rhythmCount() {
  return state.cycles.reduce((total, cycle) => total + cycle.rhythms.length, 0);
}

function setState(nextState, options = {}) {
  state = normaliseState(nextState);
  activePreset = options.keepPreset ? activePreset : null;
  persistState();
  if (options.render !== false) render();

  if (options.restart && engine.playing) {
    engine.restart(state).catch(showError);
  } else {
    engine.updateMix(state);
  }
}

function render() {
  renderTransport();
  renderPresets();
  renderSequence();
}

function renderTransport() {
  elements.bpm.value = String(state.bpm);
  elements.bpmSlider.value = String(state.bpm);
  elements.masterVolume.value = String(state.masterVolume);
  updatePlayButton();
}

function renderPresets() {
  elements.presetList.innerHTML = PRESET_NAMES.map(
    (name) => `
      <button
        type="button"
        class="preset-button${activePreset === name ? " is-selected" : ""}"
        data-preset="${escapeHtml(name)}"
        aria-pressed="${activePreset === name}"
      >${escapeHtml(name)}</button>
    `,
  ).join("");
}

function renderSequence() {
  elements.summary.textContent = sequenceSummary(state);
  elements.cycles.innerHTML = state.cycles
    .map((cycle, index) => cycleTemplate(cycle, index))
    .join("");
  elements.addCycle.disabled = rhythmCount() >= MAX_RHYTHMS;
}

function cycleTemplate(cycle, cycleIndex) {
  const repetitionDots = Array.from(
    { length: cycle.repetitions },
    (_, index) => `<span class="repetition-dot" data-repetition-index="${index}"></span>`,
  ).join("");
  const rhythms = cycle.rhythms
    .map((rhythm, rhythmIndex) => layerTemplate(rhythm, cycle, rhythmIndex))
    .join("");

  return `
    <section class="cycle-card" data-cycle-id="${cycle.id}" aria-labelledby="cycle-${cycle.id}-heading">
      <div class="cycle-heading">
        <h3 id="cycle-${cycle.id}-heading">Cycle ${cycleIndex + 1}</h3>
        <label class="repeat-control">
          <span>Repeats</span>
          <input type="number" min="1" max="32" inputmode="numeric" value="${cycle.repetitions}" data-field="repetitions" />
        </label>
        <button
          type="button"
          class="icon-button remove-button"
          data-action="remove-cycle"
          aria-label="Remove Cycle ${cycleIndex + 1}"
          title="Remove cycle"
          ${state.cycles.length === 1 ? "disabled" : ""}
        >×</button>
      </div>
      <div class="repetition-list" aria-label="${cycle.repetitions} repetitions">${repetitionDots}</div>
      <div class="cycle-rhythms">${rhythms}</div>
      <button
        type="button"
        class="add-button add-rhythm"
        data-action="add-rhythm"
        ${rhythmCount() >= MAX_RHYTHMS ? "disabled" : ""}
      >+ Add rhythm</button>
    </section>
  `;
}

function rhythmLabel(layer) {
  return `${layer.signature.count}/${layer.signature.unit}`;
}

function layerTemplate(layer, cycle, rhythmIndex) {
  const label = rhythmLabel(layer);
  const stepButtons = layer.steps
    .map((step, stepIndex) => stepTemplate(step, stepIndex))
    .join("");
  const unitOptions = NOTE_UNITS.map(
    (unit) => `<option value="${unit}"${unit === layer.signature.unit ? " selected" : ""}>${unit}</option>`,
  ).join("");
  const soundOptions = SOUNDS.map((sound) => {
    const optionLabel = sound.charAt(0).toUpperCase() + sound.slice(1);
    return `<option value="${sound}"${sound === layer.sound ? " selected" : ""}>${optionLabel}</option>`;
  }).join("");

  return `
    <article class="layer-card${layer.muted ? " is-muted" : ""}" data-layer-id="${layer.id}">
      <div class="layer-heading">
        <span class="layer-number" aria-hidden="true">${rhythmIndex + 1}</span>
        <h4 class="layer-name">${label}</h4>
        <div class="layer-actions">
          <button
            type="button"
            class="icon-button${layer.muted ? " is-active" : ""}"
            data-action="mute"
            aria-pressed="${layer.muted}"
            aria-label="${layer.muted ? "Unmute" : "Mute"} ${label}"
            title="${layer.muted ? "Unmute" : "Mute"}"
          >M</button>
          <button
            type="button"
            class="icon-button remove-button"
            data-action="remove-rhythm"
            aria-label="Remove ${label}"
            title="Remove rhythm"
            ${cycle.rhythms.length === 1 ? "disabled" : ""}
          >×</button>
        </div>
      </div>

      <div class="layer-body">
        <div class="rhythm-setup">
          <label class="compact-control">
            <span>Signature</span>
            <span class="signature-input">
              <input type="number" min="1" max="32" inputmode="numeric" value="${layer.signature.count}" data-field="signature-count" aria-label="Meter numerator" />
              <span aria-hidden="true">/</span>
              <select data-field="signature-unit" aria-label="Meter denominator">${unitOptions}</select>
            </span>
          </label>
          <label class="compact-control">
            <span>Subdivision</span>
            <select class="subdivision-select" data-field="subdivision" aria-label="${label} subdivision per signature unit">
              ${subdivisionOptions(layer.signature.unit, layer.subdivision)}
            </select>
          </label>
        </div>

        <div class="pattern-wrap">
          <div class="pattern" role="group" aria-label="${label} pattern">${stepButtons}</div>
        </div>

        <div class="mix-grid">
          <label class="mix-control sound-control">
            <span>Sound</span>
            <select data-field="sound">${soundOptions}</select>
          </label>
          <label class="mix-control">
            <span class="mix-label"><span>Level</span><output data-output="volume">${Math.round(layer.volume * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.01" value="${layer.volume}" data-field="volume" aria-label="${label} level" />
          </label>
          <label class="mix-control pan-control">
            <span class="mix-label"><span>Ear balance</span><output data-output="pan">${panLabel(layer.pan)}</output></span>
            <span class="pan-slider">
              <span aria-hidden="true">L</span>
              <input type="range" min="-1" max="1" step="0.01" value="${layer.pan}" data-field="pan" aria-label="${label} left and right balance" />
              <span aria-hidden="true">R</span>
            </span>
          </label>
        </div>
      </div>
    </article>
  `;
}

function subdivisionOptions(unit, selected) {
  const unitNames = {
    1: "whole note",
    2: "half note",
    4: "quarter note",
    8: "eighth note",
    16: "sixteenth note",
    32: "thirty-second note",
  };
  const unitName = unitNames[unit] || "signature unit";
  return [1, 2, 3, 4, 5].map((subdivision) => {
    const pulseLabel = subdivision === 1 ? "pulse" : "pulses";
    const qualifier = subdivision === 3
      ? " (triplet)"
      : subdivision === 5 ? " (quintuplet)" : "";
    return `<option value="${subdivision}"${subdivision === selected ? " selected" : ""}>${subdivision} ${pulseLabel} per ${unitName}${qualifier}</option>`;
  }).join("");
}

function stepTemplate(step, stepIndex) {
  const labels = { [STEP.ACCENT]: "Accent", [STEP.HIT]: "Hit", [STEP.REST]: "Rest" };
  const symbols = { [STEP.ACCENT]: "●", [STEP.HIT]: "•", [STEP.REST]: "–" };
  return `
    <button type="button" class="step step-${step}" data-action="step" data-step-index="${stepIndex}" aria-label="Step ${stepIndex + 1}: ${labels[step]}" title="Step ${stepIndex + 1}: ${labels[step]}">
      <span aria-hidden="true">${symbols[step]}</span>
    </button>
  `;
}

function updatePlayButton() {
  const playing = engine.playing;
  elements.play.classList.toggle("is-playing", playing);
  elements.play.setAttribute("aria-pressed", String(playing));
  elements.playIcon.textContent = playing ? "■" : "▶";
  elements.playLabel.textContent = playing ? "Stop" : "Play";
  elements.status.textContent = playing ? "Playing" : "Stopped";
}

function updateActiveSteps() {
  if (!engine.playing) {
    elements.cycles.querySelectorAll(".is-current").forEach((element) => {
      element.classList.remove("is-current");
    });
    animationFrame = null;
    return;
  }

  const position = engine.activePosition();
  for (const cycle of state.cycles) {
    const cycleElement = elements.cycles.querySelector(`[data-cycle-id="${CSS.escape(cycle.id)}"]`);
    if (!cycleElement) continue;
    cycleElement.querySelectorAll(".repetition-dot").forEach((element, index) => {
      element.classList.toggle(
        "is-current",
        cycle.id === position?.cycleId && index === position.repetitionIndex,
      );
    });
    for (const rhythm of cycle.rhythms) {
      const activeIndex = engine.activeStep(rhythm);
      const card = cycleElement.querySelector(`[data-layer-id="${CSS.escape(rhythm.id)}"]`);
      if (!card) continue;
      card.querySelectorAll(".step").forEach((element, index) => {
        element.classList.toggle("is-current", index === activeIndex);
      });
    }
  }
  animationFrame = requestAnimationFrame(updateActiveSteps);
}

function startAnimation() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(updateActiveSteps);
}

function showError(error) {
  console.error(error);
  elements.status.textContent = error?.message || "Audio could not start";
  elements.status.classList.add("is-error");
  window.setTimeout(() => elements.status.classList.remove("is-error"), 4000);
}

async function togglePlayback() {
  try {
    await engine.toggle(state);
  } catch (error) {
    showError(error);
  }
}

function changeTempo(nextBpm) {
  const bpm = Math.round(normaliseNumber(nextBpm, state.bpm, 30, 300));
  setState({ ...state, bpm }, { restart: true });
}

function updateCycle(cycleId, updater, options = {}) {
  const cycles = state.cycles.map((cycle) => cycle.id === cycleId ? updater(cycle) : cycle);
  setState({ ...state, cycles }, options);
}

function updateRhythm(cycleId, rhythmId, updater, options = {}) {
  updateCycle(cycleId, (cycle) => ({
    ...cycle,
    rhythms: cycle.rhythms.map((rhythm) => rhythm.id === rhythmId ? updater(rhythm) : rhythm),
  }), options);
}

function findContext(target) {
  const cycleElement = target.closest("[data-cycle-id]");
  if (!cycleElement) return null;
  const cycle = state.cycles.find((candidate) => candidate.id === cycleElement.dataset.cycleId);
  if (!cycle) return null;
  const layerElement = target.closest("[data-layer-id]");
  const rhythm = layerElement
    ? cycle.rhythms.find((candidate) => candidate.id === layerElement.dataset.layerId)
    : null;
  return { cycleElement, layerElement, cycle, rhythm };
}

elements.play.addEventListener("click", togglePlayback);
elements.bpmDown.addEventListener("click", () => changeTempo(state.bpm - 1));
elements.bpmUp.addEventListener("click", () => changeTempo(state.bpm + 1));
elements.bpm.addEventListener("change", (event) => changeTempo(event.target.value));
elements.bpmSlider.addEventListener("input", (event) => {
  const bpm = Math.round(normaliseNumber(event.target.value, state.bpm, 30, 300));
  state = { ...state, bpm };
  elements.bpm.value = String(bpm);
  activePreset = null;
  persistState();
});
elements.bpmSlider.addEventListener("change", () => {
  renderPresets();
  if (engine.playing) engine.restart(state).catch(showError);
});
elements.masterVolume.addEventListener("input", (event) => {
  state = {
    ...state,
    masterVolume: normaliseNumber(event.target.value, state.masterVolume, 0, 1),
  };
  persistState();
  engine.updateMix(state);
});
elements.presetList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  activePreset = button.dataset.preset;
  state = normaliseState(createPreset(activePreset));
  persistState();
  render();
  if (engine.playing) engine.restart(state).catch(showError);
});
elements.addCycle.addEventListener("click", () => {
  if (rhythmCount() >= MAX_RHYTHMS) return;
  setState({
    ...state,
    cycles: [...state.cycles, createCycle({ rhythms: [createLayer()] })],
  }, { restart: true });
});

elements.cycles.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;
  const context = findContext(actionElement);
  if (!context) return;
  const { cycle, rhythm } = context;

  switch (actionElement.dataset.action) {
    case "add-rhythm":
      if (rhythmCount() >= MAX_RHYTHMS) return;
      updateCycle(cycle.id, (current) => ({
        ...current,
        rhythms: [...current.rhythms, createLayer()],
      }), { restart: true });
      break;
    case "remove-cycle":
      if (state.cycles.length <= 1) return;
      setState({
        ...state,
        cycles: state.cycles.filter((candidate) => candidate.id !== cycle.id),
      }, { restart: true });
      break;
    case "remove-rhythm":
      if (!rhythm || cycle.rhythms.length <= 1) return;
      updateCycle(cycle.id, (current) => ({
        ...current,
        rhythms: current.rhythms.filter((candidate) => candidate.id !== rhythm.id),
      }), { restart: true });
      break;
    case "mute":
      if (!rhythm) return;
      updateRhythm(cycle.id, rhythm.id, (current) => ({ ...current, muted: !current.muted }));
      break;
    case "step": {
      if (!rhythm) return;
      const stepIndex = Number(actionElement.dataset.stepIndex);
      updateRhythm(cycle.id, rhythm.id, (current) => ({
        ...current,
        steps: current.steps.map((step, index) => index === stepIndex ? nextStepState(step) : step),
      }), { restart: true });
      break;
    }
  }
});

elements.cycles.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field || !["volume", "pan"].includes(field)) return;
  const context = findContext(event.target);
  if (!context?.rhythm) return;
  const { layerElement, cycle, rhythm } = context;

  if (field === "volume") {
    const volume = normaliseNumber(event.target.value, rhythm.volume, 0, 1);
    rhythm.volume = volume;
    layerElement.querySelector('[data-output="volume"]').textContent = `${Math.round(volume * 100)}%`;
  } else {
    const pan = normaliseNumber(event.target.value, rhythm.pan, -1, 1);
    rhythm.pan = pan;
    layerElement.querySelector('[data-output="pan"]').textContent = panLabel(pan);
  }
  activePreset = null;
  persistState();
  engine.updateMix(state);
});

elements.cycles.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  if (!field || ["volume", "pan"].includes(field)) return;
  const context = findContext(event.target);
  if (!context) return;
  const { cycle, rhythm } = context;

  if (field === "repetitions") {
    updateCycle(cycle.id, (current) => ({
      ...current,
      repetitions: Math.round(normaliseNumber(event.target.value, current.repetitions, 1, 32)),
    }), { restart: true });
    return;
  }
  if (!rhythm) return;

  switch (field) {
    case "signature-count":
      updateRhythm(cycle.id, rhythm.id, (current) => ({
        ...current,
        signature: {
          ...current.signature,
          count: Math.round(normaliseNumber(event.target.value, current.signature.count, 1, 32)),
        },
      }), { restart: true });
      break;
    case "signature-unit":
      updateRhythm(cycle.id, rhythm.id, (current) => ({
        ...current,
        signature: { ...current.signature, unit: Number(event.target.value) },
      }), { restart: true });
      break;
    case "subdivision":
      updateRhythm(cycle.id, rhythm.id, (current) => ({
        ...current,
        subdivision: Number(event.target.value),
      }), { restart: true });
      break;
    case "sound":
      updateRhythm(cycle.id, rhythm.id, (current) => ({
        ...current,
        sound: event.target.value,
      }));
      break;
  }
});

engine.addEventListener("playstate", () => {
  updatePlayButton();
  if (engine.playing) startAnimation();
});
engine.addEventListener("audioerror", (event) => showError(event.detail));
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
  event.preventDefault();
  togglePlayback();
});
window.addEventListener("pagehide", () => engine.stop());

function detectPreset(candidateState) {
  for (const name of PRESET_NAMES) {
    if (sameMusicalState(candidateState, normaliseState(createPreset(name)))) return name;
  }
  return null;
}

function sameMusicalState(left, right) {
  if (left.bpm !== right.bpm || left.cycles.length !== right.cycles.length) return false;
  return left.cycles.every((cycle, cycleIndex) => {
    const comparisonCycle = right.cycles[cycleIndex];
    if (
      cycle.repetitions !== comparisonCycle.repetitions
      || cycle.rhythms.length !== comparisonCycle.rhythms.length
    ) return false;
    return cycle.rhythms.every((rhythm, rhythmIndex) => {
      const comparison = comparisonCycle.rhythms[rhythmIndex];
      return (
        rhythm.signature.count === comparison.signature.count
        && rhythm.signature.unit === comparison.signature.unit
        && rhythm.subdivision === comparison.subdivision
        && rhythm.steps.join(",") === comparison.steps.join(",")
        && Math.abs(rhythm.pan - comparison.pan) < 0.001
        && rhythm.sound === comparison.sound
      );
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

render();
