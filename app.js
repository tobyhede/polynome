import { MetronomeEngine } from "./metronome.js";
import {
  changeConfiguration,
  createConfiguration,
  describeConfiguration,
} from "./configuration.js";
import { panLabel } from "./model.js";

const STORAGE_KEY = "polynome-redesign";
const RETIRED_STORAGE_KEYS = [
  "polynome-sequence",
  "polynome-meter",
  "polynome",
  "polynome:v1",
  "polyrhythm-metronome:v1",
];

const elements = {
  play: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  bpm: document.querySelector("#bpm-input"),
  bpmSlider: document.querySelector("#bpm-slider"),
  bpmReadout: document.querySelector("#bpm-readout"),
  bpmTicks: document.querySelector("#bpm-ticks"),
  bpmMarks: document.querySelector("#bpm-marks"),
  masterVolume: document.querySelector("#master-volume"),
  presetsToggle: document.querySelector("#presets-toggle"),
  presetPanel: document.querySelector("#preset-panel"),
  presetList: document.querySelector("#preset-list"),
  presetCount: document.querySelector("#preset-count"),
  helpToggle: document.querySelector("#help-toggle"),
  helpPanel: document.querySelector("#help-panel"),
  cycles: document.querySelector("#cycles"),
  addCycle: document.querySelector("#add-cycle"),
  status: document.querySelector("#status"),
};

const engine = new MetronomeEngine();
const openRhythms = new Set();
let state = loadState();
let description = describeConfiguration(state);
const {
  meterUnits: NOTE_UNITS,
  presetNames: PRESET_NAMES,
  repetitions: REPETITIONS,
  sounds: SOUNDS,
  subdivisions: SUBDIVISIONS,
} = description.choices;
let presetsOpen = false;
let helpOpen = false;
let openSubdivisionMenu = null;
let animationFrame = null;
let tempoBeforePreview = null;

