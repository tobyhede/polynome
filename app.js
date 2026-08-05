import { MetronomeEngine } from "./metronome.js";
import {
  changeConfiguration,
  createConfiguration,
  createFactoryPresets,
  createSavedPresets,
  createStoredPresets,
  describeConfiguration,
  describePresets,
  presetNameInUse,
  removeSavedPreset,
  sameConfiguration,
  savePreset,
} from "./configuration.js";
import {
  lookup,
  panLabel,
  snapBalance,
  subdivisionLabel,
  convertedEnvelopeAmount,
  ENVELOPE,
  MIX_STEP,
  TEMPO_LIMIT,
  TEMPO_TICK_INTERVAL,
} from "./model.js";
import { createPersistence, readStoredValue } from "./persistence.js";
// `htm/preact` is Preact's own no-build path: tagged templates the browser
// parses, and `html` already bound to its `h`. The import map in `index.html`
// resolves all three specifiers this pulls in.
import { html, render } from "htm/preact";

const STORAGE_KEY = "polynome-configuration-v2";
const PRESET_STORAGE_KEY = "polynome-presets-v3";
const PERSIST_DELAY_MS = 400;
// The meter domain narrowed in v2. Values from earlier releases are retired
// instead of repaired into different rhythms without the listener's consent.
const RETIRED_STORAGE_KEYS = [
  "polynome-configuration",
  "polynome-redesign",
  "polynome-sequence",
  "polynome-meter",
  "polynome",
  "polynome:v1",
  "polyrhythm-metronome:v1",
];
const RETIRED_PRESET_STORAGE_KEYS = ["polynome-presets", "polynome-presets-v2"];

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
  bpmDown: /** @type {HTMLButtonElement} */ (document.querySelector("#bpm-down")),
  bpmUp: /** @type {HTMLButtonElement} */ (document.querySelector("#bpm-up")),
  bpmReadout: /** @type {HTMLDivElement} */ (document.querySelector("#bpm-readout")),
  bpmLabel: /** @type {HTMLLabelElement} */ (document.querySelector("#bpm-readout label")),
  bpmTicks: /** @type {HTMLDivElement} */ (document.querySelector("#bpm-ticks")),
  presetsToggle: /** @type {HTMLButtonElement} */ (document.querySelector("#presets-toggle")),
  presetPanel: /** @type {HTMLElement} */ (document.querySelector("#preset-panel")),
  presetList: /** @type {HTMLDivElement} */ (document.querySelector("#preset-list")),
  presetCount: /** @type {HTMLSpanElement} */ (document.querySelector("#preset-count")),
  presetCountNoun: /** @type {HTMLSpanElement} */ (document.querySelector("#preset-count-noun")),
  presetsClose: /** @type {HTMLButtonElement} */ (document.querySelector("#presets-close")),
  presetSave: /** @type {HTMLFormElement} */ (document.querySelector("#preset-save")),
  presetSavePanel: /** @type {HTMLElement} */ (document.querySelector("#save-panel")),
  presetSaveOpen: /** @type {HTMLButtonElement} */ (document.querySelector("#preset-save-open")),
  presetSaveReason: /** @type {HTMLElement} */ (document.querySelector("#preset-save-reason")),
  presetSaveClose: /** @type {HTMLButtonElement} */ (document.querySelector("#preset-save-close")),
  presetSaveSubmit: /** @type {HTMLButtonElement} */ (
    document.querySelector("#preset-save-submit")
  ),
  presetSaveIconSave: /** @type {SVGElement} */ (document.querySelector("#preset-save-icon-save")),
  presetSaveIconReplace: /** @type {SVGElement} */ (
    document.querySelector("#preset-save-icon-replace")
  ),
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
const openCycles = new Set();
/**
 * The stretch of the tempo range the current run travels through, while it is
 * travelling it, and null the rest of the time — including under a Flat, which
 * changes tempo without passing through anything on the way.
 *
 * The tempo the readout is sized from while the number is moving, and null while
 * it is not. Both are remembered rather than passed because the readout is drawn
 * from two places — a full render, and the per-frame write that follows a live
 * tempo — and the two have to agree.
 */
let tempoBand = null;
let heldTempo = null;
let state = loadState();
let savedPresets = readSavedPresets() ?? createSavedPresets();
let description = describeConfiguration(state);
const {
  meterCounts: METER_COUNTS,
  meterUnits: METER_UNITS,
  repetitions: REPETITIONS,
  sounds: SOUNDS,
  subdivisions: SUBDIVISIONS,
} = description.choices;
let presetsOpen = false;
let helpOpen = false;
let savePanelOpen = false;
/**
 * The Preset this Configuration came from — applied from the panel, or written
 * by the last save — and the snapshot it held at that moment. It answers two
 * questions the interface cannot ask any other way: what to put in the name
 * field, and whether anything has changed since, which is whether there is
 * anything to save at all. Null until a Preset is involved, which is why a
 * Configuration restored from storage on a fresh visit is savable.
 */
let presetOrigin = null;
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
 *
 * The raw value goes to `createStoredPresets` unparsed, because only the raw
 * value separates a key this browser has never written from one deliberately
 * emptied. The first is a first run and is seeded with the example Presets,
 * written back here at once so that every later read is an ordinary one. The
 * second is someone who deleted their last Preset, and seeding it would hand
 * back what they just removed.
 *
 * Clearing this origin's storage therefore seeds again — from here there is
 * nothing to tell that apart from a browser opening Polynome for the first time,
 * and inventing a difference would mean remembering, in this tab alone, that
 * Presets once existed.
 */
