import { MetronomeEngine } from "./metronome.js";
import {
  NOTE_UNITS,
  PRESET_NAMES,
  SOUNDS,
  STEP,
  SUBDIVISIONS,
  createDefaultState,
  createLayer,
  createPreset,
  nextStepState,
  normaliseNumber,
  normaliseState,
  panLabel,
  resizePattern,
} from "./model.js";

const STORAGE_KEY = "polynome:v1";
const LEGACY_STORAGE_KEY = "polyrhythm-metronome:v1";

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
  layers: document.querySelector("#layers"),
  addLayer: document.querySelector("#add-layer"),
  status: document.querySelector("#status"),
};

const engine = new MetronomeEngine();
let state = loadState();
let activePreset = detectPreset(state);
let animationFrame = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
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
  renderLayers();
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

function renderLayers() {
  elements.layers.innerHTML = state.layers
    .map((layer, index) => layerTemplate(layer, index))
    .join("");
}

function layerTemplate(layer, index) {
  const stepButtons = layer.steps
    .map((step, stepIndex) => stepTemplate(layer, step, stepIndex))
    .join("");

  const unitOptions = NOTE_UNITS.map(
    (unit) =>
      `<option value="${unit}"${unit === layer.signature.unit ? " selected" : ""}>${unit}</option>`,
  ).join("");

  const soundOptions = SOUNDS.map((sound) => {
    const label = sound.charAt(0).toUpperCase() + sound.slice(1);
    return `<option value="${sound}"${sound === layer.sound ? " selected" : ""}>${label}</option>`;
  }).join("");

  const hasStandardSubdivision = SUBDIVISIONS.some(
    (subdivision) => subdivision.value === layer.steps.length,
  );
  const subdivisionChoices = [
    ...(hasStandardSubdivision
      ? []
      : [{
          value: layer.steps.length,
          label: `Custom (${layer.steps.length})`,
        }]),
    ...SUBDIVISIONS,
  ];
  const currentSubdivision = subdivisionChoices.find(
    ({ value }) => value === layer.steps.length,
  );
  const subdivisionOptions = subdivisionChoices.map(
    ({ value, label }) => `
      <button
        type="button"
        class="subdivision-option"
        role="option"
        aria-label="${escapeHtml(label)} subdivision"
        aria-selected="${value === layer.steps.length}"
        data-action="set-subdivision"
        data-subdivision="${value}"
      >${subdivisionIcon(value)}</button>
    `,
  ).join("");

  return `
    <article class="layer-card${layer.muted ? " is-muted" : ""}" data-layer-id="${layer.id}">
      <div class="layer-heading">
        <span class="layer-number" aria-hidden="true">${index + 1}</span>
        <input
          class="layer-name"
          type="text"
          maxlength="28"
          value="${escapeHtml(layer.name)}"
          aria-label="Rhythm name"
          data-field="name"
        />
        <div class="layer-actions">
          <button
            type="button"
            class="icon-button${layer.muted ? " is-active" : ""}"
            data-action="mute"
            aria-pressed="${layer.muted}"
            aria-label="${layer.muted ? "Unmute" : "Mute"} ${escapeHtml(layer.name)}"
            title="${layer.muted ? "Unmute" : "Mute"}"
          >${layer.muted ? "M" : "M"}</button>
          <button
            type="button"
            class="icon-button remove-button"
            data-action="remove"
            aria-label="Remove ${escapeHtml(layer.name)}"
            title="Remove rhythm"
            ${state.layers.length === 1 ? "disabled" : ""}
          >×</button>
        </div>
      </div>

      <div class="layer-body">
        <div class="rhythm-setup">
          <label class="compact-control">
            <span>Signature</span>
            <span class="signature-input">
              <input
                type="number"
                min="1"
                max="32"
                inputmode="numeric"
                value="${layer.signature.count}"
                data-field="signature-count"
                aria-label="Cycle numerator"
              />
              <span aria-hidden="true">/</span>
              <select data-field="signature-unit" aria-label="Cycle denominator">
                ${unitOptions}
              </select>
            </span>
          </label>

          <div class="compact-control">
            <span>Subdivision</span>
            <div class="subdivision-picker" data-subdivision-picker>
              <button
                type="button"
                class="subdivision-trigger"
                data-action="toggle-subdivision"
                aria-haspopup="listbox"
                aria-expanded="false"
                aria-label="${escapeHtml(layer.name)} subdivision: ${escapeHtml(currentSubdivision.label)}"
              >
                ${subdivisionIcon(layer.steps.length)}
                <span class="select-chevron" aria-hidden="true"></span>
              </button>
              <div
                class="subdivision-menu"
                role="listbox"
                aria-label="${escapeHtml(layer.name)} subdivision"
                hidden
              >${subdivisionOptions}</div>
            </div>
          </div>
        </div>

        <div class="pattern-wrap">
          <div class="pattern" role="group" aria-label="${escapeHtml(layer.name)} pattern">
            ${stepButtons}
          </div>
        </div>

        <div class="mix-grid">
          <label class="mix-control sound-control">
            <span>Sound</span>
            <select data-field="sound">${soundOptions}</select>
          </label>

          <label class="mix-control">
            <span class="mix-label"><span>Level</span><output data-output="volume">${Math.round(layer.volume * 100)}%</output></span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value="${layer.volume}"
              data-field="volume"
              aria-label="${escapeHtml(layer.name)} level"
            />
          </label>

          <label class="mix-control pan-control">
            <span class="mix-label"><span>Ear balance</span><output data-output="pan">${panLabel(layer.pan)}</output></span>
            <span class="pan-slider">
              <span aria-hidden="true">L</span>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value="${layer.pan}"
                data-field="pan"
                aria-label="${escapeHtml(layer.name)} left and right balance"
              />
              <span aria-hidden="true">R</span>
            </span>
          </label>
        </div>
      </div>
    </article>
  `;
}