function loadState() {
  try {
    for (const key of RETIRED_STORAGE_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem(STORAGE_KEY);
    return createConfiguration(raw ? JSON.parse(raw) : undefined);
  } catch {
    return createConfiguration();
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The metronome remains usable when storage is unavailable.
  }
}

function applyEdit(edit, options = {}) {
  const result = changeConfiguration(state, edit);
  state = result.configuration;
  description = describeConfiguration(state);
  persistState();
  if (options.render !== false) render();

  if (options.deferConsequence || result.consequence === "none") return result;
  if (result.consequence === "restart-transport-run" && engine.playing) {
    engine.restart(state).catch(showError);
  } else if (result.consequence === "update-step-levels") {
    engine.updateStepLevels(state);
  } else {
    engine.updateMix(state);
  }
  return result;
}

function render() {
  renderPanels();
  renderTransport();
  renderPresets();
  renderCycles();
}

function renderPanels() {
  elements.presetPanel.hidden = !presetsOpen;
  elements.presetsToggle.setAttribute("aria-expanded", String(presetsOpen));
  elements.presetsToggle.classList.toggle("is-active", presetsOpen);
  elements.helpPanel.hidden = !helpOpen;
  elements.helpToggle.setAttribute("aria-expanded", String(helpOpen));
  elements.helpToggle.classList.toggle("is-active", helpOpen);
}

function renderTransport() {
  elements.bpm.value = String(state.bpm);
  elements.bpmSlider.value = String(state.bpm);
  elements.masterVolume.value = String(state.masterVolume);
  const progress = (state.bpm - 30) / 270;
  const size = 2.1 + progress * 2.1;
  const pixelSize = size * 16;
  const glitchIntensity = Math.min(1, Math.max(0, (state.bpm - 250) / 50));
  elements.bpmReadout.style.setProperty("--bpm-left", `calc(${progress * 100}% + ${(0.5 - progress) * 22}px)`);
  elements.bpmReadout.style.setProperty("--bpm-size", `${size}rem`);
  elements.bpmReadout.style.setProperty("--bpm-width", `${size * 16 * 0.86 * 3}px`);
  elements.bpmReadout.style.setProperty("--bpm-label-margin", `${6.5 - pixelSize * 0.255}px`);
  elements.bpm.classList.toggle("is-glitching", glitchIntensity > 0);
  if (glitchIntensity > 0) {
    elements.bpm.style.setProperty("--g", (0.35 + glitchIntensity * 0.65).toFixed(2));
    elements.bpm.style.setProperty("--glitch-duration", `${(1.5 - glitchIntensity * 1.1).toFixed(2)}s`);
  } else {
    elements.bpm.style.removeProperty("--g");
    elements.bpm.style.removeProperty("--glitch-duration");
  }
  elements.bpmTicks.querySelectorAll("span").forEach((tick) => {
    tick.classList.toggle("is-passed", Number(tick.dataset.bpm) <= state.bpm);
  });
  updatePlayButton();
}

function renderPresets() {
  const count = PRESET_NAMES.length;
  elements.presetCount.textContent = String(count);
  elements.presetCount.setAttribute("aria-label", `${count} ${count === 1 ? "preset" : "presets"}`);
  elements.presetList.innerHTML = PRESET_NAMES.map((name) => `
    <button
      type="button"
      class="preset-button${description.selectedPreset === name ? " is-selected" : ""}"
      data-preset="${escapeHtml(name)}"
      aria-pressed="${description.selectedPreset === name}"
    >${escapeHtml(name)}</button>
  `).join("");
}

function renderCycles() {
  const focusKey = focusSelector(document.activeElement);
  elements.cycles.innerHTML = state.sequence.cycles
    .map((cycle, index) => cycleTemplate(cycle, index))
    .join("");
  elements.addCycle.disabled = !description.availability.addCycle.available;
  if (focusKey) elements.cycles.querySelector(focusKey)?.focus();
}

/**
 * Rebuilding the cycles markup discards the focused control, which drops focus
 * to the document body and leaves Space toggling playback instead of the
 * control the user was operating. Describe the focused control by the data
 * attributes the templates already emit so it can be found again afterwards.
 */
function focusSelector(element) {
  if (!element || !elements.cycles.contains(element)) return null;
  const cycleId = element.closest("[data-cycle-id]")?.dataset.cycleId;
  if (!cycleId) return null;
  const rhythmId = element.closest("[data-layer-id]")?.dataset.layerId;
  const scope = rhythmId
    ? `[data-layer-id="${CSS.escape(rhythmId)}"]`
    : `[data-cycle-id="${CSS.escape(cycleId)}"]`;
  const { action, field } = element.dataset;
  if (field) return `${scope} [data-field="${field}"]`;
  if (!action) return null;

  switch (action) {
    case "step":
      return `${scope} [data-step-index="${element.dataset.stepIndex}"]`;
    case "set-repetitions":
      return `${scope} [data-repetitions="${element.dataset.repetitions}"]`;
    case "set-subdivision":
      return `${scope} [data-subdivision="${element.dataset.subdivision}"]`;
    case "sound":
      return `${scope} [data-sound="${CSS.escape(element.dataset.sound)}"]`;
    case "toggle-settings":
      // Two controls in a rhythm card share this action.
      return `${scope} ${element.classList.contains("edit-button") ? ".edit-button" : ".rhythm-identity"}`;
    default:
      return `${scope} [data-action="${action}"]`;
  }
}

function cycleTemplate(cycle, cycleIndex) {
  const cycleAvailability = description.availability.cycles[cycle.id];
  const cycleTitle = state.sequence.cycles.length > 1 ? `Cycle ${cycleIndex + 1}` : "Cycle";
  const removeDisabled = !cycleAvailability.remove.available;
  const dots = REPETITIONS.slice(1).map((value, index) => {
    const selected = value <= cycle.repetitions;
    const nextRepetitions = cycle.repetitions === value ? value - 1 : value;
    const unavailable = !cycleAvailability.repetitions[nextRepetitions].available;
    const actionLabel = unavailable
      ? `${cycleTitle} must remain active at 1 repetition`
      : nextRepetitions === 0
        ? `Disable ${cycleTitle}`
        : `Set ${cycleTitle} to ${nextRepetitions} ${nextRepetitions === 1 ? "repetition" : "repetitions"}`;
    return `
      <button
        type="button"
        class="repeat-dot${selected ? " is-set" : ""}"
        data-action="set-repetitions"
        data-repetitions="${value}"
        data-repetition-index="${index}"
        aria-label="${actionLabel}"
        aria-pressed="${selected}"
        ${unavailable ? "disabled" : ""}
      ></button>
    `;
  }).join("");

  return `
    <section class="cycle-group${cycle.repetitions === 0 ? " is-inactive" : ""}" data-cycle-id="${cycle.id}" aria-labelledby="cycle-${cycle.id}-heading">
      <article class="cycle-card" ${state.sequence.cycles.length === 1 ? "hidden" : ""}>
        <div class="card-heading cycle-heading">
          <h2 id="cycle-${cycle.id}-heading">${cycleTitle}<span class="cycle-divider" aria-hidden="true">/</span><span>${cycle.repetitions}</span></h2>
          <button
            type="button"
            class="icon-button remove-button"
            data-action="remove-cycle"
            aria-label="Remove ${cycleTitle}"
            ${removeDisabled ? "disabled" : ""}
          >×</button>
        </div>
        <div class="repeat-dots" role="group" aria-label="${cycleTitle} repetitions">${dots}</div>
      </article>

      <div class="rhythm-list">
        ${cycle.rhythms.map((rhythm) => rhythmTemplate(rhythm, cycle)).join("")}
      </div>
      <button
        type="button"
        class="chip-button add-rhythm"
        data-action="add-rhythm"
        ${!cycleAvailability.addRhythm.available ? "disabled" : ""}
      >+ Rhythm</button>
    </section>
  `;
}

function rhythmTemplate(rhythm, cycle) {
  const label = rhythmLabel(rhythm);
  const drawerId = `rhythm-${rhythm.id}-settings`;
  const open = openRhythms.has(rhythm.id);
  return `
    <article class="rhythm-card${rhythm.muted ? " is-muted" : ""}" data-layer-id="${rhythm.id}">
      <div class="card-heading rhythm-heading">
        <button
          type="button"
          class="rhythm-identity"
          data-action="toggle-settings"
          aria-expanded="${open}"
          aria-controls="${drawerId}"
        >
          <strong>${label}</strong><span aria-hidden="true">/</span>${noteIcon(rhythm.subdivision, 21)}
          <span class="sr-only">Edit ${label} rhythm</span>
        </button>
        <div class="rhythm-actions">
          <button type="button" class="icon-button${rhythm.muted ? " is-active" : ""}" data-action="mute" aria-pressed="${rhythm.muted}" aria-label="${rhythm.muted ? "Unmute" : "Mute"} ${label}">M</button>
          <button type="button" class="icon-button edit-button${open ? " is-active" : ""}" data-action="toggle-settings" aria-expanded="${open}" aria-controls="${drawerId}" aria-label="Edit ${label}">${pencilIcon()}</button>
          <button type="button" class="icon-button remove-button" data-action="remove-rhythm" aria-label="Remove ${label}" ${!description.availability.cycles[cycle.id].rhythms[rhythm.id].remove.available ? "disabled" : ""}>×</button>
        </div>
      </div>

      <div class="steps" role="group" aria-label="${label} step levels">
        ${rhythm.steps.map((step, index) => stepTemplate(step, index)).join("")}
      </div>

      <div id="${drawerId}" class="rhythm-settings" ${open ? "" : "hidden"}>
        ${rhythmSettingsTemplate(rhythm)}
      </div>
    </article>
  `;
}

function rhythmSettingsTemplate(rhythm) {
  const label = rhythmLabel(rhythm);
  const unitOptions = NOTE_UNITS.map((unit) => (
    `<option value="${unit}"${unit === rhythm.signature.unit ? " selected" : ""}>${unit}</option>`
  )).join("");
  const subdivisionMenuId = `rhythm-${rhythm.id}-subdivision-menu`;
  const subdivisionOpen = openSubdivisionMenu === rhythm.id;
  return `
    <div class="timing-settings">
      <label class="control-label">
        <span>Signature</span>
        <span class="signature-input">
          <input type="number" min="1" max="32" inputmode="numeric" value="${rhythm.signature.count}" data-field="signature-count" aria-label="${label} meter numerator" />
          <span aria-hidden="true">/</span>
          <select data-field="signature-unit" aria-label="${label} meter denominator">${unitOptions}</select>
        </span>
      </label>

      <div class="control-label subdivision-control">
        <span>Subdivision</span>
        <div class="notation-picker">
          <button
            type="button"
            class="notation-select"
            data-action="toggle-subdivision-menu"
            aria-label="${label} subdivision"
            aria-haspopup="listbox"
            aria-expanded="${subdivisionOpen}"
            aria-controls="${subdivisionMenuId}"
          >
            <span>${noteIcon(rhythm.subdivision, 27)}</span>
            <span aria-hidden="true">▼</span>
          </button>
          <div id="${subdivisionMenuId}" class="subdivision-menu" role="listbox" aria-label="${label} subdivision" ${subdivisionOpen ? "" : "hidden"}>
            ${SUBDIVISIONS.map((subdivision) => `
              <button
                type="button"
                role="option"
                class="subdivision-option${subdivision === rhythm.subdivision ? " is-selected" : ""}"
                data-action="set-subdivision"
                data-subdivision="${subdivision}"
                aria-selected="${subdivision === rhythm.subdivision}"
                aria-label="${subdivisionLabel(subdivision, rhythm.signature.unit)}"
                title="${subdivisionLabel(subdivision, rhythm.signature.unit)}"
              >${noteIcon(subdivision, 26)}</button>
            `).join("")}
          </div>
        </div>
      </div>

      <div class="sound-control" role="group" aria-labelledby="rhythm-${rhythm.id}-sound-label">
        <span id="rhythm-${rhythm.id}-sound-label">Sound</span>
        <div>${SOUNDS.map((sound) => `
          <button type="button" data-action="sound" data-sound="${sound}" class="sound-button${rhythm.sound === sound ? " is-selected" : ""}" aria-pressed="${rhythm.sound === sound}">${sound}</button>
        `).join("")}</div>
      </div>
    </div>

    <div class="mix-settings">
      <label class="control-label">
        <span>Level <output class="sr-only" data-output="volume">${Math.round(rhythm.volume * 100)}%</output></span>
        <input type="range" min="0" max="1" step="0.01" value="${rhythm.volume}" data-field="volume" aria-label="${label} level" />
      </label>
      <label class="control-label">
        <span>Balance <span class="balance-axis" aria-hidden="true">L · R</span><output class="sr-only" data-output="pan">${panLabel(rhythm.pan)}</output></span>
        <input type="range" min="-1" max="1" step="0.01" value="${rhythm.pan}" data-field="pan" aria-label="${label} stereo balance" />
      </label>
    </div>
  `;
}

function stepTemplate(step, index) {
  return `
    <button
      type="button"
      class="step step-${step}"
      data-action="step"
      data-step-index="${index}"
      aria-label="Step ${index + 1}: ${step} level"
      title="Step ${index + 1}: ${step}"
    ></button>
  `;
}

function noteIcon(subdivision, height) {
  const shown = subdivision <= 6 ? subdivision : 4;
  const beams = subdivision <= 1 ? 0 : subdivision <= 3 ? 1 : subdivision <= 6 ? 2 : subdivision <= 12 ? 3 : 4;
  const gap = shown > 4 ? 10 : 12;
  const headY = 31;
  const stemTop = 10;
  const x0 = 38 - ((shown - 1) * gap) / 2;
  const heads = Array.from({ length: shown }, (_, index) => {
    const x = x0 + index * gap;
    return `<ellipse cx="${x}" cy="${headY}" rx="5" ry="3.7" transform="rotate(-22 ${x} ${headY})"></ellipse><rect x="${x + 3.7}" y="${stemTop}" width="1.7" height="${headY - stemTop}" rx="0.6"></rect>`;
  }).join("");
  const beamLeft = x0 + 3.7;
  const beamRight = x0 + (shown - 1) * gap + 5.4;
  const beamShapes = Array.from({ length: beams }, (_, index) => (
    `<rect x="${beamLeft}" y="${stemTop + index * 5}" width="${beamRight - beamLeft}" height="3.2" rx="1"></rect>`
  )).join("");
  const tuplet = ![1, 2, 4, 8, 16, 32].includes(subdivision);
  const tupletLeft = x0 - 2;
  const tupletRight = x0 + (shown - 1) * gap + 8;
  const arm = (tupletRight - tupletLeft) / 2 - 7;
  const tupletShapes = tuplet
    ? `<rect x="${tupletLeft}" y="2.6" width="${arm}" height="1.5" rx="0.7"></rect><rect x="${tupletRight - arm}" y="2.6" width="${arm}" height="1.5" rx="0.7"></rect><text x="${(tupletLeft + tupletRight) / 2}" y="7" text-anchor="middle" font-size="9.5" font-weight="700" font-family="JetBrains Mono, monospace">${subdivision}</text>`
    : "";
  const left = Math.min(x0 - 5.6, tuplet ? x0 - 2.6 : Infinity);
  const right = Math.max(x0 + (shown - 1) * gap + 5.7, tuplet ? x0 + (shown - 1) * gap + 8.4 : -Infinity);
  const top = tuplet ? 0 : 8.5;
  const boxWidth = right - left;
  const boxHeight = 35.5 - top;
  return `<svg class="note-icon" viewBox="${left} ${top} ${boxWidth} ${boxHeight}" width="${boxWidth * (height / boxHeight)}" height="${height}" fill="currentColor" aria-hidden="true" focusable="false">${heads}${beamShapes}${tupletShapes}</svg>`;
}

function pencilIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"></path><path d="M14.5 6.5 17.5 9.5"></path></svg>`;
}