function readSavedPresets() {
  let raw = null;
  try {
    raw = readStoredValue({
      storage: localStorage,
      key: PRESET_STORAGE_KEY,
      retiredKeys: RETIRED_PRESET_STORAGE_KEYS,
    });
  } catch {
    // Resolving the browser's storage property can itself be forbidden.
    return null;
  }
  const presets = createStoredPresets(raw);
  if (raw === null) writeSavedPresets(presets);
  return presets;
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

function restoreFactoryPresets() {
  pendingDeletePresetId = null;
  adoptSavedPresets(createFactoryPresets());
  const persisted = writeSavedPresets(savedPresets);
  elements.status.textContent = persisted
    ? "Factory presets restored"
    : "Factory presets could not be restored in this browser";
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
  if (options.render !== false) renderInterface();
  // Whether there is anything to save is a function of the Configuration, so it
  // has to follow every edit — including the ones that skip the full render to
  // keep a pointer drag cheap. This is one comparison against one remembered
  // snapshot and a handful of attribute writes, not a pass over stored Presets.
  else renderPanels();

  if (options.deferConsequence) return result;
  engine.applyConsequence(result.consequence, state)?.catch(showError);
  return result;
}

function renderInterface() {
  renderPanels();
  renderTransport();
  renderPresetPanel();
  renderCycles();
  renderFooter();
}

/**
 * Whether the current Configuration has moved since the Preset it came from.
 * One comparison against the remembered snapshot, not one per stored Preset:
 * this runs on every render, including every step click and every pointer move
 * of a tempo drag.
 *
 * A Configuration with no Preset behind it counts as unsaved. That covers a
 * first visit and anything restored from storage, both of which the user may
 * well want to keep.
 */
function hasUnsavedChanges() {
  return presetOrigin === null || !sameConfiguration(state, presetOrigin.configuration);
}

function renderPanels() {
  elements.presetPanel.hidden = !presetsOpen;
  elements.presetsToggle.setAttribute("aria-expanded", String(presetsOpen));
  elements.presetsToggle.classList.toggle("is-active", presetsOpen);
  elements.helpPanel.hidden = !helpOpen;
  elements.helpToggle.setAttribute("aria-expanded", String(helpOpen));
  elements.helpToggle.classList.toggle("is-active", helpOpen);
  elements.presetSavePanel.hidden = !savePanelOpen;
  elements.presetSaveOpen.setAttribute("aria-expanded", String(savePanelOpen));
  elements.presetSaveOpen.classList.toggle("is-active", savePanelOpen);
  // Nothing to save is not a reason to hide the way in, so this marks the chip
  // unavailable rather than removing it: it stays where the user learned it is,
  // and says why it will not act.
  //
  // `aria-disabled` rather than `disabled`, because the saying is the point and
  // `disabled` reaches nobody with it. A disabled control leaves the tab order,
  // so a keyboard user meets it as an absence rather than as a control with a
  // reason, and `title` on a button that already has text is a description
  // screen readers commonly skip. Marked unavailable, the chip keeps its place
  // and its focus, and the reason is a described-by the accessibility tree
  // carries. Nothing enforces it, so the click handler declines for itself.
  const unsaved = hasUnsavedChanges();
  elements.presetSaveOpen.setAttribute("aria-disabled", String(!unsaved && !savePanelOpen));
  // Enabled is not a state anyone reads in a row of chips: it looks exactly like
  // the neighbour that is always live. Something to save is worth saying, so the
  // chip takes the accent for as long as there is.
  elements.presetSaveOpen.classList.toggle("is-live", unsaved);
  const saveReason = unsaved ? "Save this setup as a preset" : "No changes to save";
  elements.presetSaveOpen.title = saveReason;
  elements.presetSaveReason.textContent = saveReason;
}

/**
 * The large readout changes mode with playback rather than moving: stopped it
 * displays and edits the Preset's starting tempo, playing it displays the tempo
 * the envelopes are producing right now.
 *
 * The live number stays at full strength — it is the playback indicator, and
 * dimming the one thing a listener is watching would be backwards. What has to
 * be unmistakable is that it cannot be typed into, so the number is `readonly`
 * while the slider and both keys are genuinely `disabled`, which is the
 * treatment `button:disabled` already carries. The setters refuse as well, so
 * an event arriving from somewhere none of that covers still cannot edit the
 * starting tempo out from under a run.
 *
 * The starting tempo has nowhere to be shown once the number is live, so the
 * label slot carries it: `BPM` becomes a badge reading `BPM 100`. No
 * `aria-live` anywhere near it — the tempo changes continuously, and announcing
 * it would flood the buffer. `#status` still announces starting and stopping.
 */
function renderTransport() {
  const playing = engine.playing;
  const displayedBpm = playing ? Math.round(engine.activeBpm() ?? state.bpm) : state.bpm;
  elements.bpm.value = String(displayedBpm);
  elements.bpmSlider.value = String(displayedBpm);
  elements.bpm.readOnly = playing;
  elements.bpm.setAttribute(
    "aria-label",
    `${playing ? "Current" : "Starting"} tempo in beats per minute`,
  );
  /*
   * Two different questions, and they used to be one.
   *
   * Whether the tempo moves at all decides the label and the readout's size: a
   * Sequence that holds one tempo throughout is already showing it in the large
   * number, and a readout sized from a number nobody is watching change has
   * nothing to hold still for. What is asked is whether the tempo moves, not
   * whether an envelope is written down somewhere — a Cycle switched off keeps
   * the envelope it was given and contributes none of it.
   *
   * Whether it *travels* decides the band, and only a ramp travels. A Flat jumps
   * from one tempo to the next and sounds neither of the ones between, so a bar
   * drawn across that gap would claim a stretch the run never plays.
   */
  const tempoMoves = playing && description.tempoRange.minimum !== description.tempoRange.maximum;
  const tempoTravels =
    playing &&
    state.sequence.cycles.some(
      (cycle, index) =>
        description.cycles[index].active &&
        cycle.envelope.amount &&
        cycle.envelope.shape !== ENVELOPE.FLAT,
    );

  elements.bpmLabel.textContent = tempoMoves ? String(state.bpm) : "BPM";
  elements.bpmLabel.classList.toggle("is-starting-tempo", tempoMoves);
  // The tempo the run opens on, which is not always the one the Preset stores:
  // a Flat spends its whole change on the first beat, so a Sequence starting on
  // Flat +60 at 96 plays 156 from the outset and never sounds 96 at all. Sizing
  // the glyphs from a tempo nobody hears is a smaller wrong than sizing them
  // from one that keeps changing, but it is still one.
  heldTempo = tempoMoves ? description.cycles.find(({ active }) => active).startBpm : null;
  elements.bpmTicks.classList.toggle("is-banded", tempoTravels);
  tempoBand = tempoTravels ? description.tempoRange : null;
  elements.bpmSlider.disabled = playing;
  elements.bpmDown.disabled = playing;
  elements.bpmUp.disabled = playing;
  // A key at the end of the range says so rather than being left live and
  // silent — but marked unavailable rather than `disabled`, for the reason the
  // save chip is: `disabled` leaves the tab order. This key disables itself
  // under the user, at the end of a hold they are still pressing, so taking it
  // out of that order drops focus to the document and restarts the next Tab
  // from the top of the panel. No described-by here, unlike the chip: what
  // would be said is the bound, and the readout beside it is already saying it.
  //
  // Marking states and does not enforce. Nothing extra declines the press,
  // because the hold already does: `stepTempo` reports a tempo that did not
  // move, which is what the edit returns at either bound.
  elements.bpmDown.setAttribute(
    "aria-disabled",
    String(playing || state.bpm <= TEMPO_LIMIT.minimum),
  );
  elements.bpmUp.setAttribute("aria-disabled", String(playing || state.bpm >= TEMPO_LIMIT.maximum));
  renderDisplayedTempo(displayedBpm);
  updatePlayButton();
}

/**
 * Where a tempo sits in the range the control offers, as a fraction, counted
 * from the limit rather than from a pair of numbers restated here.
 */
function tempoFraction(bpm) {
  const span = TEMPO_LIMIT.maximum - TEMPO_LIMIT.minimum;
  return Math.min(1, Math.max(0, (bpm - TEMPO_LIMIT.minimum) / span));
}

/**
 * Everything the readout draws from a tempo rather than from the state behind
 * it: the size of the glyphs, the gap above them, the glitch at the top of the
 * range, how far the track is filled, and how much of the tick row is lit.
 *
 * Which tempo, though, is not always the one on screen. While an envelope is
 * moving the number, letting the glyphs swell and shrink with it turns a reading
 * into an animation — the one thing on the panel a listener is trying to read
 * becomes the one thing that will not sit still — so the run's own starting
 * tempo sizes them instead.
 *
 * The marks answer the band rather than the size: under a ramp they light the
 * stretch being travelled, with a bar drawn through them at the tempos
 * themselves for the resolution a tenth-of-the-range mark cannot carry, and
 * under a Flat, which travels nothing, they go on marking where the tempo has
 * reached.
 */
function renderDisplayedTempo(displayedBpm) {
  const shapedBy = heldTempo ?? displayedBpm;
  const progress = tempoFraction(shapedBy);
  const size = 2.1 + progress * 2.1;
  const pixelSize = size * 16;
  const glitchIntensity = Math.min(1, Math.max(0, (shapedBy - 250) / 50));
  // Every length the readout uses is offered twice: the design value, and the
  // same value as a share of the transport card. The card is the size container,
  // and 1cqw is 5px at the 500px column this was drawn against, so taking the
  // value nearer zero holds the designed size up to that width and scales with
  // the card below it. A negative length needs `max()` to shrink toward zero
  // rather than away from it, which is why the comparator follows the sign.
  const cq = (px) => `${(px / 5).toFixed(2)}cqw`;
  const fit = (px) => `${px < 0 ? "max" : "min"}(${px}px, ${cq(px)})`;
  const readout = elements.bpmReadout.style;
  readout.setProperty("--bpm-size", `min(${size}rem, ${cq(pixelSize)})`);
  // Derived from the resolved glyph size rather than recomputed in pixels. Both
  // branches of `--bpm-size` above are the same length as `pixelSize` while the
  // root is the 16px this was drawn against, so this is the value the pixel
  // arithmetic used to produce — but it stays the width of the digits when a
  // reader raises their browser's default text size and the `rem` branch grows.
  // The box is what centres the number in the track, so it has to be the width
  // of what it holds or the centring is off by whatever the difference is.
  readout.setProperty("--bpm-width", "calc(var(--bpm-size) * 0.86 * 3)");
  // The label sits above the number's box, and the gap a reader sees is to the
  // ink rather than to that box: half the leading, the block padding, and the
  // display font's own ascent above its capitals all sit between the two, and
  // every one of them is a share of the glyph size. Measured, they add 0.389px
  // per pixel of type, so a margin pulling back less than that per pixel leaves
  // the gap growing with the tempo — which the earlier 0.255 did, opening it
  // from 11px at 30bpm to 16px at 300. These two close it slightly instead,
  // from 11px to 9px across the same range.
  //
  // Both figures are measured at a 16px root, which is what `pixelSize` assumes
  // and what the margin resolves against: the margin is a length in pixels
  // while the glyphs it answers are sized in `rem`, so a reader who raises
  // their default text size still sees the gap open, by roughly 0.08px per
  // pixel of type rather than the 0.22px it was. Closing that last part means
  // expressing the margin in the same unit as the type, which is a change to
  // how the whole readout is sized rather than to this line.
  readout.setProperty("--bpm-label-margin", fit(13.4 - pixelSize * 0.46));
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
  // The band is placed from the two tempos themselves rather than from the marks
  // nearest them, which is the whole of why it is a bar: the ticks are a tenth
  // of the range apart, and a ramp shorter than that either lands on one of them
  // or on none.
  const ticks = elements.bpmTicks.style;
  if (tempoBand) {
    ticks.setProperty("--band-start", `${tempoFraction(tempoBand.minimum) * 100}%`);
    ticks.setProperty("--band-end", `${tempoFraction(tempoBand.maximum) * 100}%`);
  } else {
    ticks.removeProperty("--band-start");
    ticks.removeProperty("--band-end");
  }
  elements.bpmTicks.querySelectorAll("span").forEach((tick) => {
    const bpm = Number(tick.dataset.bpm);
    const lit = tempoBand
      ? bpm >= tempoBand.minimum && bpm <= tempoBand.maximum
      : bpm <= displayedBpm;
    tick.classList.toggle("is-passed", lit);
  });
}

function PresetList({ presets, pendingDeleteId }) {
  return html`${presets.map(
    (preset) => html`
    <div class="preset-card" key=${preset.id}>
      <button
        type="button"
        class="preset-button${preset.selected ? " is-selected" : ""}"
        data-preset-id=${preset.id}
        aria-pressed=${String(preset.selected)}
      >
        <strong>${preset.name}</strong>
        <${PresetNotation} configuration=${preset.configuration} />
      </button>
      <button
        type="button"
        class="preset-delete${preset.id === pendingDeleteId ? " is-armed" : ""}"
        data-delete-preset-id=${preset.id}
        aria-label=${`${preset.id === pendingDeleteId ? "Confirm deleting" : "Delete"} ${preset.name} preset`}
        title=${preset.id === pendingDeleteId ? "Select again to delete" : "Delete preset"}
      >×</button>
    </div>
  `,
  )}`;
}

/**
 * The heading states how many Presets there are, so it belongs to the stored
 * list rather than to the panel: `index.html` ships a number for the first
 * paint, and every load after the first can contradict it. This is deliberately
 * outside the render below, which the early return skips while the panel is
 * closed — counting is `savedPresets.length`, and none of the work that early
 * return exists to avoid is needed to know it.
 */
function renderPresetCount() {
  elements.presetCount.textContent = String(savedPresets.length);
  // The heading shows the bare number; the noun is carried as visually hidden
  // text because `aria-label` on a generic span never reaches the accessibility
  // tree.
  elements.presetCountNoun.textContent = savedPresets.length === 1 ? " preset" : " presets";
}

/**
 * A level or balance drag re-renders on every pointer move, and describing this
 * list costs a repair pass over every stored Configuration — on the same thread
 * as the scheduler. Reconciliation makes the DOM half cheap; it cannot make the
 * describing half free. The panel is closed for almost all of that, so the
 * toggle renders it on the way open and nothing here runs for a panel nobody can
 * see. That decision is about not doing the work at all, which is the one thing
 * no renderer can take over.
 *
 * The tempo drag used to be the other half of this, and is no longer: the
 * starting tempo cannot be moved while a run is playing, so that gesture never
 * meets the scheduler at all. A mix drag still can, which is what this is for.
 */
function renderPresetPanel() {
  if (!presetsOpen) return;
  const presets = describePresets(state, savedPresets);
  const hadFocus = elements.presetList.contains(document.activeElement);
  render(
    html`<${PresetList} presets=${presets} pendingDeleteId=${pendingDeletePresetId} />`,
    elements.presetList,
  );
  // The one focus case reconciliation cannot answer: a surviving node keeps its
  // focus, but a Preset that stopped existing takes its button with it and the
  // browser drops focus to the document, which is where a keyboard user least
  // expects to be. The close control is the nearest thing that is always here.
  if (hadFocus && document.activeElement === document.body) {
    elements.presetsClose.focus();
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
  renderPresetPanel();
}

/**
 * The Configuration here has already been through repair — every door into
 * stored Presets goes through `createConfiguration` first — so it has the same
 * Cycles in the same order as the description below, and the position is the
 * Cycle. Reading by id would be the fragile choice rather than the careful one:
 * repair replaces a duplicate identifier, so two Cycles that arrived sharing one
 * would both find the first description and the second would report the first's
 * envelope as its own.
 */
function PresetNotation({ configuration }) {
  const tempoDescriptions = describeConfiguration(configuration).cycles;
  const accessible = configuration.sequence.cycles
    .map((cycle, index) => {
      const rhythms = cycle.rhythms
        .map(
          (rhythm) =>
            `${rhythmLabel(rhythm)}, ${subdivisionLabel(rhythm.subdivision, rhythm.signature.unit)}`,
        )
        .join(" plus ");
      const envelope = tempoDescriptions[index].accessibleNotation;
      return `${cycle.repetitions} ${cycle.repetitions === 1 ? "repetition" : "repetitions"} of ${rhythms}${envelope ? `, ${envelope}` : ""}`;
    })
    .join(", then ");
  return html`
    <span class="preset-notation" aria-hidden="true">
      ${configuration.sequence.cycles.map(
        (cycle, index) => html`
        ${index === 0 ? null : html`<span class="preset-sequence-arrow" aria-hidden="true"> → </span>`}
        <span class="preset-cycle">
          ${cycle.repetitions === 1 ? null : html`<span class="preset-repetitions">${cycle.repetitions}×</span>`}
          ${cycle.rhythms.map(
            (rhythm, position) => html`
            ${position === 0 ? null : html`<span aria-hidden="true"> + </span>`}
            <span class="preset-rhythm">
              <span>${rhythmLabel(rhythm)}</span>
              <${NoteIcon} subdivision=${rhythm.subdivision} height=${15} />
            </span>
          `,
          )}
          ${
            tempoDescriptions[index].notation
              ? html`<span class="preset-envelope"> ${tempoDescriptions[index].notation}</span>`
              : null
          }
        </span>
      `,
      )}
    </span>
    <span class="sr-only">${accessible}</span>
  `;
}

function renderCycles() {
  render(html`<${Cycles} cycles=${state.sequence.cycles} />`, elements.cycles);
  // A redraw is what the record of the last draw stops describing. Reconciliation
  // rewrites the class of any control whose voice changed, which takes the
  // playhead's highlight off it, and a record kept across that would answer for a
  // draw the grid no longer holds — leaving the highlight missing until the next
  // onset moves it elsewhere. Clearing it here is one pass over what was just
  // rendered, and it keeps the per-frame loop free of the reads it goes out of
  // its way to avoid.
  elements.cycles.querySelectorAll("[data-active-step]").forEach((element) => {
    element.removeAttribute("data-active-step");
  });
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
    const stepsPerBeat = Number(steps.dataset.stepsPerBeat);
    const perRow =
      descendingDivisors(beats).find(
        (candidate) =>
          candidate * stepsPerBeat <= STEPS_PER_ROW_LIMIT &&
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
 * Only structural edits can change whether a cycle may be added, and those all
 * re-render in full, so the paths that skip renderInterface() to redraw the
 * transport, presets, or a single mix output cannot leave this stale.
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

function Cycles({ cycles }) {
  return html`${cycles.map(
    (cycle, index) => html`
    <${CycleGroup} key=${cycle.id} cycle=${cycle} cycleIndex=${index} cycleCount=${cycles.length} />
  `,
  )}`;
}

/**
 * What a repetition dot's press writes. A dot sets the count it stands for, and
 * the dot at the current count switches the Cycle off instead — except where
 * switching off would leave the Sequence with no active Cycle at all. There the
 * press writes the count it stands for, which is the count already showing.
 *
 * The alternative was `disabled`, and it was worse than doing nothing: that dot
 * is the selected one, so the global dimming for a disabled control took the
 * only lit dot in the row down to the strength of an unlit one, and a Cycle
 * playing its single repetition read as a Cycle switched off. The rule holds
 * either way — `changeConfiguration` is what enforces it — so this is a choice
 * about which press to offer, not about which to allow.
 */
function repetitionsForDot(cycle, value, cycleAvailability) {
  const switchesOff = cycle.repetitions === value;
  return switchesOff && cycleAvailability.repetitions[value - 1].available ? value - 1 : value;
}

function CycleGroup({ cycle, cycleIndex, cycleCount }) {
  const cycleAvailability = description.availability.cycles[cycle.id];
  const cycleTitle = cycleCount > 1 ? `Cycle ${cycleIndex + 1}` : "Cycle";
  const addRhythmLabel = unavailableLabel("+ Rhythm", cycleAvailability.addRhythm);
  const open = openCycles.has(cycle.id);
  const drawerId = `cycle-${cycle.id}-settings`;
  const tempoDescription = description.cycles.find(({ id }) => id === cycle.id);
  return html`
    <section
      class="cycle-group${cycle.repetitions === 0 ? " is-inactive" : ""}"
      data-cycle-id=${cycle.id}
      aria-labelledby=${`cycle-${cycle.id}-heading`}
    >
      <article class="cycle-card">
        <div class="card-heading cycle-heading">
          <h2 id=${`cycle-${cycle.id}-heading`}>${cycleTitle}<span class="cycle-divider" aria-hidden="true">/</span><span class="heading-count">${cycle.repetitions}</span>${cycle.repetitions === 0 ? html`<span class="sr-only"> inactive</span>` : null}</h2>
          <!-- The same wrapper the rhythm heading uses, because it means the
               same thing: the controls at the end of a card heading. It carries
               their 36px sizing and pushes the pair to the right, which is what
               the lone remove button used to do for itself. -->
          <div class="rhythm-actions">
            <button
              type="button"
              class="icon-button edit-button${open ? " is-active" : ""}"
              data-action="toggle-cycle-settings"
              aria-expanded=${String(open)}
              aria-controls=${drawerId}
              aria-label=${`Edit ${cycleTitle} envelope`}
            ><${PencilIcon} /></button>
            <button
              type="button"
              class="icon-button remove-button"
              data-action="remove-cycle"
              aria-label=${`Remove ${cycleTitle}`}
              disabled=${!cycleAvailability.remove.available}
            >×</button>
          </div>
        </div>

        <!-- Between the heading and the dots, for the reason the rhythm
             settings pane sits between its heading and its steps: it opens
             directly under the control that was activated. -->
        <div id=${drawerId} class="cycle-settings" hidden=${!open}>
          <${CycleSettings} cycle=${cycle} cycleTitle=${cycleTitle} tempo=${tempoDescription?.tempo} />
        </div>
        <!-- The Cycle's length and, once the drawer that sets it is closed, what
             its tempo does across that length. The mark is a sibling of the
             dots rather than one of them: it belongs to the row, not to the
             group of repetition controls the row is mostly made of. -->
        <div class="repeat-row">
          <div class="repeat-dots" role="group" aria-label=${`${cycleTitle} repetitions`}>
            ${REPETITIONS.slice(1).map((value, index) => {
              const selected = value <= cycle.repetitions;
              const nextRepetitions = repetitionsForDot(cycle, value, cycleAvailability);
              const actionLabel =
                nextRepetitions === 0
                  ? `Disable ${cycleTitle}`
                  : `Set ${cycleTitle} to ${nextRepetitions} ${nextRepetitions === 1 ? "repetition" : "repetitions"}`;
              return html`
                <button
                  type="button"
                  class="repeat-dot${selected ? " is-set" : ""}"
                  data-action="set-repetitions"
                  data-repetitions=${value}
                  data-repetition-index=${index}
                  aria-label=${actionLabel}
                  aria-pressed=${String(selected)}
                ></button>
              `;
            })}
          </div>
          ${
            open || !tempoDescription?.notation
              ? null
              : html`<button
                  type="button"
                  class="icon-button envelope-mark"
                  data-action="toggle-cycle-settings"
                  aria-controls=${drawerId}
                  aria-expanded="false"
                  aria-label=${`Edit ${cycleTitle} envelope, ${tempoDescription.accessibleNotation}`}
                ><${EnvelopeGlyph} shape=${cycle.envelope.shape} /></button>`
          }
        </div>
      </article>

      <div class="rhythm-list">
        ${cycle.rhythms.map(
          (rhythm) => html`
          <${RhythmCard} key=${rhythm.id} rhythm=${rhythm} cycle=${cycle} />
        `,
        )}
      </div>
      <button
        type="button"
        class="chip-button add-rhythm"
        data-action="add-rhythm"
        aria-label=${addRhythmLabel}
        disabled=${!cycleAvailability.addRhythm.available}
      >+ Rhythm</button>
    </section>
  `;
}

/**
 * Each shape's line drawn in one 34×18 box, so the four sit on a common
 * baseline and read as one set: a level line, a rise, a fall, and a rise that
 * comes back. The word beside each glyph is the accessible name, which is why
 * the drawing itself is hidden from the tree rather than labelled.
 */
const ENVELOPE_GLYPH_POINTS = lookup({
  [ENVELOPE.FLAT]: "2,9 32,9",
  [ENVELOPE.UP]: "2,15 32,4",
  [ENVELOPE.DOWN]: "2,4 32,15",
  [ENVELOPE.PEAK]: "2,15 17,3 32,15",
});

function EnvelopeGlyph({ shape }) {
  return html`<svg
    class="segment-glyph"
    viewBox="0 0 34 18"
    width="26"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  ><polyline points=${ENVELOPE_GLYPH_POINTS[shape]}></polyline></svg>`;
}

/**
 * A negative amount is written with U+2212 MINUS SIGN, as the tempo keys are,
 * so the field reads as typography rather than as a hyphenated word. What it
 * writes it must also read, and a hyphen is what most keyboards offer first, so
 * both are accepted going the other way.
 */
function envelopeAmountText(amount) {
  return amount < 0 ? `−${Math.abs(amount)}` : String(amount);
}

function envelopeAmountValue(text) {
  return String(text).replace(/−/g, "-").trim();
}

/**
 * Three controls and nothing else. The unit is stated once, in the group label,
 * which is why neither control after it repeats it — and why there is no range
 * hint, no badge and no prose: the shape, the number and the result are the
 * whole of what an envelope is.
 */
function CycleSettings({ cycle, cycleTitle, tempo }) {
  const shapeLabelId = `cycle-${cycle.id}-envelope-label`;
  const { shape, amount } = cycle.envelope;
  return html`
    <div class="timing-settings">
      <div class="segmented-control" role="group" aria-labelledby=${shapeLabelId}>
        <span id=${shapeLabelId}>BPM Envelope</span>
        <div>${Object.values(ENVELOPE).map(
          (candidate) => html`
          <button
            type="button"
            class="segment-button${candidate === shape ? " is-selected" : ""}"
            data-action="envelope-shape"
            data-envelope-shape=${candidate}
            aria-pressed=${String(candidate === shape)}
          ><${EnvelopeGlyph} shape=${candidate} />${candidate[0].toUpperCase()}${candidate.slice(1)}</button>
        `,
        )}</div>
      </div>

      <label class="control-label envelope-amount">
        <span>Amount</span>
        <input
          type="text"
          inputmode="numeric"
          autocomplete="off"
          value=${envelopeAmountText(amount)}
          data-field="envelope-amount"
          aria-label=${`${cycleTitle} tempo change in beats per minute`}
        />
      </label>

      <label class="control-label envelope-tempo">
        <span>Tempo</span>
        <output>${tempo}</output>
      </label>
    </div>
  `;
}

function RhythmCard({ rhythm, cycle }) {
  const label = rhythmLabel(rhythm);
  const drawerId = `rhythm-${rhythm.id}-settings`;
  const open = openRhythms.has(rhythm.id);
  const removable = description.availability.cycles[cycle.id].rhythms[rhythm.id].remove.available;
  return html`
    <article class="rhythm-card${rhythm.muted ? " is-muted" : ""}" data-layer-id=${rhythm.id}>
      <div class="card-heading rhythm-heading">
        <button
          type="button"
          class="rhythm-identity"
          data-action="toggle-settings"
          aria-expanded=${String(open)}
          aria-controls=${drawerId}
        >
          <strong>${label}</strong><span aria-hidden="true">/</span><${NoteIcon} subdivision=${rhythm.subdivision} height=${21} />
          <span class="sr-only">${`Edit ${label} rhythm`}</span>
        </button>
        <div class="rhythm-actions">
          <button
            type="button"
            class="icon-button${rhythm.muted ? " is-active" : ""}"
            data-action="mute"
            aria-pressed=${String(rhythm.muted)}
            aria-label=${`${rhythm.muted ? "Unmute" : "Mute"} ${label}`}
          >M</button>
          <button
            type="button"
            class="icon-button edit-button${open ? " is-active" : ""}"
            data-action="toggle-settings"
            aria-expanded=${String(open)}
            aria-controls=${drawerId}
            aria-label=${`Edit ${label}`}
          ><${PencilIcon} /></button>
          <button
            type="button"
            class="icon-button remove-button"
            data-action="remove-rhythm"
            aria-label=${`Remove ${label}`}
            disabled=${!removable}
          >×</button>
        </div>
      </div>

      <!-- The settings pane sits between the heading and the steps, so opening
           it from either control in that heading reveals it directly under the
           control that was activated rather than below a step grid whose height
           varies with the Meter. The steps keep their place on screen relative
           to the card's own bottom edge. -->
      <div id=${drawerId} class="rhythm-settings" hidden=${!open}>
        <${RhythmSettings} rhythm=${rhythm} />
      </div>

      <!-- The controls each beat holds are carried for layoutSteps(), which
           reads the number to choose how many beats share a row. It is the
           Subdivision in Subdivision Mode and one in Beat Mode, which is why it
           is not named for the Subdivision: what the row fits is controls. The
           Subdivision was carried a second time as a custom property the
           beat-gap clamp calculated with; that gap is now the same one the steps
           inside a beat use, so nothing in the stylesheet asks for it any
           more. -->
      <div
        class="steps"
        role="group"
        aria-label=${`${label} ${rhythm.displayMode === "beat" ? "beat" : "step"} voices`}
        data-beats=${rhythm.signature.count}
        data-steps-per-beat=${rhythm.displayMode === "beat" ? 1 : rhythm.subdivision}
        data-display-mode=${rhythm.displayMode}
      >
        <${Beats} rhythm=${rhythm} />
      </div>
    </article>
  `;
}

// Both Meter components are selects, so the only thing that differs between
// them is which list of choices they offer.
function MeterField({ field, value, name, choices }) {
  return html`
    <select data-field=${field} aria-label=${name} value=${String(value)}>
      ${choices.map((choice) => html`<option value=${String(choice)}>${choice}</option>`)}
    </select>
  `;
}

function RhythmSettings({ rhythm }) {
  const label = rhythmLabel(rhythm);
  const subdivisionMenuId = `rhythm-${rhythm.id}-subdivision-menu`;
  const subdivisionOpen = openSubdivisionMenu === rhythm.id;
  return html`
    <div class="timing-settings">
      <label class="control-label">
        <span>Signature</span>
        <span class="signature-input">
          <${MeterField}
            field="signature-count"
            value=${rhythm.signature.count}
            name=${`${label} meter numerator`}
            choices=${METER_COUNTS}
          />
          <span aria-hidden="true">/</span>
          <${MeterField}
            field="signature-unit"
            value=${rhythm.signature.unit}
            name=${`${label} meter denominator`}
            choices=${METER_UNITS}
          />
        </span>
      </label>

      <div class="control-label subdivision-control">
        <span>Subdivision</span>
        <div class="notation-picker">
          <button
            type="button"
            class="notation-select"
            data-action="toggle-subdivision-menu"
            aria-label=${`${label} subdivision`}
            aria-haspopup="listbox"
            aria-expanded=${String(subdivisionOpen)}
            aria-controls=${subdivisionMenuId}
          >
            <span><${NoteIcon} subdivision=${rhythm.subdivision} height=${27} /></span>
            <span aria-hidden="true">▼</span>
          </button>
          <div
            id=${subdivisionMenuId}
            class="subdivision-menu"
            role="listbox"
            aria-label=${`${label} subdivision`}
            hidden=${!subdivisionOpen}
          >
            ${SUBDIVISIONS.map(
              (subdivision) => html`
              <button
                type="button"
                role="option"
                class="subdivision-option${subdivision === rhythm.subdivision ? " is-selected" : ""}"
                data-action="set-subdivision"
                data-subdivision=${subdivision}
                aria-selected=${String(subdivision === rhythm.subdivision)}
                aria-label=${subdivisionLabel(subdivision, rhythm.signature.unit)}
                title=${subdivisionLabel(subdivision, rhythm.signature.unit)}
              ><${NoteIcon} subdivision=${subdivision} height=${26} /></button>
            `,
            )}
          </div>
        </div>
      </div>

      <div class="segmented-control" role="group" aria-labelledby=${`rhythm-${rhythm.id}-steps-label`}>
        <span id=${`rhythm-${rhythm.id}-steps-label`}>Steps</span>
        <div>
          <button
            type="button"
            data-action="display-mode"
            data-display-mode="beat"
            class="segment-button${rhythm.displayMode === "beat" ? " is-selected" : ""}"
            aria-pressed=${String(rhythm.displayMode === "beat")}
          >Beat</button>
          <button
            type="button"
            data-action="display-mode"
            data-display-mode="subdivision"
            class="segment-button${rhythm.displayMode === "subdivision" ? " is-selected" : ""}"
            aria-pressed=${String(rhythm.displayMode === "subdivision")}
            aria-label="Subdivision"
          >Sub</button>
        </div>
      </div>

      <div class="segmented-control" role="group" aria-labelledby=${`rhythm-${rhythm.id}-sound-label`}>
        <span id=${`rhythm-${rhythm.id}-sound-label`}>Sound</span>
        <div>${SOUNDS.map(
          (sound) => html`
          <button
            type="button"
            data-action="sound"
            data-sound=${sound}
            class="segment-button${rhythm.sound === sound ? " is-selected" : ""}"
            aria-pressed=${String(rhythm.sound === sound)}
          >${sound}</button>
        `,
        )}</div>
      </div>
    </div>

    <div class="mix-settings">
      <!-- Every range value is passed as a string, because the renderer decides
           whether to write one by comparing it against the control's own value,
           which is always a string: a number never matches and is rewritten on
           every render.

           The step comes from the model rather than being written out here as
           the hundredth it is, because the grid it sets is what decides which
           values these controls can hold at all: anything else is rounded onto
           it silently, so a default or a stored value off the grid arrives on
           screen as a different number than the one this Configuration is
           playing. A literal here would be a second answer to that question,
           sitting where nothing that could check it can reach. -->
      <label class="control-label">
        <span>Level <output class="sr-only" data-output="volume">${`${Math.round(rhythm.volume * 100)}%`}</output></span>
        <input type="range" min="0" max="1" step=${String(MIX_STEP)} value=${String(rhythm.volume)} data-field="volume" aria-label=${`${label} level`} />
      </label>
      <label class="control-label">
        <span>Balance <span class="balance-axis" aria-hidden="true">L · R</span><output class="sr-only" data-output="pan">${panLabel(rhythm.pan)}</output></span>
        <span class="balance-slider">
          <input type="range" min="-1" max="1" step=${String(MIX_STEP)} value=${String(rhythm.pan)} data-field="pan" aria-label=${`${label} stereo balance`} />
          <span class="balance-midpoint" aria-hidden="true"></span>
        </span>
      </label>
    </div>
  `;
}

// Steps are grouped a beat at a time so a narrow screen can only ever break
// between beats. `steps.length` is always `signature.count * subdivision`, so
// every group is full and no row is left ragged.
//
// Where a beat starts is marked by a dot the stylesheet draws on `.beat`
// itself, so nothing here emits it. The steps are evenly spaced and say
// nothing about grouping, and the first step of a bar cannot say it either:
// its voice is the listener's to change, and a downbeat switched off is the
// dimmest circle in the row. A pseudo-element keeps the mark out of the
// accessibility tree without an `aria-hidden` element to carry it, which is
// what a purely decorative mark inside a named group should be.
function Beats({ rhythm }) {
  const beats = [];
  for (let start = 0; start < rhythm.steps.length; start += rhythm.subdivision) {
    beats.push(
      rhythm.displayMode === "beat"
        ? [{ step: rhythm.steps[start], index: start, beat: start / rhythm.subdivision }]
        : rhythm.steps
            .slice(start, start + rhythm.subdivision)
            .map((step, offset) => ({ step, index: start + offset, beat: null })),
    );
  }
  return html`${beats.map(
    (group) => html`
    <div class="beat">
      ${group.map(
        ({ step, index, beat }) => html`<${Step} step=${step} index=${index} beat=${beat} />`,
      )}
    </div>
  `,
  )}`;
}

function Step({ step, index, beat }) {
  const beatMode = beat !== null;
  const number = beatMode ? beat + 1 : index + 1;
  const kind = beatMode ? "Beat" : "Step";
  return html`
    <button
      type="button"
      class="step step-${step}"
      data-action=${beatMode ? "beat" : "step"}
      data-step-index=${index}
      data-beat-index=${beatMode ? beat : null}
      aria-label=${`${kind} ${number}: ${step} voice`}
      title=${`${kind} ${number}: ${step}`}
    ></button>
  `;
}

function NoteIcon({ subdivision, height }) {
  const shown = subdivision <= 6 ? subdivision : 4;
  const beams =
    subdivision <= 1 ? 0 : subdivision <= 3 ? 1 : subdivision <= 6 ? 2 : subdivision <= 12 ? 3 : 4;
  const gap = shown > 4 ? 10 : 12;
  const headY = 31;
  const stemTop = 10;
  const x0 = 38 - ((shown - 1) * gap) / 2;
  const beamLeft = x0 + 3.7;
  const beamRight = x0 + (shown - 1) * gap + 5.4;
  const tuplet = ![1, 2, 4, 8, 16, 32].includes(subdivision);
  const tupletLeft = x0 - 2;
  const tupletRight = x0 + (shown - 1) * gap + 8;
  const arm = (tupletRight - tupletLeft) / 2 - 7;
  const left = Math.min(x0 - 5.6, tuplet ? x0 - 2.6 : Infinity);
  const right = Math.max(
    x0 + (shown - 1) * gap + 5.7,
    tuplet ? x0 + (shown - 1) * gap + 8.4 : -Infinity,
  );
  const top = tuplet ? 0 : 8.5;
  const boxWidth = right - left;
  const boxHeight = 35.5 - top;
  return html`
    <svg
      class="note-icon"
      viewBox=${`${left} ${top} ${boxWidth} ${boxHeight}`}
      width=${boxWidth * (height / boxHeight)}
      height=${height}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      ${Array.from({ length: shown }, (_, index) => {
        const x = x0 + index * gap;
        return html`
          <ellipse cx=${x} cy=${headY} rx="5" ry="3.7" transform=${`rotate(-22 ${x} ${headY})`}></ellipse>
          <rect x=${x + 3.7} y=${stemTop} width="1.7" height=${headY - stemTop} rx="0.6"></rect>
        `;
      })}
      ${Array.from(
        { length: beams },
        (_, index) => html`
        <rect x=${beamLeft} y=${stemTop + index * 5} width=${beamRight - beamLeft} height="3.2" rx="1"></rect>
      `,
      )}
      ${
        !tuplet
          ? null
          : html`
        <rect x=${tupletLeft} y="2.6" width=${arm} height="1.5" rx="0.7"></rect>
        <rect x=${tupletRight - arm} y="2.6" width=${arm} height="1.5" rx="0.7"></rect>
        <text x=${(tupletLeft + tupletRight) / 2} y="7" text-anchor="middle" font-size="9.5" font-weight="700" font-family="JetBrains Mono, monospace">${subdivision}</text>
      `
      }
    </svg>
  `;
}

function PencilIcon() {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"></path><path d="M14.5 6.5 17.5 9.5"></path></svg>`;
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
    elements.cycles.querySelectorAll("[data-active-step]").forEach((element) => {
      element.removeAttribute("data-active-step");
    });
    animationFrame = null;
    return;
  }

  const liveBpm = String(Math.round(engine.activeBpm() ?? state.bpm));
  if (elements.bpm.value !== liveBpm) {
    elements.bpm.value = liveBpm;
    elements.bpmSlider.value = liveBpm;
    renderDisplayedTempo(Number(liveBpm));
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
      const steps = card.querySelector(".steps");
      // What was drawn, not merely where the transport is: the display mode
      // decides how many controls there are and which one an absolute step falls
      // on, so a change of mode is a redraw the same absolute step still needs.
      // It names a control in the grid that was on screen when it was written,
      // and it is only ever the grid still on screen because `renderCycles`
      // clears it — a redraw can take the highlight off a control without the
      // transport having moved at all.
      const drawn = `${rhythm.displayMode}:${activeIndex}`;
      if (!steps || steps.getAttribute("data-active-step") === drawn) continue;
      steps.setAttribute("data-active-step", drawn);
      const controls = steps.querySelectorAll(".step");
      controls.forEach((element) => {
        element.classList.remove("is-current");
      });
      const visibleIndex =
        rhythm.displayMode === "beat" && activeIndex !== null
          ? Math.floor(activeIndex / rhythm.subdivision)
          : activeIndex;
      const current = controls[visibleIndex];
      if (!current) continue;
      current.classList.add("is-current");
      // A Beat control stays current for every pulse in its beat, so the class
      // it pulses on does not leave and come back and the browser has no reason
      // to begin the animation again. Restarting it through the animation itself
      // asks for a style recalculation and nothing more; reading a box back off
      // the element to force the same restart is a whole layout, once per onset
      // per Beat-Mode rhythm, in the loop `layoutSteps` goes out of its way to
      // keep layout out of.
      if (rhythm.displayMode !== "beat") continue;
      for (const animation of current.getAnimations()) {
        animation.cancel();
        animation.play();
      }
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
  if (engine.playing) return;
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

function toggleRhythmSettings(rhythmId) {
  // No refocus: both controls that carry this action survive reconciliation,
  // so the one the user activated still holds the focus it already had.
  if (openRhythms.has(rhythmId)) openRhythms.delete(rhythmId);
  else openRhythms.add(rhythmId);
  renderCycles();
}

/**
 * The pencil survives the redraw and can hold focus across it, which is why it
 * needs nothing said about it here. The envelope mark does not: it is only
 * drawn while the drawer is closed, so opening the drawer from it removes the
 * control that was pressed and drops focus to the document, and the next Tab
 * restarts from the top of the page. Focus goes to the pencil, which is the
 * other control for the drawer that was just opened.
 */
function toggleCycleSettings(cycleId, { refocus = false } = {}) {
  if (openCycles.has(cycleId)) openCycles.delete(cycleId);
  else openCycles.add(cycleId);
  renderCycles();
  if (!refocus) return;
  focusWithin(
    elements.cycles.querySelector(`[data-cycle-id="${CSS.escape(cycleId)}"]`),
    '[data-action="toggle-cycle-settings"]',
  );
}

/**
 * Closing the menu hides the option the user was on, and a hidden element
 * cannot hold focus, so it still has to be sent somewhere deliberate. The
 * notation select that opened it is where a menu dismissal is expected to land
 * — and reconciliation leaves that select in place, so there is nothing to wait
 * a frame for any more.
 */
function dismissSubdivisionMenu() {
  const rhythmId = openSubdivisionMenu;
  openSubdivisionMenu = null;
  renderCycles();
  focusWithin(elements.cycles, `[data-layer-id="${CSS.escape(rhythmId)}"] .notation-select`);
}

elements.play.addEventListener("click", togglePlayback);
elements.presetsToggle.addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  if (presetsOpen) {
    helpOpen = false;
    renderPresetPanel();
  }
  renderPanels();
});
elements.presetsClose.addEventListener("click", () => {
  presetsOpen = false;
  renderPanels();
  elements.presetsToggle.focus();
});
elements.helpToggle.addEventListener("click", () => {
  helpOpen = !helpOpen;
  // Three panels, and the rule is not that one is open at a time: Presets and
  // Save are two halves of the same subject and sit together. Help is a third
  // subject, so opening it closes both — including a save part way through
  // being named, which Escape and the close control already abandon.
  if (helpOpen) {
    presetsOpen = false;
    savePanelOpen = false;
  }
  renderPanels();
});
elements.bpm.addEventListener("change", (event) =>
  changeTempo(/** @type {HTMLInputElement} */ (event.target).value),
);
/**
 * The slider reports whatever tempo the pointer is over and the Configuration
 * takes it as it comes. Nothing here rounds it toward the tick row's tenths: the
 * slider's own step is five BPM, which is finer than the two either side of a
 * mark such a snap could catch, so it would move no value the control is able to
 * produce. The row below the slider is a scale rather than a set of stops.
 */
elements.bpmSlider.addEventListener("input", (event) => {
  // While playing the slider tracks the live tempo rather than setting one, so
  // an input event here is the render's own write coming back, or a gesture the
  // `disabled` attribute did not catch. Either way it is not an edit.
  if (engine.playing) return;
  const dragged = /** @type {HTMLInputElement} */ (event.target).value;
  applyEdit({ type: "set-tempo", bpm: dragged }, { deferConsequence: true, render: false });
  // The grid is deliberately not re-rendered under a drag, so this is what keeps
  // everything the tempo is spoken by in step with the thumb: the number in the
  // readout above it, the stepper keys marking themselves unavailable at either
  // bound, and the type size and glitch the tempo drives.
  renderTransport();
  renderPresetPanel();
});
/**
 * A slider drag and a held stepper key both defer the transport consequence, so
 * while either is in progress the run is still playing the tempo it started
 * with, and one of them has to hand it the new one. Comparing against that
 * tempo rather than a flag raised when the gesture began keeps the decision
 * correct even when it ends without a change event, because the next release
 * compares against what is actually sounding.
 */
function commitTempo() {
  if (engine.playing && state.bpm !== runBpm) {
    engine.restart(state).catch(showError);
  }
}
elements.bpmSlider.addEventListener("change", commitTempo);

/**
 * The stepper keys are the exact control the slider is not: a tap is one bpm,
 * and a hold accelerates so that a long move is still a press rather than a
 * drag. One step lands immediately, the first repeat after `HOLD_DELAY_MS`, and
 * every interval after that is the last one decayed toward the floor.
 */
const HOLD_DELAY_MS = 420;
const HOLD_DECAY = 0.72;
const HOLD_FLOOR_MS = 45;

let tempoHoldTimer = null;
let tempoHolding = false;

/**
 * Each step takes the slider drag's route through `applyEdit` rather than
 * writing `state.bpm`: the same clamp, the same repair, and the same deferral.
 * A `restart-transport-run` per repeat would begin a new run every 45ms at the
 * floor, and a run that never outlives its own look-ahead is one nobody hears.
 *
 * Reports whether the tempo actually moved. It has not when the press began at
 * the end of the range, which the edit declines rather than clamps.
 */
function stepTempo(delta) {
  if (engine.playing) return false;
  const result = applyEdit(
    { type: "set-tempo", bpm: state.bpm + delta },
    { deferConsequence: true, render: false },
  );
  renderTransport();
  renderPresetPanel();
  return result.consequence !== "none";
}

/**
 * The number field commits on its own `change` event, which the browser sends
 * only once focus has left it — and a pointer press on a key runs before the
 * focus shift that would produce it. Stepping from `state.bpm` there would step
 * from the tempo the field was last committed at, and the render that follows
 * writes that result back over the digits still on screen, so a typed tempo
 * would vanish without ever having been read.
 *
 * The keyboard reaches a hold with the key already focused, so the field has
 * committed by then and this finds nothing to do.
 */
function commitPendingTempo() {
  if (document.activeElement === elements.bpm) changeTempo(elements.bpm.value);
}

function endTempoHold() {
  if (!tempoHolding) return;
  tempoHolding = false;
  window.clearTimeout(tempoHoldTimer);
  tempoHoldTimer = null;
  commitTempo();
}

function startTempoHold(delta) {
  endTempoHold();
  commitPendingTempo();
  tempoHolding = true;
  const tick = (wait) => {
    if (!stepTempo(delta)) {
      // The end of the range: the edit declined rather than clamped, so there is
      // nothing left for the rest of this press to move. The release still
      // arrives — the key that got here is marked `aria-disabled` rather than
      // `disabled`, which is what keeps it in the tab order and, with it, in the
      // way of its own events — so ending here is not what saves the repeat from
      // outliving the press. It is what stops it spending the remainder of the
      // press on work that cannot have a product: a repeat at the floor wakes
      // roughly twenty-two times a second, and every wake is a whole
      // Configuration rebuilt by `changeConfiguration`'s repair only for
      // `set-tempo` to reject the value that asked for it, a storage write
      // pushed another `PERSIST_DELAY_MS` out of reach, and three renders of an
      // interface already showing the number they would write.
      endTempoHold();
      return;
    }
    tempoHoldTimer = window.setTimeout(
      () => tick(Math.max(HOLD_FLOOR_MS, wait * HOLD_DECAY)),
      wait,
    );
  };
  tick(HOLD_DELAY_MS);
}

const tempoKeys = /** @type {[HTMLButtonElement, number][]} */ ([
  [elements.bpmDown, -1],
  [elements.bpmUp, 1],
]);
for (const [stepper, delta] of tempoKeys) {
  stepper.addEventListener("pointerdown", (event) => {
    // Only the primary button of the primary pointer holds. The right button is
    // the press that makes refusing it necessary rather than tidy: the context
    // menu takes its release, so nothing ever reaches this key to end the repeat
    // and it runs unattended to the end of the range — a right click on −
    // arriving at 30 bpm. The slider above meets the same lost release and comes
    // to no harm from it: the flag it leaves raised only decides what an `input`
    // event does, and both things that produce one settle it first, a drag by
    // raising it and the keyboard by lowering it. What is left raised here is a
    // timer moving the tempo with nobody holding it, and nothing later can undo
    // where it got to.
    //
    // `isPrimary` refuses the other press that is not one: a second finger
    // landing on a key the first is still holding. `startTempoHold` ends the
    // hold in progress before starting its own, so an unrefused second contact
    // would commit the tempo mid-press and drop the acceleration back to its
    // slowest interval — the opposite of holding. A mouse is always primary,
    // so this costs that path nothing.
    if (event.button !== 0 || !event.isPrimary) return;
    // Capture keeps the repeat alive when the finger slides off the key, and
    // makes the release that ends it land back here rather than on whatever the
    // finger has wandered onto.
    stepper.setPointerCapture?.(event.pointerId);
    startTempoHold(delta);
  });
  // A press does not always end in a release this key sees: a gesture can be
  // cancelled out from under it, and focus can move mid-hold.
  for (const type of ["pointerup", "pointercancel", "pointerleave", "blur"]) {
    stepper.addEventListener(type, endTempoHold);
  }
  // The keyboard reaches the same hold rather than a separate single step, so
  // Space and Enter accelerate exactly as a finger does. The browser's own
  // click on release is left alone: nothing listens for it, which is what keeps
  // a tap from counting twice.
  stepper.addEventListener("keydown", (event) => {
    if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
    startTempoHold(delta);
  });
  stepper.addEventListener("keyup", endTempoHold);
}
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
      // No refocus: arming only changes attributes on a button that survives
      // reconciliation, so the focus the user already has on it is never lost.
      renderPresetPanel();
      elements.status.textContent = `Delete ${preset.name} preset? Select again to confirm`;
      return;
    }
    pendingDeletePresetId = null;
    const result = removeSavedPreset(storedSavedPresets(), presetId);
    // Another tab can remove a preset between this list being rendered and the
    // deletion being confirmed. Nothing is left to delete, but the button the
    // user just pressed is still on screen and owes them an answer.
    if (result.reason) {
      adoptSavedPresets(result.presets);
      elements.presetsClose.focus();
      elements.status.textContent = `${preset.name} preset was already deleted`;
      return;
    }
    adoptSavedPresets(result.presets);
    const persisted = writeSavedPresets(savedPresets);
    elements.presetsClose.focus();
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
  applyEdit({ type: "apply-preset", configuration: preset.configuration });
  // Recorded after the edit, from the Configuration the edit actually produced
  // rather than from the Preset's own copy: `apply-preset` regenerates every
  // identifier, and remembering the copy would leave the two comparing unequal
  // the instant they are compared.
  rememberPresetOrigin(preset.name);
  renderPanels();
});