function stepTemplate(layer, step, stepIndex) {
  const labels = {
    [STEP.ACCENT]: "Accent",
    [STEP.HIT]: "Hit",
    [STEP.REST]: "Rest",
  };
  const symbols = {
    [STEP.ACCENT]: "●",
    [STEP.HIT]: "•",
    [STEP.REST]: "–",
  };

  return `
    <button
      type="button"
      class="step step-${step}"
      data-action="step"
      data-step-index="${stepIndex}"
      aria-label="Step ${stepIndex + 1}: ${labels[step]}"
      title="Step ${stepIndex + 1}: ${labels[step]}"
    ><span aria-hidden="true">${symbols[step]}</span></button>
  `;
}

function subdivisionIcon(value) {
  const count = Math.max(1, Math.min(7, Number(value) || 1));
  const isWhole = count === 1;
  const isHalf = count === 2;
  const isTriplet = count === 3;
  const spacing = count === 1 ? 0 : Math.min(25, 90 / (count - 1));
  const start = 60 - (spacing * (count - 1)) / 2;
  const notes = Array.from({ length: count }, (_, index) => {
    const x = start + spacing * index;
    const head = `<ellipse cx="${x}" cy="27" rx="6.5" ry="4.8" transform="rotate(-18 ${x} 27)" />`;
    if (isWhole) return head;
    return `${head}<path d="M ${x + 6} 26 V 9" />`;
  }).join("");

  return `
    <svg class="note-pattern${isWhole || isHalf ? " is-open" : ""}" viewBox="0 0 120 38" aria-hidden="true" focusable="false">
      ${isTriplet ? '<path class="triplet-bracket" d="M 34 7 V 4 H 86 V 7" /><text x="60" y="8">3</text>' : ""}
      <g>${notes}</g>
    </svg>
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
    document.querySelectorAll(".step.is-current").forEach((element) => {
      element.classList.remove("is-current");
    });
    animationFrame = null;
    return;
  }

  for (const layer of state.layers) {
    const activeIndex = engine.activeStep(layer);
    const card = elements.layers.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`);
    if (!card) continue;

    card.querySelectorAll(".step").forEach((element, index) => {
      element.classList.toggle("is-current", index === activeIndex);
    });
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

function updateLayer(layerId, updater, options = {}) {
  const layers = state.layers.map((layer) =>
    layer.id === layerId ? updater(layer) : layer,
  );
  setState({ ...state, layers }, options);
}

function findLayerContext(target) {
  const card = target.closest("[data-layer-id]");
  if (!card) return null;
  const layer = state.layers.find((candidate) => candidate.id === card.dataset.layerId);
  return layer ? { card, layer } : null;
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
  const masterVolume = normaliseNumber(event.target.value, state.masterVolume, 0, 1);
  state = { ...state, masterVolume };
  persistState();
  engine.updateMix(state);
});

elements.presetList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  const presetName = button.dataset.preset;
  activePreset = presetName;
  state = normaliseState(createPreset(presetName));
  persistState();
  render();
  if (engine.playing) engine.restart(state).catch(showError);
});

elements.addLayer.addEventListener("click", () => {
  const index = state.layers.length;
  const pan = index % 2 === 0 ? -0.5 : 0.5;
  const layer = createLayer({
    name: `Rhythm ${index + 1}`,
    signature: { count: 4, unit: 4 },
    subdivision: 4,
    pan,
    sound: index % 2 === 0 ? "high" : "low",
  });
  setState(
    { ...state, layers: [...state.layers, layer] },
    { restart: true },
  );
});