function subdivisionLabel(subdivision, unit) {
  const names = { 1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "sixteenth", 32: "thirty-second" };
  const hints = { 1: "straight", 2: "duple", 3: "triplet", 4: "even four", 5: "quintuplet" };
  return `${subdivision} per ${names[unit] || "signature"} unit · ${hints[subdivision]}`;
}

function rhythmLabel(rhythm) {
  return `${rhythm.signature.count}/${rhythm.signature.unit}`;
}

function updatePlayButton() {
  const playing = engine.playing;
  elements.play.classList.toggle("is-playing", playing);
  elements.play.setAttribute("aria-pressed", String(playing));
  elements.play.setAttribute("aria-label", playing ? "Stop metronome" : "Play metronome");
  elements.playIcon.textContent = playing ? "■" : "▶";
  elements.status.textContent = playing ? "Playing" : "Stopped";
}

function updateActiveSteps() {
  if (!engine.playing) {
    elements.cycles.querySelectorAll(".is-current").forEach((element) => element.classList.remove("is-current"));
    animationFrame = null;
    return;
  }

  const position = engine.activePosition();
  for (const cycle of state.sequence.cycles) {
    const cycleElement = elements.cycles.querySelector(`[data-cycle-id="${CSS.escape(cycle.id)}"]`);
    if (!cycleElement) continue;
    const active = cycle.id === position?.cycleId;
    cycleElement.querySelector(".cycle-card")?.classList.toggle("is-current", active);
    cycleElement.querySelectorAll(".repeat-dot").forEach((element, index) => {
      element.classList.toggle("is-current", active && index === position.repetitionIndex);
    });
    for (const rhythm of cycle.rhythms) {
      const card = cycleElement.querySelector(`[data-layer-id="${CSS.escape(rhythm.id)}"]`);
      if (!card) continue;
      const activeIndex = engine.activeStep(rhythm);
      card.classList.toggle("is-current", active);
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
}

async function togglePlayback() {
  try {
    await engine.toggle(state);
  } catch (error) {
    showError(error);
  }
}

function changeTempo(nextBpm) {
  applyEdit({ type: "set-tempo", bpm: nextBpm });
}

function findContext(target) {
  const cycleElement = target.closest("[data-cycle-id]");
  if (!cycleElement) return null;
  const cycle = state.sequence.cycles.find((candidate) => candidate.id === cycleElement.dataset.cycleId);
  if (!cycle) return null;
  const rhythmElement = target.closest("[data-layer-id]");
  const rhythm = rhythmElement
    ? cycle.rhythms.find((candidate) => candidate.id === rhythmElement.dataset.layerId)
    : null;
  return { cycleElement, rhythmElement, cycle, rhythm };
}

function toggleRhythmSettings(rhythmId, activatingToggle = null) {
  const toggleSelector = activatingToggle?.classList.contains("edit-button")
    ? ".edit-button"
    : activatingToggle ? ".rhythm-identity" : null;
  if (openRhythms.has(rhythmId)) openRhythms.delete(rhythmId);
  else openRhythms.add(rhythmId);
  renderCycles();
  if (toggleSelector) {
    const rhythmCard = elements.cycles.querySelector(
      `[data-layer-id="${CSS.escape(rhythmId)}"]`,
    );
    rhythmCard?.querySelector(toggleSelector)?.focus();
  }
}

elements.play.addEventListener("click", togglePlayback);
elements.presetsToggle.addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  if (presetsOpen) helpOpen = false;
  renderPanels();
});
elements.helpToggle.addEventListener("click", () => {
  helpOpen = !helpOpen;
  if (helpOpen) presetsOpen = false;
  renderPanels();
});
elements.bpm.addEventListener("change", (event) => changeTempo(event.target.value));
elements.bpmSlider.addEventListener("input", (event) => {
  if (tempoBeforePreview === null) tempoBeforePreview = state.bpm;
  applyEdit(
    { type: "set-tempo", bpm: event.target.value },
    { deferConsequence: true, render: false },
  );
  renderTransport();
  renderPresets();
});
elements.bpmSlider.addEventListener("change", () => {
  if (
    engine.playing
    && tempoBeforePreview !== null
    && state.bpm !== tempoBeforePreview
  ) {
    engine.restart(state).catch(showError);
  }
  tempoBeforePreview = null;
});
elements.masterVolume.addEventListener("input", (event) => {
  applyEdit(
    { type: "set-master-volume", masterVolume: event.target.value },
    { render: false },
  );
  renderPresets();
});
elements.presetList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  applyEdit({ type: "apply-preset", name: button.dataset.preset });
});
elements.addCycle.addEventListener("click", () => {
  applyEdit({ type: "add-cycle" });
});