function rememberPresetOrigin(name) {
  presetOrigin = { name, configuration: state };
}

/**
 * Whether the Preset the origin names is still stored, still under that name,
 * and still holding the snapshot it held when it was recorded. All three have to
 * be true for the origin to mean anything: either tab can delete a Preset, and
 * another tab can save over the name while leaving it there.
 */
function originIsStored() {
  if (presetOrigin === null) return false;
  return describePresets(presetOrigin.configuration, savedPresets).some(
    ({ name, selected }) => selected && name === presetOrigin.name,
  );
}

/**
 * The origin is a claim about what storage holds, and storage moves under it. A
 * Preset deleted here or in another tab leaves this pointing at something no
 * Preset carries any more, and a stale origin reads as nothing to save — which
 * is exactly backwards, because a Configuration whose Preset has just gone is
 * the one most worth keeping. Left alone, the chip stays inert and the only way
 * back to a save is an edit the user did not want to make.
 *
 * An origin that is still stored is kept rather than re-derived, so deleting
 * some other Preset does not take the name the save field opens on with it.
 */
function reconcilePresetOrigin() {
  if (originIsStored()) return;
  presetOrigin =
    describePresets(state, savedPresets)
      .filter(({ selected }) => selected)
      .map(({ name }) => ({ name, configuration: state }))[0] ?? null;
}

