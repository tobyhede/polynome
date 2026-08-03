import { MetronomeEngine } from "./metronome.js";
import {
  changeConfiguration,
  createConfiguration,
  createSavedPresets,
  describeConfiguration,
  describePresets,
  removeSavedPreset,
  savePreset,
} from "./configuration.js";
import { METER_COUNT_LIMIT, METER_UNIT_LIMIT, panLabel, subdivisionLabel } from "./model.js";
import { createPersistence, readStoredValue } from "./persistence.js";

const STORAGE_KEY = "polynome-configuration";
const PRESET_STORAGE_KEY = "polynome-presets";
const PERSIST_DELAY_MS = 400;
// Holds the current shape under the name used while the redesign was in
// progress; adopted once, then cleared.
const SUPERSEDED_STORAGE_KEYS = ["polynome-redesign"];
const RETIRED_STORAGE_KEYS = [
  "polynome-sequence",
  "polynome-meter",
  "polynome",
  "polynome:v1",
  "polyrhythm-metronome:v1",
];

/**
 * `querySelector` is typed as returning the base `Element`, which carries none
 * of `focus`, `value`, `style`, or `dataset`. Narrowing happens once, here,
 * rather than at each of the several dozen places these are read: this object
 * is already the single list of what the interface resolves from the shell,
 * and `test/accessibility.test.js` asserts every id below exists in
 * `index.html`, so the tag each name is asserted against is checked too.
 */
const elements = {
  heading: /** @type {HTMLHeadingElement} */ (document.querySelector("#app-heading")),
  play: /** @type {HTMLButtonElement} */ (document.querySelector("#play-button")),
  playIcon: /** @type {HTMLSpanElement} */ (document.querySelector("#play-icon")),
  bpm: /** @type {HTMLInputElement} */ (document.querySelector("#bpm-input")),
  bpmSlider: /** @type {HTMLInputElement} */ (document.querySelector("#bpm-slider")),
  bpmReadout: /** @type {HTMLDivElement} */ (document.querySelector("#bpm-readout")),
  bpmTicks: /** @type {HTMLDivElement} */ (document.querySelector("#bpm-ticks")),
  presetsToggle: /** @type {HTMLButtonElement} */ (document.querySelector("#presets-toggle")),
  presetPanel: /** @type {HTMLElement} */ (document.querySelector("#preset-panel")),
  presetList: /** @type {HTMLDivElement} */ (document.querySelector("#preset-list")),
  presetCount: /** @type {HTMLSpanElement} */ (document.querySelector("#preset-count")),
  presetCountNoun: /** @type {HTMLSpanElement} */ (document.querySelector("#preset-count-noun")),
  presetSave: /** @type {HTMLFormElement} */ (document.querySelector("#preset-save")),
  presetName: /** @type {HTMLInputElement} */ (document.querySelector("#preset-name")),
  helpToggle: /** @type {HTMLButtonElement} */ (document.querySelector("#help-toggle")),
  helpPanel: /** @type {HTMLElement} */ (document.querySelector("#help-panel")),
  cycles: /** @type {HTMLElement} */ (document.querySelector("#cycles")),
  addCycle: /** @type {HTMLButtonElement} */ (document.querySelector("#add-cycle")),
  status: /** @type {HTMLParagraphElement} */ (document.querySelector("#status")),
};

/**
 * Move focus to the first match, if there is one. `querySelector` is typed as
 * returning the base `Element`, which carries no `focus`, and every selector
 * passed here names a control this module has just rendered — so the narrowing
 * is true by construction and belongs in one place rather than at each call.
 *
 * Silence when nothing matches is the existing behaviour, not a new one: every
 * call site already used `?.`, because these run after a re-render that may
 * have removed the control being returned to.
 *
 * @param {ParentNode | null | undefined} root
 * @param {string} selector
 */
function focusWithin(root, selector) {
  /** @type {HTMLElement | null | undefined} */ (root?.querySelector(selector))?.focus();
}

const engine = new MetronomeEngine();
const openRhythms = new Set();
/**
 * The Meter field a committed edit rejected, as `{rhythmId, field}`. Rebuilding
 * the cycles markup discards any attribute set on the live input, so the
 * invalid marking has to be state the template reads rather than something
 * written to the element the musician was editing.
 */
let invalidMeter = null;
let state = loadState();
let savedPresets = readSavedPresets() ?? createSavedPresets();
let description = describeConfiguration(state);
const {
  repetitions: REPETITIONS,
  sounds: SOUNDS,
  subdivisions: SUBDIVISIONS,
} = description.choices;
let presetsOpen = false;
let helpOpen = false;
let pendingDeletePresetId = null;
let openSubdivisionMenu = null;
let animationFrame = null;
let runBpm = null;

function loadState() {
  let raw = null;
  try {
    raw = readStoredValue({
      storage: localStorage,
      key: STORAGE_KEY,
      supersededKeys: SUPERSEDED_STORAGE_KEYS,
      retiredKeys: RETIRED_STORAGE_KEYS,
    });
  } catch {
    // Accessing the browser's storage property can itself be forbidden.
  }
  try {
    return createConfiguration(raw ? JSON.parse(raw) : undefined);
  } catch {
    return createConfiguration();
  }
}