elements.cycles.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;
  const context = findContext(actionElement);
  if (!context) return;
  const { cycle, rhythm } = context;

  switch (actionElement.dataset.action) {
    case "set-repetitions": {
      const value = Number(actionElement.dataset.repetitions);
      const repetitions = cycle.repetitions === value ? value - 1 : value;
      applyEdit({ type: "set-cycle-repetitions", cycleId: cycle.id, repetitions });
      break;
    }
    case "remove-cycle":
      applyEdit({ type: "remove-cycle", cycleId: cycle.id });
      // The removed control cannot be refocused, so fall back to a stable neighbour.
      elements.addCycle.focus();
      break;
    case "add-rhythm":
      applyEdit({ type: "add-rhythm", cycleId: cycle.id });
      break;
    case "remove-rhythm": {
      if (!rhythm) return;
      const result = applyEdit({
        type: "remove-rhythm",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
      });
      if (result.reason !== null) return;
      openRhythms.delete(rhythm.id);
      if (openSubdivisionMenu === rhythm.id) openSubdivisionMenu = null;
      // The removed control cannot be refocused, so fall back to a stable neighbour.
      elements.cycles
        .querySelector(`[data-cycle-id="${CSS.escape(cycle.id)}"] .add-rhythm`)
        ?.focus();
      break;
    }
    case "toggle-settings":
      if (rhythm) toggleRhythmSettings(rhythm.id, actionElement);
      break;
    case "toggle-subdivision-menu":
      if (!rhythm) return;
      openSubdivisionMenu = openSubdivisionMenu === rhythm.id ? null : rhythm.id;
      renderCycles();
      if (openSubdivisionMenu === rhythm.id) {
        requestAnimationFrame(() => {
          elements.cycles.querySelector(`[data-layer-id="${CSS.escape(rhythm.id)}"] .subdivision-option[aria-selected="true"]`)?.focus();
        });
      }
      break;
    case "set-subdivision":
      if (!rhythm) return;
      openSubdivisionMenu = null;
      applyEdit({
        type: "set-subdivision",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        subdivision: Number(actionElement.dataset.subdivision),
      });
      requestAnimationFrame(() => {
        elements.cycles.querySelector(`[data-layer-id="${CSS.escape(rhythm.id)}"] .notation-select`)?.focus();
      });
      break;
    case "mute":
      if (rhythm) applyEdit({
        type: "set-muted",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        muted: !rhythm.muted,
      });
      break;
    case "step": {
      if (!rhythm) return;
      const index = Number(actionElement.dataset.stepIndex);
      applyEdit({
        type: "advance-step-level",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        position: index,
      });
      break;
    }
    case "sound":
      if (rhythm) applyEdit({
        type: "set-sound",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        sound: actionElement.dataset.sound,
      });
      break;
  }
});