/**
 * Every route by which the stored Presets change under this tab — a deletion
 * here, and any write another tab makes — ends here, because what follows is the
 * same each time: the origin may have stopped naming anything, the heading
 * counts them, the list has to be redrawn, and the save chip's state is a
 * function of the origin, so the header has to follow the list. Saving is the
 * one write that does not come through here; it knows the origin it just
 * created, and re-deriving would only find it again.
 */
function adoptSavedPresets(presets) {
  savedPresets = presets;
  reconcilePresetOrigin();
  renderPresetCount();
  renderPresetPanel();
  renderPanels();
}

function nameToSaveUnder() {
  return presetOrigin ? presetOrigin.name : "";
}
/**
 * Saving under a name already in use replaces that Preset's snapshot. A
 * sentence under the field used to say so and nobody read it; the submit says it
 * instead, at the moment the typed name makes it true — as a glyph for a reader
 * who can see it and as the control's own name for one who cannot.
 */
function describeSaveAction() {
  const replaces = presetNameInUse(storedSavedPresets(), elements.presetName.value);
  elements.presetSaveSubmit.setAttribute("aria-label", replaces ? "Replace" : "Save");
  elements.presetSaveSubmit.title = replaces ? "Replace preset" : "Save preset";
  // `hidden` as a property belongs to HTMLElement, and these are SVG: assigning
  // it there sets a plain expando that never reaches the attribute the
  // stylesheet reads, and the glyph never changes.
  elements.presetSaveIconSave.toggleAttribute("hidden", replaces);
  elements.presetSaveIconReplace.toggleAttribute("hidden", !replaces);
}