function writeState(configuration) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configuration));
}

/**
 * Every tab rewrites the whole preset key, so a write built from the list this
 * tab read at startup reinstates whatever another tab has since removed. Each
 * write reads first, and this reports a refusal as null rather than as an empty
 * list: storage this tab cannot read is not storage holding nothing, and the
 * caller keeps what it has instead of adopting an emptiness it cannot verify.
 */
function readSavedPresets() {
  let raw = null;
  try {
    raw = localStorage.getItem(PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
  try {
    return createSavedPresets(raw ? JSON.parse(raw) : undefined);
  } catch {
    return createSavedPresets();
  }
}

function storedSavedPresets() {
  return readSavedPresets() ?? savedPresets;
}

function writeSavedPresets(presets) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

const persistence = createPersistence({
  write: writeState,
  delay: PERSIST_DELAY_MS,
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (timer) => window.clearTimeout(timer),
});

function applyEdit(edit, options = {}) {
  const result = changeConfiguration(state, edit);
  state = result.configuration;
  description = describeConfiguration(state);
  persistence.schedule(state);
  if (options.render !== false) render();

  if (options.deferConsequence) return result;
  engine.applyConsequence(result.consequence, state)?.catch(showError);
  return result;
}

function render() {
  renderPanels();
  renderTransport();
  // An edit never adds, removes or renames a Preset, so the list itself cannot
  // have changed; save, delete and the panel toggle rebuild it.
  renderPresetSelection();
  renderCycles();
  renderFooter();
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
  const progress = (state.bpm - 30) / 270;
  const size = 2.1 + progress * 2.1;
  const pixelSize = size * 16;
  const glitchIntensity = Math.min(1, Math.max(0, (state.bpm - 250) / 50));
  // Every length the readout uses is offered twice: the design value, and the
  // same value as a share of the transport card. The card is the size container,
  // and 1cqw is 5px at the 500px column this was drawn against, so taking the
  // value nearer zero holds the designed size up to that width and scales with
  // the card below it. A negative length needs `max()` to shrink toward zero
  // rather than away from it, which is why the comparator follows the sign.
  const cq = (px) => `${(px / 5).toFixed(2)}cqw`;
  const fit = (px) => `${px < 0 ? "max" : "min"}(${px}px, ${cq(px)})`;
  const readout = elements.bpmReadout.style;
  readout.setProperty("--bpm-left", `calc(${progress * 100}% + ${(0.5 - progress) * 22}px)`);
  readout.setProperty("--bpm-size", `min(${size}rem, ${cq(pixelSize)})`);
  // Derived from the resolved glyph size rather than recomputed in pixels. Both
  // branches of `--bpm-size` above are the same length as `pixelSize` while the
  // root is the 16px this was drawn against, so these are the values the pixel
  // arithmetic used to produce — but they stay the width of the digits when a
  // reader raises their browser's default text size and the `rem` branch grows.
  // Everything the box does depends on that: it centres the number over its own
  // point of the track, and `--bpm-half` is what holds it inside the card.
  readout.setProperty("--bpm-width", "calc(var(--bpm-size) * 0.86 * 3)");
  // Half the width, which is how far from either end of the track the CSS has
  // to hold the number to keep it fully inside the card.
  readout.setProperty("--bpm-half", "calc(var(--bpm-size) * 0.86 * 1.5)");
  readout.setProperty("--bpm-label-margin", fit(6.5 - pixelSize * 0.255));
  const glitchTargets = [elements.bpm, elements.heading];
  glitchTargets.forEach((target) => {
    target.classList.toggle("is-glitching", glitchIntensity > 0);
  });
  if (glitchIntensity > 0) {
    const displacement = (0.35 + glitchIntensity * 0.65).toFixed(2);
    const duration = `${(1.5 - glitchIntensity * 1.1).toFixed(2)}s`;
    glitchTargets.forEach((target) => {
      target.style.setProperty("--g", displacement);
      target.style.setProperty("--glitch-duration", duration);
    });
  } else {
    glitchTargets.forEach((target) => {
      target.style.removeProperty("--g");
      target.style.removeProperty("--glitch-duration");
    });
  }
  elements.bpmTicks.querySelectorAll("span").forEach((tick) => {
    tick.classList.toggle("is-passed", Number(tick.dataset.bpm) <= state.bpm);
  });
  updatePlayButton();
}

/**
 * Tempo and master level changes re-render on every pointer move, and this list
 * costs a repair pass over every stored Configuration plus a full rebuild of the
 * grid — on the same thread as the scheduler. The panel is closed for almost all
 * of that, so the toggle renders it on the way open and nothing here runs for a
 * panel nobody can see.
 */
function renderPresets() {
  if (!presetsOpen) return;
  const presets = describePresets(state, savedPresets);
  const count = presets.length;
  elements.presetCount.textContent = String(count);
  // The heading shows the bare number; the noun is carried as visually hidden
  // text because `aria-label` on a generic span never reaches the accessibility
  // tree.
  elements.presetCountNoun.textContent = count === 1 ? " preset" : " presets";
  // Saving, deleting, arming a deletion and adopting another tab's write all
  // rebuild this list under whatever the user had focused; applying a Preset no
  // longer does, because it only changes selection. Restore by stable Preset
  // identifier rather than by name, which a duplicate save can change, and cover
  // both buttons, because an armed delete keeps focus on the delete one.
  const focused = elements.presetList.contains(document.activeElement)
    ? /** @type {HTMLElement | null} */ (
        document.activeElement.closest("[data-preset-id], [data-delete-preset-id]")
      )
    : null;
  const focusedSelector = focused?.dataset.deletePresetId
    ? `[data-delete-preset-id="${CSS.escape(focused.dataset.deletePresetId)}"]`
    : focused?.dataset.presetId
      ? `[data-preset-id="${CSS.escape(focused.dataset.presetId)}"]`
      : null;
  // Identifiers reach the markup unescaped, which is safe only because every one
  // of them is either derived from the frozen built-in names or has passed
  // `safeIdentifier`'s pattern on the way out of storage.
  elements.presetList.innerHTML = presets
    .map(
      (preset) => `
    <div class="preset-card${preset.builtIn ? " is-built-in" : ""}">
      <button
        type="button"
        class="preset-button${preset.selected ? " is-selected" : ""}"
        data-preset-id="${preset.id}"
        aria-pressed="${preset.selected}"
      >
        <strong>${escapeHtml(preset.name)}</strong>
        ${presetNotationTemplate(preset.configuration)}
      </button>
      ${
        preset.builtIn
          ? ""
          : `
        <button
          type="button"
          class="preset-delete${preset.id === pendingDeletePresetId ? " is-armed" : ""}"
          data-delete-preset-id="${preset.id}"
          aria-label="${preset.id === pendingDeletePresetId ? "Confirm deleting" : "Delete"} ${escapeHtml(preset.name)} preset"
          title="${preset.id === pendingDeletePresetId ? "Select again to delete" : "Delete preset"}"
        >×</button>
      `
      }
    </div>
  `,
    )
    .join("");
  if (focusedSelector) {
    // The Preset that had focus can be the one that just stopped existing, which
    // is exactly when losing focus to the document costs the most.
    const restored = /** @type {HTMLElement | null} */ (
      elements.presetList.querySelector(focusedSelector)
    );
    if (restored) restored.focus();
    else elements.presetName.focus();
  }
}

/**
 * Deletion is confirmed on the button itself rather than through `confirm`,
 * which blocks the renderer — and with it the scheduler feeding the metronome —
 * for as long as the dialog is open. Dismissal mirrors the subdivision menu:
 * Escape, or a click that lands anywhere else.
 */
function dismissPendingDelete() {
  if (pendingDeletePresetId === null) return;
  pendingDeletePresetId = null;
  renderPresets();
}

/**
 * Tempo, master level and mix changes move the current Configuration, and the
 * only thing that can change about this list is which Presets it now matches:
 * every card describes a stored Configuration and cannot have changed. Setting
 * the two attributes that carry selection leaves the grid untouched, which is
 * what keeps a drag from rebuilding identical markup on every pointer move.
 */
function renderPresetSelection() {
  if (!presetsOpen) return;
  const selected = new Set(
    describePresets(state, savedPresets)
      .filter((preset) => preset.selected)
      .map((preset) => preset.id),
  );
  for (const button of /** @type {NodeListOf<HTMLElement>} */ (
    elements.presetList.querySelectorAll("[data-preset-id]")
  )) {
    const isSelected = selected.has(button.dataset.presetId);
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  }
}

function presetNotationTemplate(configuration) {
  const accessible = configuration.sequence.cycles
    .map((cycle) => {
      const rhythms = cycle.rhythms
        .map(
          (rhythm) =>
            `${rhythmLabel(rhythm)}, ${subdivisionLabel(rhythm.subdivision, rhythm.signature.unit)}`,
        )
        .join(" plus ");
      return `${cycle.repetitions} ${cycle.repetitions === 1 ? "repetition" : "repetitions"} of ${rhythms}`;
    })
    .join(", then ");
  const visual = configuration.sequence.cycles
    .map(
      (cycle) => `
    <span class="preset-cycle">
      ${cycle.repetitions === 1 ? "" : `<span class="preset-repetitions">${cycle.repetitions}×</span>`}
      ${cycle.rhythms
        .map(
          (rhythm) => `
        <span class="preset-rhythm">
          <span>${rhythmLabel(rhythm)}</span>
          ${noteIcon(rhythm.subdivision, 15)}
        </span>
      `,
        )
        .join('<span aria-hidden="true"> + </span>')}
    </span>
  `,
    )
    .join('<span class="preset-sequence-arrow" aria-hidden="true"> → </span>');
  return `<span class="preset-notation" aria-hidden="true">${visual}</span><span class="sr-only">${escapeHtml(accessible)}</span>`;
}

function renderCycles() {
  const focusKey = focusSelector(document.activeElement);
  elements.cycles.innerHTML = state.sequence.cycles
    .map((cycle, index) => cycleTemplate(cycle, index))
    .join("");
  if (focusKey) focusWithin(elements.cycles, focusKey);
  layoutSteps();
}

/**
 * One bar of sixteenths on one row is the step-sequencer convention the TR-808
 * lineage settled on, and it is the longest row that still reads at a glance.
 */
const STEPS_PER_ROW_LIMIT = 16;

function descendingDivisors(count) {
  const divisors = [];
  for (let candidate = count; candidate >= 1; candidate -= 1) {
    if (count % candidate === 0) divisors.push(candidate);
  }
  return divisors;
}

/**
 * Grouping only: this chooses how many beats share a row and changes nothing
 * else. Step size and spacing belong to the stylesheet and are measured here
 * rather than set.
 *
 * A beat is indivisible — engraving beams a beat's divisions together in every
 * meter — so a row holds a whole number of beats, and equal rows mean that
 * number must divide the beat count. Taking the divisors largest-first under a
 * sixteen-step ceiling lands on the conventions by itself: 4/4 sixteenths give
 * one row of sixteen, and an irregular meter like 7/8 is prime, so its only
 * options are the whole bar or a beat per row, never a false even split.
 *
 * Width can only narrow that choice further, never make it. When even a single
 * beat is wider than the row, the pattern scrolls rather than shrinking.
 */
function layoutSteps() {
  // Measure every rhythm, then write every rhythm. Interleaving the two costs a
  // synchronous reflow per rhythm, because each write invalidates the layout the
  // next read needs and this runs on every render — including every step click.
  // Batching also makes the answer independent of the order rhythms are visited
  // in, since none of them is measured against another's freshly applied rows.
  const plans = [];
  for (const steps of /** @type {NodeListOf<HTMLElement>} */ (
    elements.cycles.querySelectorAll(".steps")
  )) {
    const beat = steps.querySelector(".beat");
    const style = getComputedStyle(steps);
    const available =
      steps.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (!beat || !(available > 0)) continue;

    // A beat is a flex row of fixed-size steps, so its width does not depend on
    // the grouping being chosen and can be measured before choosing it.
    const beatWidth = beat.getBoundingClientRect().width;
    const beatGap = parseFloat(style.columnGap) || 0;
    const beats = Number(steps.dataset.beats);
    const subdivision = Number(steps.dataset.subdivision);
    const perRow =
      descendingDivisors(beats).find(
        (candidate) =>
          candidate * subdivision <= STEPS_PER_ROW_LIMIT &&
          candidate * beatWidth + (candidate - 1) * beatGap <= available,
      ) ?? 1;

    plans.push({ steps, perRow, scrolling: beatWidth > available });
  }

  for (const { steps, perRow, scrolling } of plans) {
    steps.style.setProperty("--beats-per-row", String(perRow));
    steps.classList.toggle("is-scrolling", scrolling);
  }
}

/**
 * Only width changes the answer. Watching height as well would re-enter this on
 * the layout it just produced.
 *
 * Width is not fully independent of that layout either: changing the row count
 * changes page height, which on a classic-scrollbar platform can toggle the
 * vertical scrollbar and so change this container's width. That settles rather
 * than oscillates, because the grouping is monotone in width — a narrower row
 * can only take the same number of beats or fewer, so it can only produce the
 * same number of rows or more. Losing the scrollbar therefore never makes the
 * page taller, and gaining one never makes it shorter, so each toggle is
 * self-confirming and stops after one pass.
 *
 * The exception is a step-size breakpoint sitting inside one scrollbar width of
 * the current viewport, where narrowing shrinks the steps and can fit more beats
 * to a row. Reaching it needs the page height to cross the viewport height at
 * that same width; the browser's own ResizeObserver loop limit ends it after a
 * frame, which is why there is no debounce here to buy.
 */
let laidOutWidth = 0;
new ResizeObserver((entries) => {
  const { width } = entries[0].contentRect;
  if (width === laidOutWidth) return;
  laidOutWidth = width;
  layoutSteps();
}).observe(elements.cycles);

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

/**
 * Only structural edits can change whether a cycle may be added, and those all
 * re-render in full, so the paths that skip render() to redraw the transport,
 * presets, or a single mix output cannot leave this stale.
 */
function renderFooter() {
  const policy = description.availability.addCycle;
  elements.addCycle.disabled = !policy.available;
  const label = unavailableLabel("+ Cycle", policy);
  if (label) elements.addCycle.setAttribute("aria-label", label);
  else elements.addCycle.removeAttribute("aria-label");
}

/**
 * A disabled button is not focusable and receives no pointer events, so a title
 * tooltip never reaches a keyboard or screen-reader user; the accessible name
 * is what a browse cursor still announces. Returns null while the control is
 * available so its visible text stays its accessible name, and repeats that
 * text so speech input keeps working when it does not.
 */
function unavailableLabel(text, policy) {
  if (policy.available) return null;
  const reason =
    policy.reason === "sequence-rhythm-limit"
      ? "the sequence has reached its rhythm limit"
      : "it is not currently available";
  return `${text}, unavailable — ${reason}`;
}

function cycleTemplate(cycle, cycleIndex) {
  const cycleAvailability = description.availability.cycles[cycle.id];
  const cycleTitle = state.sequence.cycles.length > 1 ? `Cycle ${cycleIndex + 1}` : "Cycle";
  const removeDisabled = !cycleAvailability.remove.available;
  const addRhythmLabel = unavailableLabel("+ Rhythm", cycleAvailability.addRhythm);
  const dots = REPETITIONS.slice(1)
    .map((value, index) => {
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
    })
    .join("");

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
        ${addRhythmLabel ? `aria-label="${addRhythmLabel}"` : ""}
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

      <!-- The subdivision is carried twice on purpose: layoutSteps() reads the
           data attribute, and the beat-gap clamp needs it as a number CSS can
           calculate with. Neither can read the other's form. -->
      <div class="steps" role="group" aria-label="${label} step levels" data-beats="${rhythm.signature.count}" data-subdivision="${rhythm.subdivision}" style="--subdivision: ${rhythm.subdivision}">
        ${beatsTemplate(rhythm)}
      </div>

      <div id="${drawerId}" class="rhythm-settings" ${open ? "" : "hidden"}>
        ${rhythmSettingsTemplate(rhythm)}
      </div>
    </article>
  `;
}

/**
 * Both Meter components take free text rather than a number input: a number
 * input reports a rejected entry as an empty string, which would leave the
 * musician's own value unrecoverable and every malformed entry reading alike.
 * `inputmode` and `pattern` keep the numeric keypad on a touch keyboard.
 */
function meterFieldTemplate(rhythm, field, value, name) {
  const invalid = invalidMeter?.rhythmId === rhythm.id && invalidMeter.field === field;
  const described = invalid
    ? ` aria-invalid="true" aria-describedby="${meterMessageId(rhythm)}"`
    : "";
  return `<input type="text" inputmode="numeric" pattern="[0-9]*" value="${value}" data-field="${field}" aria-label="${name}"${described} />`;
}

function meterMessageId(rhythm) {
  return `rhythm-${rhythm.id}-meter-message`;
}

function meterLimitMessage(field) {
  const numerator = field === "signature-count";
  const limit = numerator ? METER_COUNT_LIMIT : METER_UNIT_LIMIT;
  const component = numerator ? "numerator" : "denominator";
  return `Meter ${component} must be a whole number from ${limit.minimum} to ${limit.maximum}`;
}

function rhythmSettingsTemplate(rhythm) {
  const label = rhythmLabel(rhythm);
  const subdivisionMenuId = `rhythm-${rhythm.id}-subdivision-menu`;
  const subdivisionOpen = openSubdivisionMenu === rhythm.id;
  const meterMessage =
    invalidMeter?.rhythmId === rhythm.id
      ? `<span id="${meterMessageId(rhythm)}" class="sr-only">${meterLimitMessage(invalidMeter.field)}</span>`
      : "";
  return `
    <div class="timing-settings">
      <label class="control-label">
        <span>Signature</span>
        <span class="signature-input">
          ${meterFieldTemplate(rhythm, "signature-count", rhythm.signature.count, `${label} meter numerator`)}
          <span aria-hidden="true">/</span>
          ${meterFieldTemplate(rhythm, "signature-unit", rhythm.signature.unit, `${label} meter denominator`)}
        </span>
      </label>
      ${meterMessage}

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
            ${SUBDIVISIONS.map(
              (subdivision) => `
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
            `,
            ).join("")}
          </div>
        </div>
      </div>

      <div class="sound-control" role="group" aria-labelledby="rhythm-${rhythm.id}-sound-label">
        <span id="rhythm-${rhythm.id}-sound-label">Sound</span>
        <div>${SOUNDS.map(
          (sound) => `
          <button type="button" data-action="sound" data-sound="${sound}" class="sound-button${rhythm.sound === sound ? " is-selected" : ""}" aria-pressed="${rhythm.sound === sound}">${sound}</button>
        `,
        ).join("")}</div>
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

// Steps are grouped a beat at a time so a narrow screen can only ever break
// between beats. `steps.length` is always `signature.count * subdivision`, so
// every group is full and no row is left ragged.
function beatsTemplate(rhythm) {
  const beats = [];
  for (let start = 0; start < rhythm.steps.length; start += rhythm.subdivision) {
    const group = rhythm.steps
      .slice(start, start + rhythm.subdivision)
      .map((step, offset) => stepTemplate(step, start + offset))
      .join("");
    beats.push(`<div class="beat">${group}</div>`);
  }
  return beats.join("");
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
  const beams =
    subdivision <= 1 ? 0 : subdivision <= 3 ? 1 : subdivision <= 6 ? 2 : subdivision <= 12 ? 3 : 4;
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
  const beamShapes = Array.from(
    { length: beams },
    (_, index) =>
      `<rect x="${beamLeft}" y="${stemTop + index * 5}" width="${beamRight - beamLeft}" height="3.2" rx="1"></rect>`,
  ).join("");
  const tuplet = ![1, 2, 4, 8, 16, 32].includes(subdivision);
  const tupletLeft = x0 - 2;
  const tupletRight = x0 + (shown - 1) * gap + 8;
  const arm = (tupletRight - tupletLeft) / 2 - 7;
  const tupletShapes = tuplet
    ? `<rect x="${tupletLeft}" y="2.6" width="${arm}" height="1.5" rx="0.7"></rect><rect x="${tupletRight - arm}" y="2.6" width="${arm}" height="1.5" rx="0.7"></rect><text x="${(tupletLeft + tupletRight) / 2}" y="7" text-anchor="middle" font-size="9.5" font-weight="700" font-family="JetBrains Mono, monospace">${subdivision}</text>`
    : "";
  const left = Math.min(x0 - 5.6, tuplet ? x0 - 2.6 : Infinity);
  const right = Math.max(
    x0 + (shown - 1) * gap + 5.7,
    tuplet ? x0 + (shown - 1) * gap + 8.4 : -Infinity,
  );
  const top = tuplet ? 0 : 8.5;
  const boxWidth = right - left;
  const boxHeight = 35.5 - top;
  return `<svg class="note-icon" viewBox="${left} ${top} ${boxWidth} ${boxHeight}" width="${boxWidth * (height / boxHeight)}" height="${height}" fill="currentColor" aria-hidden="true" focusable="false">${heads}${beamShapes}${tupletShapes}</svg>`;
}

function pencilIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"></path><path d="M14.5 6.5 17.5 9.5"></path></svg>`;
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
    elements.cycles.querySelectorAll(".is-current").forEach((element) => {
      element.classList.remove("is-current");
    });
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
  const cycle = state.sequence.cycles.find(
    (candidate) => candidate.id === cycleElement.dataset.cycleId,
  );
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
    : activatingToggle
      ? ".rhythm-identity"
      : null;
  if (openRhythms.has(rhythmId)) openRhythms.delete(rhythmId);
  else openRhythms.add(rhythmId);
  // The rejected entry is gone with the drawer, so its marking must not outlive
  // it and reappear against the value the Meter actually holds.
  if (invalidMeter?.rhythmId === rhythmId) invalidMeter = null;
  renderCycles();
  if (toggleSelector) {
    const rhythmCard = elements.cycles.querySelector(`[data-layer-id="${CSS.escape(rhythmId)}"]`);
    focusWithin(rhythmCard, toggleSelector);
  }
}

/**
 * Closing the menu destroys the option the user was on, so focus has to be sent
 * somewhere deliberate; the notation select that opened it is where a menu
 * dismissal is expected to land. The rebuilt select only exists after the next
 * frame, so it cannot be found until then.
 */
function dismissSubdivisionMenu() {
  const rhythmId = openSubdivisionMenu;
  openSubdivisionMenu = null;
  renderCycles();
  requestAnimationFrame(() => {
    focusWithin(elements.cycles, `[data-layer-id="${CSS.escape(rhythmId)}"] .notation-select`);
  });
}

elements.play.addEventListener("click", togglePlayback);
elements.presetsToggle.addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  if (presetsOpen) {
    helpOpen = false;
    renderPresets();
  }
  renderPanels();
});
elements.helpToggle.addEventListener("click", () => {
  helpOpen = !helpOpen;
  if (helpOpen) presetsOpen = false;
  renderPanels();
});
elements.bpm.addEventListener("change", (event) =>
  changeTempo(/** @type {HTMLInputElement} */ (event.target).value),
);
elements.bpmSlider.addEventListener("input", (event) => {
  applyEdit(
    { type: "set-tempo", bpm: /** @type {HTMLInputElement} */ (event.target).value },
    { deferConsequence: true, render: false },
  );
  renderTransport();
  renderPresetSelection();
});
/**
 * Dragging the slider defers the transport consequence, so on release the run
 * is still playing the tempo it started with. Comparing against that tempo
 * rather than a flag raised when the drag began keeps the decision correct even
 * when a drag ends without a change event, because the next release compares
 * against what is actually sounding.
 */