elements.cycles.addEventListener("dblclick", (event) => {
  if (event.target.matches('[data-field="pan"]')) {
    event.preventDefault();
    event.target.value = "0";
    event.target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (event.target.closest("button, input, select, label")) return;
  const context = findContext(event.target);
  if (context?.rhythm) toggleRhythmSettings(context.rhythm.id);
});

elements.cycles.addEventListener("keydown", (event) => {
  const option = event.target.closest(".subdivision-option");
  if (!option) {
    if (event.key === "Escape" && openSubdivisionMenu) {
      const rhythmId = openSubdivisionMenu;
      openSubdivisionMenu = null;
      renderCycles();
      requestAnimationFrame(() => {
        elements.cycles.querySelector(`[data-layer-id="${CSS.escape(rhythmId)}"] .notation-select`)?.focus();
      });
    }
    return;
  }

  const options = [...option.closest(".subdivision-menu").querySelectorAll(".subdivision-option")];
  const index = options.indexOf(option);
  let nextIndex = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % options.length;
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + options.length) % options.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = options.length - 1;
  if (event.key === "Escape") {
    event.preventDefault();
    const rhythmId = openSubdivisionMenu;
    openSubdivisionMenu = null;
    renderCycles();
    requestAnimationFrame(() => {
      elements.cycles.querySelector(`[data-layer-id="${CSS.escape(rhythmId)}"] .notation-select`)?.focus();
    });
    return;
  }
  if (nextIndex !== null) {
    event.preventDefault();
    options[nextIndex].focus();
  }
});