function saveIsOffered() {
  return elements.presetSaveOpen.getAttribute("aria-disabled") !== "true";
}

function closeSavePanel({ focusToggle = true } = {}) {
  savePanelOpen = false;
  renderPanels();
  // Closing can be what makes the toggle inert — it is live only while there is
  // something to save — and it holds focus either way, because it is marked
  // unavailable rather than disabled. Focus stays on the control the panel came
  // from instead of being handed to a neighbour that had nothing to do with it.
  if (focusToggle) elements.presetSaveOpen.focus();
}

elements.presetSaveOpen.addEventListener("click", () => {
  // `aria-disabled` states, it does not enforce: the click still arrives, and a
  // control that says it will not act has to be the one that does not.
  if (!saveIsOffered()) return;
  savePanelOpen = !savePanelOpen;
  if (!savePanelOpen) {
    closeSavePanel({ focusToggle: false });
    return;
  }
  // Help is a different subject wanting the same room. The preset panel is not:
  // it is this panel's other half, and saving with it open is what puts the new
  // Preset on screen where the save leaves focus.
  helpOpen = false;
  // Prefilled with the Preset this Configuration came from, so saving an edited
  // version back over it is the default and renaming is the deliberate act. An
  // untouched name is what carries the edits onto the Preset the user started
  // from — which is `savePreset`'s existing replace-by-name behaviour, not a
  // second path.
  elements.presetName.value = nameToSaveUnder();
  elements.presetName.setCustomValidity("");
  describeSaveAction();
  renderPanels();
  elements.presetName.focus();
  elements.presetName.select();
});
elements.presetSaveClose.addEventListener("click", () => closeSavePanel());
elements.presetName.addEventListener("input", () => {
  elements.presetName.setCustomValidity("");
  describeSaveAction();
});
elements.presetSave.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.presetName.setCustomValidity("");
  const result = savePreset(storedSavedPresets(), elements.presetName.value, state);
  if (result.reason) {
    elements.presetName.setCustomValidity("Enter a preset name between 1 and 80 characters.");
    elements.presetName.reportValidity();
    return;
  }
  savedPresets = result.presets;
  const persisted = writeSavedPresets(savedPresets);
  // What was just written is now what this Configuration is, so there is nothing
  // left to save until the next edit. This is the same record applying a Preset
  // makes, and it is what disables the way back in here.
  rememberPresetOrigin(result.preset.name);
  savePanelOpen = false;
  renderPanels();
  // Saving is the one write that does not go through `adoptSavedPresets`, so the
  // heading is counted here instead.
  renderPresetCount();
  renderPresetPanel();
  // Only when the panel is open. Moving focus into a panel the user cannot see
  // would strand them, and saving deliberately does not open it — the status
  // line is the confirmation, and a panel that opens itself takes the screen.
  // Otherwise focus stays on the chip the save was started from. The save has
  // just made it inert, and it can still hold focus and say so, because it is
  // marked unavailable rather than disabled.
  if (presetsOpen) {
    focusWithin(elements.presetList, `[data-preset-id="${CSS.escape(result.preset.id)}"]`);
  } else {
    elements.presetSaveOpen.focus();
  }
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
      const availability = description.availability.cycles[cycle.id];
      applyEdit({
        type: "set-cycle-repetitions",
        cycleId: cycle.id,
        repetitions: repetitionsForDot(cycle, value, availability),
      });
      break;
    }
    case "toggle-cycle-settings":
      toggleCycleSettings(cycle.id, {
        refocus: actionElement.classList.contains("envelope-mark"),
      });
      break;
    // The magnitude survives a change of shape, and which magnitude that is
    // belongs to the vocabulary rather than to this listener: the edit carries
    // both halves of the envelope, so the converted amount is asked for by name
    // rather than worked out again here.
    case "envelope-shape": {
      const shape = actionElement.dataset.envelopeShape;
      applyEdit({
        type: "set-cycle-envelope",
        cycleId: cycle.id,
        shape,
        amount: convertedEnvelopeAmount(cycle.envelope, shape),
      });
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
      renderInterface();
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
      if (rhythm) toggleRhythmSettings(rhythm.id);
      break;
    case "toggle-subdivision-menu":
      if (!rhythm) return;
      openSubdivisionMenu = openSubdivisionMenu === rhythm.id ? null : rhythm.id;
      renderCycles();
      if (openSubdivisionMenu === rhythm.id) {
        focusWithin(
          elements.cycles,
          `[data-layer-id="${CSS.escape(rhythm.id)}"] .subdivision-option[aria-selected="true"]`,
        );
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
      focusWithin(elements.cycles, `[data-layer-id="${CSS.escape(rhythm.id)}"] .notation-select`);
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
    case "display-mode":
      if (rhythm)
        applyEdit({
          type: "set-display-mode",
          cycleId: cycle.id,
          rhythmId: rhythm.id,
          displayMode: actionElement.dataset.displayMode,
        });
      break;
    case "beat": {
      if (!rhythm) return;
      applyEdit({
        type: "advance-beat-voice",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        beat: Number(actionElement.dataset.beatIndex),
      });
      break;
    }
    case "step": {
      if (!rhythm) return;
      const index = Number(actionElement.dataset.stepIndex);
      applyEdit({
        type: "advance-step-voice",
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
  if (event.key !== "Escape") return;
  dismissPendingDelete();
  // The dialog this panel replaced answered Escape natively, and a panel that
  // stopped doing so would be a regression a user notices before a test does.
  if (savePanelOpen) closeSavePanel();
});

/**
 * A drag re-renders on every pointer move, so these two readouts are written
 * here rather than by re-rendering the grid around them. `textContent` is what
 * they must not be written with: it replaces the Text node instead of changing
 * it, and the node it replaces is one the renderer put there and still holds a
 * reference to, so every later render of this readout goes into a node that is
 * no longer in the document. Changing the node's data leaves the renderer's
 * reference pointing at what the reader is actually reading.
 *
 * @param {Element} rhythmElement
 * @param {string} field
 * @param {string} text
 */
function writeReadout(rhythmElement, field, text) {
  const readout = /** @type {Text} */ (
    rhythmElement.querySelector(`[data-output="${field}"]`).firstChild
  );
  readout.data = text;
}

/**
 * The Balance centres itself when a drag leaves it near the middle, and only
 * under a pointer: an arrow key stepping off centre would be pulled straight
 * back onto it, and the slider would be stuck there for good. An `input` event
 * carries no pointer of its own, so a flag is what a drag is recognised by.
 *
 * One flag serves every rhythm's Balance, because one pointer is what a drag is.
 * A press these controls never see the release of leaves it raised — a scroll
 * gesture takes the drag over and cancels it, the context menu takes a right
 * button's release, and a press abandoned when the window loses the pointer ends
 * without one at all — and the keyboard is the backstop for all of them, because
 * the keyboard is also the only thing a stuck flag would spoil.
 *
 * Nothing else raises it. The Level and the tempo take whatever their drag
 * reports, so a press on either is not a gesture this has to know about.
 */
const BALANCE_SLIDERS = 'input[data-field="pan"]';
let balanceSliderDragging = false;
elements.cycles.addEventListener("pointerdown", (event) => {
  if (/** @type {HTMLElement} */ (event.target).matches(BALANCE_SLIDERS))
    balanceSliderDragging = true;
});
for (const type of ["pointerup", "pointercancel", "keydown"]) {
  elements.cycles.addEventListener(type, () => {
    balanceSliderDragging = false;
  });
}

/**
 * The Configuration is what the mix is, so the control is written back from it
 * rather than left holding what the pointer reported. The two differ in one
 * case — a Balance the centre tolerance pulled in — and a thumb sitting off
 * centre while the mix is centred is the control saying one thing while the
 * audio does another. This is the only write the slider gets while a drag is in
 * progress: the grid is deliberately not re-rendered under the pointer, so
 * nothing else puts the settled value back. The browser tracks the drag by
 * pointer position rather than by where the thumb was left, so the next move
 * still reports the value the pointer is over — which is what lets the thumb
 * hold the middle while the pointer crosses the tolerance around it.
 *
 * @param {HTMLInputElement} slider
 * @param {number} value
 */
function showSettledValue(slider, value) {
  slider.value = String(value);
}

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
    writeReadout(rhythmElement, "volume", `${Math.round(volume * 100)}%`);
    showSettledValue(target, volume);
  } else {
    const result = applyEdit(
      {
        type: "set-stereo-position",
        cycleId: context.cycle.id,
        rhythmId: rhythm.id,
        pan: balanceSliderDragging ? snapBalance(target.value) : target.value,
      },
      { render: false },
    );
    const pan = result.configuration.sequence.cycles
      .find(({ id }) => id === context.cycle.id)
      .rhythms.find(({ id }) => id === rhythm.id).pan;
    writeReadout(rhythmElement, "pan", panLabel(pan));
    showSettledValue(target, pan);
  }
  renderPresetPanel();
});