elements.bpmSlider.addEventListener("change", () => {
  if (engine.playing && state.bpm !== runBpm) {
    engine.restart(state).catch(showError);
  }
});
elements.presetList.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const deleteButton = /** @type {HTMLElement | null} */ (
    target.closest("[data-delete-preset-id]")
  );
  if (deleteButton) {
    const presetId = deleteButton.dataset.deletePresetId;
    const preset = savedPresets.find(({ id }) => id === presetId);
    if (!preset) return;
    if (pendingDeletePresetId !== presetId) {
      pendingDeletePresetId = presetId;
      renderPresets();
      focusWithin(elements.presetList, `[data-delete-preset-id="${CSS.escape(presetId)}"]`);
      elements.status.textContent = `Delete ${preset.name} preset? Select again to confirm`;
      return;
    }
    pendingDeletePresetId = null;
    const result = removeSavedPreset(storedSavedPresets(), presetId);
    // Another tab can remove a preset between this list being rendered and the
    // deletion being confirmed. Nothing is left to delete, but the button the
    // user just pressed is still on screen and owes them an answer.
    if (result.reason) {
      savedPresets = result.presets;
      renderPresets();
      elements.presetName.focus();
      elements.status.textContent = `${preset.name} preset was already deleted`;
      return;
    }
    savedPresets = result.presets;
    const persisted = writeSavedPresets(savedPresets);
    renderPresets();
    elements.presetName.focus();
    elements.status.textContent = persisted
      ? `${preset.name} preset deleted`
      : "Preset deletion could not be saved in this browser";
    return;
  }

  const button = /** @type {HTMLElement | null} */ (target.closest("[data-preset-id]"));
  if (!button) return;
  const preset = describePresets(state, savedPresets).find(
    ({ id }) => id === button.dataset.presetId,
  );
  if (!preset) return;
  openRhythms.clear();
  applyEdit(
    preset.builtIn
      ? { type: "apply-preset", name: preset.name }
      : { type: "apply-preset", configuration: preset.configuration },
  );
});
elements.presetName.addEventListener("input", () => {
  elements.presetName.setCustomValidity("");
});
elements.presetSave.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.presetName.setCustomValidity("");
  const result = savePreset(storedSavedPresets(), elements.presetName.value, state);
  if (result.reason) {
    elements.presetName.setCustomValidity(
      result.reason === "preset-name-reserved"
        ? "Choose a name different from a built-in preset."
        : "Enter a preset name between 1 and 80 characters.",
    );
    elements.presetName.reportValidity();
    return;
  }
  savedPresets = result.presets;
  const persisted = writeSavedPresets(savedPresets);
  elements.presetName.value = "";
  renderPresets();
  focusWithin(elements.presetList, `[data-preset-id="${CSS.escape(result.preset.id)}"]`);
  elements.status.textContent = persisted
    ? `${result.preset.name} preset saved`
    : "Preset could not be saved in this browser";
});
elements.addCycle.addEventListener("click", () => {
  applyEdit({ type: "add-cycle" });
});