document.addEventListener("click", (event) => {
  if (!openSubdivisionMenu || event.target.closest(".notation-picker")) return;
  openSubdivisionMenu = null;
  renderCycles();
});

elements.cycles.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field || !["volume", "pan"].includes(field)) return;
  const context = findContext(event.target);
  if (!context?.rhythm) return;
  const { rhythmElement, rhythm } = context;
  if (field === "volume") {
    const result = applyEdit({
      type: "set-rhythm-volume",
      cycleId: context.cycle.id,
      rhythmId: rhythm.id,
      volume: event.target.value,
    }, { render: false });
    const volume = result.configuration.sequence.cycles
      .find(({ id }) => id === context.cycle.id).rhythms
      .find(({ id }) => id === rhythm.id).volume;
    rhythmElement.querySelector('[data-output="volume"]').textContent = `${Math.round(volume * 100)}%`;
  } else {
    const result = applyEdit({
      type: "set-stereo-position",
      cycleId: context.cycle.id,
      rhythmId: rhythm.id,
      pan: event.target.value,
    }, { render: false });
    const pan = result.configuration.sequence.cycles
      .find(({ id }) => id === context.cycle.id).rhythms
      .find(({ id }) => id === rhythm.id).pan;
    rhythmElement.querySelector('[data-output="pan"]').textContent = panLabel(pan);
  }
  renderPresets();
});

elements.cycles.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  if (!field || ["volume", "pan"].includes(field)) return;
  const context = findContext(event.target);
  if (!context?.rhythm) return;
  const { cycle, rhythm } = context;
  if (field === "signature-count") {
    applyEdit({
      type: "set-meter-count",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      count: event.target.value,
    });
  } else if (field === "signature-unit") {
    applyEdit({
      type: "set-meter-unit",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      unit: event.target.value,
    });
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

elements.bpmTicks.innerHTML = Array.from({ length: 28 }, (_, index) => {
  const bpm = 30 + index * 10;
  return `<span data-bpm="${bpm}" class="${bpm % 90 === 30 || bpm === 300 ? "is-major" : ""}"></span>`;
}).join("");
elements.bpmMarks.innerHTML = Array.from({ length: 28 }, (_, index) => `<option value="${30 + index * 10}"></option>`).join("");
render();