elements.cycles.addEventListener("change", (event) => {
  const target = /** @type {HTMLInputElement | HTMLSelectElement} */ (event.target);
  const field = target.dataset.field;
  if (!field || ["volume", "pan"].includes(field)) return;
  const context = findContext(target);
  if (!context) return;
  // The field is text rather than a number input, because a number input will
  // not hold a U+2212 at all — and the sign is the one thing a Flat has to be
  // able to say. What the field accepts and what it is left showing are
  // therefore both this listener's: the committed amount is written back, so a
  // refused entry and one clamped into range each end up reading as what the
  // envelope actually holds rather than as what was typed at it.
  if (field === "envelope-amount") {
    const { cycle } = context;
    applyEdit({
      type: "set-cycle-envelope",
      cycleId: cycle.id,
      shape: cycle.envelope.shape,
      amount: envelopeAmountValue(target.value),
    });
    const committed = state.sequence.cycles.find(({ id }) => id === cycle.id);
    if (committed) target.value = envelopeAmountText(committed.envelope.amount);
    return;
  }
  if (!context.rhythm) return;
  const { cycle, rhythm } = context;
  let result = null;
  if (field === "signature-count") {
    result = applyEdit({
      type: "set-meter-count",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      count: target.value,
    });
  } else if (field === "signature-unit") {
    result = applyEdit({
      type: "set-meter-unit",
      cycleId: cycle.id,
      rhythmId: rhythm.id,
      unit: target.value,
    });
  }
  if (!result) return;
  if (result.consequence === "none") return;
  const committed = result.configuration.sequence.cycles
    .find(({ id }) => id === cycle.id)
    ?.rhythms.find(({ id }) => id === rhythm.id);
  if (committed) elements.status.textContent = `Meter ${rhythmLabel(committed)}`;
});