elements.cycles.addEventListener("click", (event) => {
  const actionElement = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest("[data-action]")
  );
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
    case "remove-cycle": {
      const result = applyEdit({ type: "remove-cycle", cycleId: cycle.id });
      if (result.reason !== null) return;
      // The removed control cannot be refocused, so fall back to a stable neighbour.
      elements.addCycle.focus();
      break;
    }
    case "add-rhythm": {
      const result = applyEdit({ type: "add-rhythm", cycleId: cycle.id }, { render: false });
      if (result.reason !== null) break;
      const addedRhythm = result.configuration.sequence.cycles
        .find((candidate) => candidate.id === cycle.id)
        ?.rhythms.at(-1);
      if (addedRhythm) openRhythms.add(addedRhythm.id);
      render();
      break;
    }
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
      focusWithin(elements.cycles, `[data-cycle-id="${CSS.escape(cycle.id)}"] .add-rhythm`);
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
          focusWithin(
            elements.cycles,
            `[data-layer-id="${CSS.escape(rhythm.id)}"] .subdivision-option[aria-selected="true"]`,
          );
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
        focusWithin(elements.cycles, `[data-layer-id="${CSS.escape(rhythm.id)}"] .notation-select`);
      });
      break;
    case "mute":
      if (rhythm)
        applyEdit({
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
      if (rhythm)
        applyEdit({
          type: "set-sound",
          cycleId: cycle.id,
          rhythmId: rhythm.id,
          sound: actionElement.dataset.sound,
        });
      break;
  }
});