elements.layers.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;

  const context = findLayerContext(actionElement);
  if (!context) return;
  const { layer } = context;

  switch (actionElement.dataset.action) {
    case "toggle-subdivision": {
      const picker = actionElement.closest("[data-subdivision-picker]");
      const menu = picker.querySelector(".subdivision-menu");
      const willOpen = menu.hidden;
      closeSubdivisionPickers(picker);
      menu.hidden = !willOpen;
      actionElement.setAttribute("aria-expanded", String(willOpen));
      break;
    }

    case "set-subdivision":
      updateLayer(
        layer.id,
        (current) => ({
          ...current,
          steps: resizePattern(current.steps, actionElement.dataset.subdivision),
        }),
        { restart: true },
      );
      break;

    case "step": {
      const stepIndex = Number(actionElement.dataset.stepIndex);
      updateLayer(
        layer.id,
        (current) => ({
          ...current,
          steps: current.steps.map((step, index) =>
            index === stepIndex ? nextStepState(step) : step,
          ),
        }),
        { restart: true },
      );
      break;
    }

    case "mute":
      updateLayer(
        layer.id,
        (current) => ({ ...current, muted: !current.muted }),
        { mixOnly: true },
      );
      break;

    case "remove":
      if (state.layers.length <= 1) return;
      setState(
        {
          ...state,
          layers: state.layers.filter((candidate) => candidate.id !== layer.id),
        },
        { restart: true },
      );
      break;
  }
});

elements.layers.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field) return;

  const context = findLayerContext(event.target);
  if (!context) return;
  const { card, layer } = context;

  if (field === "name") {
    layer.name = event.target.value;
    activePreset = null;
    persistState();
    return;
  }

  if (field === "volume") {
    const volume = normaliseNumber(event.target.value, layer.volume, 0, 1);
    layer.volume = volume;
    card.querySelector('[data-output="volume"]').textContent = `${Math.round(volume * 100)}%`;
    activePreset = null;
    persistState();
    engine.updateMix(state);
    return;
  }

  if (field === "pan") {
    const pan = normaliseNumber(event.target.value, layer.pan, -1, 1);
    layer.pan = pan;
    card.querySelector('[data-output="pan"]').textContent = panLabel(pan);
    activePreset = null;
    persistState();
    engine.updateMix(state);
  }
});

elements.layers.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  if (!field || ["name", "volume", "pan"].includes(field)) return;

  const context = findLayerContext(event.target);
  if (!context) return;
  const { layer } = context;

  switch (field) {
    case "signature-count":
      updateLayer(
        layer.id,
        (current) => ({
          ...current,
          signature: {
            ...current.signature,
            count: Math.round(
              normaliseNumber(event.target.value, current.signature.count, 1, 32),
            ),
          },
        }),
        { restart: true },
      );
      break;

    case "signature-unit":
      updateLayer(
        layer.id,
        (current) => ({
          ...current,
          signature: {
            ...current.signature,
            unit: Number(event.target.value),
          },
        }),
        { restart: true },
      );
      break;

    case "sound":
      updateLayer(
        layer.id,
        (current) => ({ ...current, sound: event.target.value }),
        { restart: false },
      );
      break;
  }
});

engine.addEventListener("playstate", () => {
  updatePlayButton();
  if (engine.playing) startAnimation();
});

document.addEventListener("keydown", (event) => {
  if (event.code === "Escape") {
    const openPicker = document.activeElement?.closest?.("[data-subdivision-picker]");
    closeSubdivisionPickers();
    openPicker?.querySelector(".subdivision-trigger")?.focus();
    return;
  }
  if (event.code !== "Space" || event.repeat) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
  event.preventDefault();
  togglePlayback();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-subdivision-picker]")) closeSubdivisionPickers();
});

function closeSubdivisionPickers(except = null) {
  document.querySelectorAll("[data-subdivision-picker]").forEach((picker) => {
    if (picker === except) return;
    picker.querySelector(".subdivision-menu").hidden = true;
    picker.querySelector(".subdivision-trigger").setAttribute("aria-expanded", "false");
  });
}

window.addEventListener("pagehide", () => engine.stop());

function detectPreset(candidateState) {
  for (const name of PRESET_NAMES) {
    const preset = normaliseState(createPreset(name));
    if (sameMusicalState(candidateState, preset)) return name;
  }
  return null;
}

function sameMusicalState(left, right) {
  if (left.bpm !== right.bpm || left.layers.length !== right.layers.length) return false;
  return left.layers.every((layer, index) => {
    const comparison = right.layers[index];
    return (
      layer.name === comparison.name &&
      layer.signature.count === comparison.signature.count &&
      layer.signature.unit === comparison.signature.unit &&
      layer.steps.join(",") === comparison.steps.join(",") &&
      Math.abs(layer.pan - comparison.pan) < 0.001 &&
      layer.sound === comparison.sound
    );
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