engine.addEventListener("playstate", () => {
  // Every transport run starts here, so this is the one place that knows the
  // tempo the audible run is playing at.
  runBpm = engine.playing ? state.bpm : null;
  renderTransport();
  if (engine.playing) startAnimation();
});
engine.addEventListener("audioerror", (event) =>
  showError(/** @type {CustomEvent} */ (event).detail),
);
document.addEventListener("keydown", (event) => {
  if (
    event.code === "KeyP" &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.repeat
  ) {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    event.preventDefault();
    restoreFactoryPresets();
    return;
  }
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
 *
 * A wholesale clear leaves the preset key absent, so the re-read below seeds the
 * examples again and writes them. That is the intended answer: clearing the
 * origin's storage returns it to a first run, and a first run is what shows the
 * examples. It is not a deletion being undone — deleting Presets leaves an empty
 * list, which is a written key and is never seeded.
 */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== PRESET_STORAGE_KEY) return;
  const presets = readSavedPresets();
  if (presets === null) return;
  // An armed deletion whose Preset another tab has already removed has nothing
  // left to confirm, and leaving it armed would keep state pointing at nothing.
  if (!presets.some(({ id }) => id === pendingDeletePresetId)) {
    pendingDeletePresetId = null;
  }
  adoptSavedPresets(presets);
});
// A backgrounded tab can be frozen or discarded without ever firing pagehide,
// and hiding is the last moment a mobile browser reliably hands over.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistence.flush();
});