elements.cycles.addEventListener("dblclick", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.matches('[data-field="pan"]')) {
    event.preventDefault();
    const pan = /** @type {HTMLInputElement} */ (target);
    pan.value = "0";
    pan.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (target.closest("button, input, select, label")) return;
  const context = findContext(target);
  if (context?.rhythm) toggleRhythmSettings(context.rhythm.id);
});

elements.cycles.addEventListener("keydown", (event) => {
  const option = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest(".subdivision-option")
  );
  if (!option) {
    if (event.key === "Escape" && openSubdivisionMenu) dismissSubdivisionMenu();
    return;
  }

  const options = /** @type {HTMLElement[]} */ ([
    ...option.closest(".subdivision-menu").querySelectorAll(".subdivision-option"),
  ]);
  const index = options.indexOf(option);
  let nextIndex = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight")
    nextIndex = (index + 1) % options.length;
  if (event.key === "ArrowUp" || event.key === "ArrowLeft")
    nextIndex = (index - 1 + options.length) % options.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = options.length - 1;
  // Escape has no default action on these controls in either Chrome or
  // Firefox — a number input keeps its typed value, its focus and its caret —
  // so both Escape paths here only dismiss. The arrow keys below do need
  // preventDefault, because they scroll.
  if (event.key === "Escape") {
    dismissSubdivisionMenu();
    return;
  }
  if (nextIndex !== null) {
    event.preventDefault();
    options[nextIndex].focus();
  }
});