// Major ticks carry their own number, so the tick row is the tempo scale: it is
// how a reader knows what the thumb above it is sitting on without reading the
// number. The marks are `TEMPO_TICK_INTERVAL`'s, spanning `TEMPO_LIMIT`, rather
// than a tenth restated here — the interval is a tempo the slider steps to, and
// a scale drawn at some other spacing would put its numbers between the values
// the control can hold rather than on them. Every ninth mark is labelled, which
// is as close as the numbers sit before they collide at the narrowest width.
const LABELLED_EVERY = 9;
const tempoMarks = (TEMPO_LIMIT.maximum - TEMPO_LIMIT.minimum) / TEMPO_TICK_INTERVAL + 1;
elements.bpmTicks.innerHTML = Array.from({ length: tempoMarks }, (_, index) => {
  const bpm = TEMPO_LIMIT.minimum + index * TEMPO_TICK_INTERVAL;
  const major = index % LABELLED_EVERY === 0;
  return `<span data-bpm="${bpm}" data-label="${major ? bpm : ""}" class="${major ? "is-major" : ""}"></span>`;
}).join("");
/**
 * A Configuration restored from storage may already be one of the stored
 * Presets exactly, and on that reading there is nothing to save. Deriving it
 * once here costs one pass over the stored Presets at startup and keeps a
 * reload from re-offering a save the user already made. There is no origin yet
 * to keep, so the reconciliation below is that derivation.
 */
reconcilePresetOrigin();
// The count is not part of `renderInterface`: no Configuration edit changes the
// stored list, so every edit-driven render would rewrite a number that cannot
// have moved. It is rendered once here and again wherever `savedPresets` does.
renderPresetCount();
renderInterface();