document.addEventListener("click", (event) => {
  if (!openSubdivisionMenu || /** @type {HTMLElement} */ (event.target).closest(".notation-picker"))
    return;
  openSubdivisionMenu = null;
  renderCycles();
});

// The arming click reaches here too, so a delete button is what keeps it armed.
document.addEventListener("click", (event) => {
  if (/** @type {HTMLElement} */ (event.target).closest("[data-delete-preset-id]")) return;
  dismissPendingDelete();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismissPendingDelete();
});

elements.cycles.addEventListener("input", (event) => {
  const target = /** @type {HTMLInputElement} */ (event.target);
  const field = target.dataset.field;
  if (!field || !["volume", "pan"].includes(field)) return;
  const context = findContext(target);
  if (!context?.rhythm) return;
  const { rhythmElement, rhythm } = context;
  if (field === "volume") {
    const result = applyEdit(
      {
        type: "set-rhythm-volume",
        cycleId: context.cycle.id,
        rhythmId: rhythm.id,
        volume: target.value,
      },
      { render: false },
    );
    const volume = result.configuration.sequence.cycles
      .find(({ id }) => id === context.cycle.id)
      .rhythms.find(({ id }) => id === rhythm.id).volume;
    rhythmElement.querySelector('[data-output="volume"]').textContent =
      `${Math.round(volume * 100)}%`;
  } else {
    const result = applyEdit(
      {
        type: "set-stereo-position",
        cycleId: context.cycle.id,
        rhythmId: rhythm.id,
        pan: target.value,
      },
      { render: false },
    );
    const pan = result.configuration.sequence.cycles
      .find(({ id }) => id === context.cycle.id)
      .rhythms.find(({ id }) => id === rhythm.id).pan;
    rhythmElement.querySelector('[data-output="pan"]').textContent = panLabel(pan);
  }
  renderPresetSelection();
});

elements.cycles.addEventListener("change", (event) => {
  const target = /** @type {HTMLInputElement | HTMLSelectElement} */ (event.target);
  const field = target.dataset.field;
  if (!field || ["volume", "pan"].includes(field)) return;
  const context = findContext(target);
  if (!context?.rhythm) return;
  const { cycle, rhythm } = context;
  let result = null;
  // The invalid marking is template state, so the edit defers its render until
  // that state is settled and the rebuilt field can carry the right attributes.
  if (field === "signature-count") {
    result = applyEdit(
      {
        type: "set-meter-count",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        count: target.value,
      },
      { render: false },
    );
  } else if (field === "signature-unit") {
    result = applyEdit(
      {
        type: "set-meter-unit",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        unit: target.value,
      },
      { render: false },
    );
  }
  if (!result) return;
  const rejected = result.reason === "invalid-value";
  invalidMeter = rejected ? { rhythmId: rhythm.id, field } : null;
  render();
  // The status region is shared with the transport state, so a rejected Meter
  // has to be replaced rather than merely left behind: a message that outlived
  // its value would keep reporting a Meter the musician has already corrected.
  if (rejected) {
    elements.status.textContent = meterLimitMessage(field);
    return;
  }
  const committed = result.configuration.sequence.cycles
    .find(({ id }) => id === cycle.id)
    ?.rhythms.find(({ id }) => id === rhythm.id);
  if (committed) elements.status.textContent = `Meter ${rhythmLabel(committed)}`;
});

/**
 * Enter and Tab commit a Meter entry that the browser would otherwise hold
 * until the field lost focus. `defaultValue` is the value the template last
 * rendered from the Configuration, so comparing against it commits only what
 * the musician actually retyped: tabbing through an untouched field is
 * navigation, and must not announce an edit or rebuild the cycles beneath it.
 */
elements.cycles.addEventListener("keydown", (event) => {
  if (!event.target.matches('[data-field="signature-count"], [data-field="signature-unit"]'))
    return;
  if (!["Enter", "Tab"].includes(event.key)) return;
  if (event.key === "Enter") event.preventDefault();
  if (event.target.value === event.target.defaultValue) return;
  event.target.dispatchEvent(new Event("change", { bubbles: true }));
});

engine.addEventListener("playstate", () => {
  // Every transport run starts here, so this is the one place that knows the
  // tempo the audible run is playing at.
  runBpm = engine.playing ? state.bpm : null;
  updatePlayButton();
  if (engine.playing) startAnimation();
});
engine.addEventListener("audioerror", (event) =>
  showError(/** @type {CustomEvent} */ (event).detail),
);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
  event.preventDefault();
  togglePlayback();
});
window.addEventListener("pagehide", () => {
  persistence.flush();
  engine.stop();
});
/**
 * Another tab saving or deleting leaves this one showing a list that no longer
 * exists, and a null key is storage cleared wholesale. The configuration key is
 * deliberately not adopted: two tabs each hold their own tempo and sequence, and
 * taking over an edit in progress is not a reconciliation the user asked for.
 */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== PRESET_STORAGE_KEY) return;
  const presets = readSavedPresets();
  if (presets === null) return;
  savedPresets = presets;
  // An armed deletion whose Preset another tab has already removed has nothing
  // left to confirm, and leaving it armed would keep state pointing at nothing.
  if (!presets.some(({ id }) => id === pendingDeletePresetId)) {
    pendingDeletePresetId = null;
  }
  renderPresets();
});
// A backgrounded tab can be frozen or discarded without ever firing pagehide,
// and hiding is the last moment a mobile browser reliably hands over.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistence.flush();
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Major ticks carry their own number, so the tick row is also the tempo scale.
elements.bpmTicks.innerHTML = Array.from({ length: 28 }, (_, index) => {
  const bpm = 30 + index * 10;
  const major = bpm % 90 === 30;
  return `<span data-bpm="${bpm}" data-label="${major ? bpm : ""}" class="${major ? "is-major" : ""}"></span>`;
}).join("");
render();
