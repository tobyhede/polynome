import { MetronomeEngine } from "./metronome.ts";
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
} from "./configuration.ts";
import {
  lookup,
  panLabel,
  snapBalance,
  convertedEnvelopeAmount,
  ENVELOPE,
  MIX_STEP,
  TEMPO_LIMIT,
  TEMPO_TICK_INTERVAL,
  TIMING_MODE,
} from "./model.ts";
import {
  controlCounts,
  controlIndexAt,
  controlPlacement,
  controls,
  temporalGridColumns,
} from "./grid.ts";
import { createPersistence, readStoredValue } from "./persistence.ts";
import {
  createShareConfigurationUrl,
  decodeShareConfigurationFragment,
  isShareConfigurationFragment,
} from "./share.ts";
// `htm/preact` is Preact's own no-build path: tagged templates the browser
// parses, and `html` already bound to its `h`. The import map in `index.html`
// resolves all three specifiers this pulls in.
import { html, render } from "htm/preact";

const STORAGE_KEY = "polynome-configuration-v2";
const PRESET_STORAGE_KEY = "polynome-presets-v4";
// The Accent is a preference of this browser, not part of the Configuration:
// no Preset carries it and changing it never marks a setup unsaved. It is a
// third key for that reason rather than a field — see ADR-0017.
const ACCENT_STORAGE_KEY = "polynome-accent-v1";
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
const RETIRED_PRESET_STORAGE_KEYS = [
  "polynome-presets",
  "polynome-presets-v2",
  "polynome-presets-v3",
];

/**
 * `querySelector` is typed as returning the base `Element`, which carries none
 * of `focus`, `value`, `style`, or `dataset`. Narrowing happens once, here,
 * rather than at each of the several dozen places these are read: this object
 * is already the single list of what the interface resolves from the shell,
 * and `test/accessibility.test.ts` asserts every id below exists in
 * `index.html`, so the tag each name is asserted against is checked too.
 */
const elements = {
  appShell: document.querySelector(".app-shell") as HTMLElement,
  heading: document.querySelector("#app-heading") as HTMLHeadingElement,
  transport: document.querySelector(".transport") as HTMLElement,
  play: document.querySelector("#play-button") as HTMLButtonElement,
  playIcon: document.querySelector("#play-icon") as HTMLSpanElement,
  restartAudio: document.querySelector("#restart-audio") as HTMLButtonElement,
  bpm: document.querySelector("#bpm-input") as HTMLInputElement,
  bpmSlider: document.querySelector("#bpm-slider") as HTMLInputElement,
  bpmDown: document.querySelector("#bpm-down") as HTMLButtonElement,
  bpmUp: document.querySelector("#bpm-up") as HTMLButtonElement,
  bpmReadout: document.querySelector("#bpm-readout") as HTMLDivElement,
  bpmLabel: document.querySelector("#bpm-readout label") as HTMLLabelElement,
  bpmTicks: document.querySelector("#bpm-ticks") as HTMLDivElement,
  presetsToggle: document.querySelector("#presets-toggle") as HTMLButtonElement,
  presetPanel: document.querySelector("#preset-panel") as HTMLElement,
  presetList: document.querySelector("#preset-list") as HTMLDivElement,
  presetCount: document.querySelector("#preset-count") as HTMLSpanElement,
  presetCountNoun: document.querySelector("#preset-count-noun") as HTMLSpanElement,
  presetsClose: document.querySelector("#presets-close") as HTMLButtonElement,
  presetSave: document.querySelector("#preset-save") as HTMLFormElement,
  presetSavePanel: document.querySelector("#save-panel") as HTMLElement,
  presetSaveOpen: document.querySelector("#preset-save-open") as HTMLButtonElement,
  presetSaveReason: document.querySelector("#preset-save-reason") as HTMLElement,
  presetSaveClose: document.querySelector("#preset-save-close") as HTMLButtonElement,
  presetSaveSubmit: document.querySelector("#preset-save-submit") as HTMLButtonElement,
  presetSaveIconSave: document.querySelector("#preset-save-icon-save") as SVGElement,
  presetSaveIconReplace: document.querySelector("#preset-save-icon-replace") as SVGElement,
  presetName: document.querySelector("#preset-name") as HTMLInputElement,
  shareConfiguration: document.querySelector("#share-configuration") as HTMLButtonElement,
  helpToggle: document.querySelector("#help-toggle") as HTMLButtonElement,
  helpPanel: document.querySelector("#help-panel") as HTMLElement,
  accentToggle: document.querySelector("#accent-toggle") as HTMLButtonElement,
  accentPanel: document.querySelector("#accent-panel") as HTMLElement,
  accentSwatches: document.querySelector("#accent-swatches") as HTMLElement,
  accentCaptionName: document.querySelector("#accent-caption-name") as HTMLElement,
  accentCaptionHex: document.querySelector("#accent-caption-hex") as HTMLElement,
  accentCaptionContrast: document.querySelector("#accent-caption-contrast") as HTMLElement,
  cycles: document.querySelector("#cycles") as HTMLElement,
  addCycle: document.querySelector("#add-cycle") as HTMLButtonElement,
  feedback: document.querySelector("#feedback") as HTMLParagraphElement,
  status: document.querySelector("#status") as HTMLParagraphElement,
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
  (root?.querySelector(selector) as HTMLElement | null | undefined)?.focus();
}

const engine = new MetronomeEngine();
const openRhythms = new Set();
const openCycles = new Set();
/**
 * The stretches of the tempo range the current run travels through, while it is
 * travelling them, and empty the rest of the time — including under a Flat,
 * which changes tempo without passing through anything on the way. There is one
 * per continuous run of ramps, so a Flat between two of them leaves two with the
 * tempos it stepped over lying between.
 *
 * The tempo the readout is sized from while the number is moving, and null while
 * it is not. Both are remembered rather than passed because the readout is drawn
 * from two places — a full render, and the per-frame write that follows a live
 * tempo — and the two have to agree.
 */
let tempoStretches = [];
let heldTempo = null;
let state = loadState();
let savedPresets = readSavedPresets() ?? createSavedPresets();
let description = describeConfiguration(state);
const {
  meterCounts: METER_COUNTS,
  meterUnits: METER_UNITS,
  repetitions: REPETITIONS,
  sounds: SOUNDS,
} = description.choices;
let presetsOpen = false;
let helpOpen = false;
let savePanelOpen = false;
let accentOpen = false;
/** The chosen Accent's name; `applyAccent` is the only writer. */
let accent = null;
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
let playMode = false;

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

function showFeedback(message) {
  elements.feedback.textContent = message;
  elements.feedback.hidden = false;
  elements.status.textContent = message;
}

function clearFeedback() {
  elements.feedback.textContent = "";
  elements.feedback.hidden = true;
  elements.status.textContent = engine.playing ? "Playing" : "Stopped";
}

function shareUrlBase() {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  return url.href;
}

async function shareCurrentConfiguration() {
  try {
    const base = shareUrlBase();
    if (base === null) return;
    const url = await createShareConfigurationUrl(base, state);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Polynome", url });
        clearFeedback();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    if (typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(url);
        showFeedback("Share link copied");
        return;
      } catch {
        // The terminal failure below covers a refused clipboard write.
      }
    }
    showFeedback("Configuration could not be shared");
  } catch {
    showFeedback("Configuration could not be shared");
  }
}

/**
 * Nothing serialises Share loads. The startup load and a `hashchange` can be in
 * flight together, and two `hashchange`s in quick succession just as easily, and
 * they finish in the order their decoding takes rather than the order the reader
 * asked for them in. Each load claims the next number here and does nothing at
 * all once a later one exists, so the link opened first cannot land last and
 * write itself over the newer one — in storage, in the URL, or in the interface.
 *
 * The number alone leaves that window open, because the two halves of a newer
 * link arriving do not happen together: assigning `location.hash` moves the URL
 * synchronously, and the `hashchange` that claims the next number is a task
 * queued behind every microtask a resolving decode runs through. A load
 * finishing in between still reads as the newest there is, and would consume a
 * fragment it never decoded. Being current is therefore two claims rather than
 * one — no later load has begun, and the URL still holds the link this one
 * decoded — and a load that fails either does the same nothing. The second also
 * covers the hash leaving Share behind altogether, `#help` or a step back in
 * history: no load begins there, so no number is ever claimed, and the fragment
 * is the only thing that says the link being opened is not the one in the URL.
 */
let shareLoadGeneration = 0;

async function loadSharedConfiguration(fragment, fallbackConfiguration, isCurrent) {
  try {
    const configuration = await decodeShareConfigurationFragment(fragment);
    if (!isCurrent()) return null;
    try {
      writeState(configuration);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch {
      // The fragment remains the recoverable copy when this browser cannot
      // persist the Configuration or consume the URL safely.
    }
    return { configuration };
  } catch {
    // A superseded failure is discarded rather than reported: its fallback was
    // captured before the newer link existed, so adopting it would replace a
    // Configuration that loaded correctly with an older one and a message about
    // a link nobody is waiting on any more.
    if (!isCurrent()) return null;
    return {
      configuration: fallbackConfiguration,
      feedback: "This share link could not be loaded.",
    };
  }
}

/**
 * A load that failed adopts the workspace it was handed as its own fallback, so
 * the Configuration here is the one already in hand and nothing about it arrived
 * from the link. That is what the identity check separates, and everything the
 * link would have replaced hangs off it: the run it would have stopped, and the
 * Preset origin, which is a claim about where this Configuration came from and
 * stays true when nothing replaced it. Cleared regardless, a Configuration that
 * still is a stored Preset reads as unsaved, and + Save offers to store a second
 * copy of it under a blank name.
 */
function adoptSharedConfiguration(shared) {
  if (shared.configuration !== state) {
    engine.stop();
    state = shared.configuration;
    description = describeConfiguration(state);
    presetOrigin = null;
  }
  renderInterface();
  if (shared.feedback) showFeedback(shared.feedback);
  else clearFeedback();
}

/**
 * The whole arrival of a Share link, and the one route to it: the workspace
 * closes, the fragment decodes, and the outcome is either adopted or discarded
 * because a newer link has arrived meanwhile.
 *
 * The fragment is read once, before the first await. `location.hash` is free to
 * change while this decodes, and a load that decoded one link must never consume
 * or report another.
 *
 * `inert` lifts before the outcome is adopted rather than after it. `#status` and
 * `#feedback` both live inside the shell, and an inert subtree is outside the
 * accessibility tree, so a message written while it is still inert is a live
 * region mutation with nothing listening — and lifting `inert` afterwards leaves
 * nothing left to announce. The two statements share one synchronous block, so
 * there is no moment in between for input to reach a workspace still loading.
 */
async function openSharedConfiguration(fallbackConfiguration) {
  if (typeof location === "undefined" || !isShareConfigurationFragment(location.hash)) return;
  const fragment = location.hash;
  shareLoadGeneration += 1;
  const generation = shareLoadGeneration;
  const isNewest = () => shareLoadGeneration === generation;
  const isCurrent = () => isNewest() && location.hash === fragment;
  const focusedElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const restoreFocus = () => {
    if (
      focusedElement?.isConnected &&
      focusedElement.tabIndex >= 0 &&
      !focusedElement.matches(":disabled") &&
      focusedElement.getClientRects().length > 0
    ) {
      focusedElement.focus();
    }
  };
  elements.appShell.inert = true;
  persistence.flush();
  const shared = await loadSharedConfiguration(fragment, fallbackConfiguration, isCurrent);
  // Nothing comes back from a load that is no longer current, and that is the
  // only way nothing comes back: it adopts no outcome and says nothing about a
  // workspace it no longer speaks for. Whether it hands that workspace back is
  // the separate question, and the answer is whether anything else holds it. A
  // newer load owns the workspace from the moment it begins, so a load numbered
  // past leaves it closed for that one to finish. A load left behind by the URL
  // alone has no such successor — the hash may have gone somewhere no Share load
  // reaches — so it lifts the inertness itself rather than close the application
  // on nobody's behalf, and a load already queued for a newer link closes it
  // again in the turn that follows.
  if (shared || isNewest()) elements.appShell.inert = false;
  if (!shared) {
    if (isNewest()) restoreFocus();
    return;
  }
  adoptSharedConfiguration(shared);
  restoreFocus();
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

/**
 * The controls that offer the Accents, which is everything this module knows
 * about the set: the name, the group that decides the glow, and the contrast
 * the caption quotes are all read back off them. The swatches are static
 * markup, so the shell is already the one list of what a user can choose, and a
 * second copy here would be a second place to add a colour with only one of
 * them noticed missing. `test/accessibility.test.js` holds the stylesheet to
 * this same set.
 */
function accentSwatches() {
  return Array.from(elements.accentSwatches.querySelectorAll<HTMLElement>("[data-accent]"));
}

function accentNames() {
  return accentSwatches().map((swatch) => swatch.dataset.accent);
}

/**
 * The `rgb(...)` a swatch computes to, spelled as the hex the stylesheet wrote
 * it as. The caption quotes a colour the stylesheet owns, and reading it back
 * off the painted circle is what keeps `index.html` from carrying a second copy
 * of twelve hex values for the one line of text that shows them — the copy that
 * would go on reading `#7EA3F0` after the token behind it had been corrected.
 */
function paintedHex(element) {
  const channels = getComputedStyle(element).backgroundColor.match(/\d+/g) ?? [];
  if (channels.length < 3) return "";
  const hex = channels
    .slice(0, 3)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`.toUpperCase();
}

/**
 * A stored name that no swatch offers is repaired to the default rather than
 * refused, which is how every other stored value here is treated: storage is
 * something a previous version, another tab, or a person with a console may
 * have written, and the interface has to open on something either way.
 */
function loadAccent() {
  const [fallback] = accentNames();
  let stored = null;
  try {
    stored = localStorage.getItem(ACCENT_STORAGE_KEY);
  } catch {
    // Resolving the browser's storage property can itself be forbidden.
  }
  return accentNames().includes(stored) ? stored : fallback;
}

/**
 * The property is written onto the root element rather than a class being
 * toggled, so every `var(--accent)` in the stylesheet — including the ones
 * inside `color-mix()` — follows from one assignment. The value names a swatch
 * token instead of repeating its hex, which keeps the stylesheet the only place
 * a colour is written down.
 */
function applyAccent(name) {
  accent = name;
  const chosen = accentSwatches().find((swatch) => swatch.dataset.accent === name);
  const root = document.documentElement;
  root.style.setProperty("--accent", `var(--accent-${name})`);
  // The glow rides on the colour rather than on a setting of its own: the neon
  // Accents turn the existing glows up and light two that are dark otherwise.
  // It is written as the number those rules multiply by, so each of them stays
  // one declaration whose strength happens to be a `calc()`. Which group a
  // swatch is in is markup, like its name, so there is nothing to keep in step
  // here.
  root.style.setProperty("--accent-glow", chosen?.dataset.accentGroup === "neon" ? "1" : "0");
}

function writeAccent(name) {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, name);
  } catch {
    // The metronome remains usable when storage is unavailable.
  }
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

function applyEdit(edit, options: { render?: boolean; deferConsequence?: boolean } = {}) {
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
  elements.accentPanel.hidden = !accentOpen;
  elements.accentToggle.setAttribute("aria-expanded", String(accentOpen));
  elements.accentToggle.classList.toggle("is-active", accentOpen);
  // The pressed swatch is written on every render rather than moved from the
  // one that was clicked, so the panel reports the Accent in force whatever put
  // it there — including a repaired storage value nobody selected.
  let chosen = null;
  for (const swatch of accentSwatches()) {
    const selected = swatch.dataset.accent === accent;
    swatch.setAttribute("aria-pressed", String(selected));
    swatch.classList.toggle("is-selected", selected);
    if (selected) chosen = swatch;
  }
  // The three things a circle cannot say about itself: which one it is, the hex
  // to quote it by, and the ratio it clears on the surface it is read as text
  // on. The name comes from the swatch's own title rather than a table here,
  // for the same reason the set does.
  elements.accentCaptionName.textContent = chosen?.title ?? "";
  elements.accentCaptionHex.textContent = chosen ? paintedHex(chosen) : "";
  elements.accentCaptionContrast.textContent = chosen ? `AA · ${chosen.dataset.contrast}:1` : "";
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
   * Whether it *travels* decides the band, and that is a question about the
   * tempos a run passes through rather than about the envelopes written down in
   * it. A Flat jumps from one tempo to the next and sounds neither of the ones
   * between; a ramp with nothing left to give — Up 20 already at 300 — carries
   * its amount and moves nothing. Both are runs at a tempo that never travels,
   * and the description answers for both by reporting the stretch rather than
   * the intent, so there is nothing to work out again here.
   */
  const tempoMoves = playing && description.tempoRange.minimum !== description.tempoRange.maximum;
  const travelled = playing ? description.travelledStretches : [];

  elements.bpmLabel.textContent = tempoMoves ? String(state.bpm) : "BPM";
  elements.bpmLabel.classList.toggle("is-starting-tempo", tempoMoves);
  // The tempo the run opens on, which is not always the one the Preset stores:
  // a Flat spends its whole change on the first beat, so a Sequence starting on
  // Flat +60 at 96 plays 156 from the outset and never sounds 96 at all. Sizing
  // the glyphs from a tempo nobody hears is a smaller wrong than sizing them
  // from one that keeps changing, but it is still one.
  heldTempo = tempoMoves ? description.cycles.find(({ active }) => active).startBpm : null;
  elements.bpmTicks.classList.toggle("is-banded", travelled.length > 0);
  tempoStretches = travelled;
  renderTempoBands();
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
 * One element per stretch the run travels. Each is placed from the two tempos
 * themselves rather than from the marks nearest them, which is the whole of why
 * the band is a bar: the ticks are a tenth of the range apart, and a ramp
 * shorter than that either lands on one of them or on none.
 *
 * Elements rather than the single pseudo-element this was, because a Flat
 * between two ramps leaves two stretches with the tempos it stepped over lying
 * unplayed between them, and one object has one start and one end to say that
 * with. They are drawn over a row that is `aria-hidden`, so they inherit that
 * and name nothing.
 *
 * Rebuilt from the description rather than reconciled: there is one band for a
 * run of ramps and rarely more, and the row's own marks are written once at
 * startup and never touched here.
 */
function renderTempoBands() {
  elements.bpmTicks.querySelectorAll(".bpm-band").forEach((band) => {
    band.remove();
  });
  for (const { minimum, maximum } of tempoStretches) {
    const band = document.createElement("div");
    band.className = "bpm-band";
    band.style.setProperty("--band-start", `${tempoFraction(minimum) * 100}%`);
    band.style.setProperty("--band-end", `${tempoFraction(maximum) * 100}%`);
    elements.bpmTicks.append(band);
  }
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
 * The marks answer the band rather than the size, by giving way to it: under a
 * ramp the band is drawn over them from the tempos themselves, at a resolution
 * a scale a tenth of the range apart cannot carry, and they stay the plain
 * scale it is drawn against. Under a Flat, which travels nothing, there is no
 * band and they go on marking where the tempo has reached.
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
  // The bands themselves are not written here. They stand on the tempos the run
  // travels rather than on the one it is sounding, so nothing about them changes
  // between one frame and the next, and this runs on every frame the live tempo
  // moves the number. `renderTempoBands` draws them where they change, which is
  // where the run does.
  elements.bpmTicks.querySelectorAll("span").forEach((tick) => {
    // Nothing on the scale answers a band: each band draws its own ends, at the
    // tempos rather than at the marks nearest them, and marking the scale as
    // well would say the same thing a second time and less accurately. Whether
    // there is any band at all is the whole question — which one a mark falls
    // under is not something the scale has anything to add to.
    tick.classList.toggle(
      "is-passed",
      tempoStretches.length === 0 && Number(tick.dataset.bpm) <= displayedBpm,
    );
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
  const cycleDescriptions = describeConfiguration(configuration).cycles;
  const accessible = configuration.sequence.cycles
    .map((cycle, index) => {
      const rhythms = cycle.rhythms
        .map((_, position) => {
          const rhythmDescription = cycleDescriptions[index].rhythms[position];
          return `${rhythmDescription.meter}, ${rhythmDescription.subdivision}`;
        })
        .join(" plus ");
      const envelope = cycleDescriptions[index].accessibleNotation;
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
              <span>${cycleDescriptions[index].rhythms[position].meter}</span>
              <${NoteIcon} subdivision=${rhythm.subdivision} height=${15} />
            </span>
          `,
          )}
          ${
            cycleDescriptions[index].notation
              ? html`<span class="preset-envelope"> ${cycleDescriptions[index].notation}</span>`
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
  render(
    html`<${Cycles} cycles=${state.sequence.cycles} playing=${engine.playing} />`,
    elements.cycles,
  );
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
 * A tempo drag skips the full Cycle render, but the result shown by every Cycle
 * envelope is derived from the Starting BPM too. Update those rendered values
 * without reconciling the grids under the pointer. As with the mix readouts,
 * changing the existing Text node keeps Preact's reference attached to the node
 * that remains in the document.
 */
function renderCycleTempos() {
  const outputs = elements.cycles.querySelectorAll(".cycle-settings output");
  description.cycles.forEach((cycle, index) => {
    const output = outputs[index];
    if (output) writeRenderedText(output, cycle.tempo);
  });
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
 * Grouping only: this chooses how many signature units share a row and changes
 * nothing else. Step size and spacing belong to the stylesheet and are measured
 * here rather than set.
 *
 * A signature unit is indivisible, so a row holds a whole number of them, and
 * equal rows mean that number must divide the Meter numerator. Taking the
 * divisors largest-first under a sixteen-step ceiling lands on the conventions
 * by itself: 4/4 sixteenths give one row of sixteen, and an irregular meter like
 * 7/8 is prime, so its only options are the whole grid or one signature unit per
 * row, never a false even split.
 *
 * Width can only narrow that choice further, never make it. When even a single
 * signature unit is wider than the row, the pattern scrolls rather than
 * shrinking.
 */
function layoutSteps() {
  // Measure every rhythm, then write every rhythm. Interleaving the two costs a
  // synchronous reflow per rhythm, because each write invalidates the layout the
  // next read needs and this runs on every render — including every step click.
  // Batching also makes the answer independent of the order rhythms are visited
  // in, since none of them is measured against another's freshly applied rows.
  const plans = [];
  const referenceLayouts = new Map();
  const polyrhythmSteps = [];
  for (const steps of elements.cycles.querySelectorAll(".steps") as NodeListOf<HTMLElement>) {
    if (steps.classList.contains("is-polyrhythm")) {
      polyrhythmSteps.push(steps);
      continue;
    }
    const signatureUnit = steps.querySelector(".beat");
    const style = getComputedStyle(steps);
    const available =
      steps.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (!signatureUnit || !(available > 0)) continue;

    // A signature unit is a flex row of fixed-size controls, so its width does
    // not depend on the grouping being chosen and can be measured first.
    const signatureUnitWidth = signatureUnit.getBoundingClientRect().width;
    const signatureUnitGap = parseFloat(style.columnGap) || 0;
    const signatureUnits = Number(steps.dataset.signatureUnits);
    const controlsPerSignatureUnit = Number(steps.dataset.controlsPerSignatureUnit);
    const perRow =
      descendingDivisors(signatureUnits).find(
        (candidate) =>
          candidate * controlsPerSignatureUnit <= STEPS_PER_ROW_LIMIT &&
          candidate * signatureUnitWidth + (candidate - 1) * signatureUnitGap <= available,
      ) ?? 1;

    const layout = {
      perRow,
      scrolling: signatureUnitWidth > available,
      temporalWidth: signatureUnits * (signatureUnitWidth + signatureUnitGap),
    };
    plans.push({ steps, ...layout });
    if (!referenceLayouts.has(steps.closest(".cycle-group"))) {
      referenceLayouts.set(steps.closest(".cycle-group"), layout);
    }
  }

  for (const steps of polyrhythmSteps) {
    const reference = referenceLayouts.get(steps.closest(".cycle-group"));
    if (reference) plans.push({ steps, temporalContentWidth: reference.temporalWidth });
  }

  for (const { steps, perRow, scrolling, temporalContentWidth } of plans) {
    if (temporalContentWidth !== undefined) {
      steps.style.setProperty("--temporal-content-width", `${temporalContentWidth}px`);
      continue;
    }
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
 * can only take the same number of signature units or fewer, so it can only
 * produce the same number of rows or more. Losing the scrollbar therefore never
 * makes the page taller, and gaining one never makes it shorter, so each toggle
 * is self-confirming and stops after one pass.
 *
 * The exception is a step-size breakpoint sitting inside one scrollbar width of
 * the current viewport, where narrowing shrinks the controls and can fit more
 * signature units to a row. Reaching it needs the page height to cross the
 * viewport height at that same width; the browser's own ResizeObserver loop
 * limit ends it after a frame, which is why there is no debounce here to buy.
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

function Cycles({ cycles, playing }) {
  return html`${cycles.map(
    (cycle, index) => html`
    <${CycleGroup} key=${cycle.id} cycle=${cycle} cycleIndex=${index} cycleCount=${cycles.length} playing=${playing} />
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

function CycleGroup({ cycle, cycleIndex, cycleCount, playing }) {
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
          (rhythm, position) => html`
          <${RhythmCard}
            key=${rhythm.id}
            rhythm=${rhythm}
            rhythmDescription=${tempoDescription.rhythms[position]}
            cycle=${cycle}
            playing=${playing}
            position=${position}
          />
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
 * Four controls and nothing else. The unit is stated once, in the group label,
 * which is why neither control after it repeats it — and why there is no range
 * hint, no badge and no prose: the shape, the number and the result are the
 * whole of what an envelope is.
 */
function CycleSettings({ cycle, cycleTitle, tempo }) {
  const timingLabelId = `cycle-${cycle.id}-timing-label`;
  const shapeLabelId = `cycle-${cycle.id}-envelope-label`;
  const { shape, amount } = cycle.envelope;
  return html`
    <div class="timing-settings">
      <div class="segmented-control" role="group" aria-labelledby=${timingLabelId}>
        <span id=${timingLabelId}>Poly</span>
        <div>${Object.values(TIMING_MODE).map(
          (candidate) => html`
          <button
            type="button"
            class="segment-button${candidate === cycle.timingMode ? " is-selected" : ""}"
            data-action="timing-mode"
            data-timing-mode=${candidate}
            aria-label=${candidate === TIMING_MODE.POLYMETER ? "Polymeter" : "Polyrhythm"}
            aria-pressed=${String(candidate === cycle.timingMode)}
          >${candidate === TIMING_MODE.POLYMETER ? "meter" : "rhythm"}</button>
        `,
        )}</div>
      </div>

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

function RhythmCard({ rhythm, rhythmDescription, cycle, playing, position }) {
  const label = rhythmDescription.meter;
  const drawerId = `rhythm-${rhythm.id}-settings`;
  const open = openRhythms.has(rhythm.id);
  const effectivelyOpen = open && !playing;
  const counts = controlCounts(rhythm);
  const polyrhythm =
    cycle.timingMode === TIMING_MODE.POLYRHYTHM && cycle.rhythms.length > 1 && position > 0;
  const temporalColumns = polyrhythm ? temporalGridColumns(cycle.rhythms) : null;
  const removable = description.availability.cycles[cycle.id].rhythms[rhythm.id].remove.available;
  return html`
    <article class="rhythm-card${rhythm.muted ? " is-muted" : ""}" data-layer-id=${rhythm.id}>
      <div class="card-heading rhythm-heading">
        <button
          type="button"
          class="rhythm-identity"
          data-action="toggle-settings"
          aria-expanded=${String(effectivelyOpen)}
          aria-controls=${drawerId}
          disabled=${playing}
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
            class="icon-button edit-button${effectivelyOpen ? " is-active" : ""}"
            data-action="toggle-settings"
            aria-expanded=${String(effectivelyOpen)}
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
      <div id=${drawerId} class="rhythm-settings" hidden=${!effectivelyOpen}>
        <${RhythmSettings} rhythm=${rhythm} rhythmDescription=${rhythmDescription} />
      </div>

      <!-- The controls each signature unit holds are carried for layoutSteps(),
           which reads the number to choose how many units share a row. Both
           counts come from grid.ts rather than being derived here: what the row
           fits is controls, and how many of them a signature unit holds is the
           Display mode's decision, made once. The Subdivision was carried a
           second time as a custom property the gap clamp calculated with; that
           gap is now the same one the controls inside a unit use, so nothing in
           the stylesheet asks for it any more. -->
      <div
        class=${`steps${polyrhythm ? " is-polyrhythm" : ""}`}
        role="group"
        aria-label=${`${label} ${controlNoun(rhythm).toLowerCase()} voices`}
        data-signature-units=${counts.signatureUnits}
        data-controls-per-signature-unit=${counts.controlsPerSignatureUnit}
        data-display-mode=${rhythm.displayMode}
        style=${polyrhythm ? `--temporal-columns: ${temporalColumns};` : null}
        data-temporal-columns=${temporalColumns}
      >
        <${SignatureUnits} rhythm=${rhythm} temporalColumns=${temporalColumns} />
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

function RhythmSettings({ rhythm, rhythmDescription }) {
  const label = rhythmDescription.meter;
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
          ${
            rhythmDescription.denominatorAvailable
              ? html`<span aria-hidden="true">/</span>
                  <${MeterField}
                    field="signature-unit"
                    value=${rhythm.signature.unit}
                    name=${`${label} meter denominator`}
                    choices=${METER_UNITS}
                  />`
              : null
          }
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
            ${rhythmDescription.subdivisions.map(
              ({ value: subdivision, label: subdivisionDescription }) => html`
              <button
                type="button"
                role="option"
                class="subdivision-option${subdivision === rhythm.subdivision ? " is-selected" : ""}"
                data-action="set-subdivision"
                data-subdivision=${subdivision}
                aria-selected=${String(subdivision === rhythm.subdivision)}
                aria-label=${subdivisionDescription}
                title=${subdivisionDescription}
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
           the twentieth it is, because the grid it sets is what decides which
           values these controls can hold at all: anything else is rounded onto
           it silently, so a default or a stored value off the grid arrives on
           screen as a different number than the one this Configuration is
           playing. A literal here would be a second answer to that question.

           The minimum beside it is the other half of the grid, because the
           standard counts steps from it rather than from zero, and it stays a
           literal because it is this control's own end rather than anything the
           domain names. The model suite reads this template for both, and
           measures every default the application ships from the minimum it
           finds here. -->
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

// Controls are grouped a signature unit at a time so a narrow screen can only
// ever break between units. Which unit a control falls in is the control's own,
// from `grid.ts`, so nothing here strides the pattern to work it out; every
// group is full and no row is left ragged, because a run never crosses a unit.
//
// Where a signature unit starts is marked by a dot the stylesheet draws on `.beat`
// itself, so nothing here emits it. The steps are evenly spaced and say
// nothing about grouping, and the first step of a bar cannot say it either:
// its voice is the listener's to change, and a downbeat switched off is the
// dimmest circle in the row. A pseudo-element keeps the mark out of the
// accessibility tree without an `aria-hidden` element to carry it, which is
// what a purely decorative mark inside a named group should be.
function SignatureUnits({ rhythm, temporalColumns }) {
  const noun = controlNoun(rhythm);
  const rhythmControls = controls(rhythm);
  const signatureUnits = [];
  for (const [control, { voice, signatureUnit }] of rhythmControls.entries()) {
    if (!signatureUnits[signatureUnit]) signatureUnits[signatureUnit] = [];
    signatureUnits[signatureUnit].push(html`
      <${GridControl} voice=${voice} control=${control} noun=${noun} />
    `);
  }
  return html`${signatureUnits.map(
    (group, signatureUnit) => html`
      <div
        class="beat"
        style=${
          temporalColumns
            ? (
                () => {
                  const positions = rhythmControls
                    .filter((control) => control.signatureUnit === signatureUnit)
                    .flatMap((control) => control.positions);
                  const placement = controlPlacement(rhythm, { positions }, temporalColumns);
                  return `grid-column: ${placement.start} / span ${placement.span};`;
                }
              )()
            : null
        }
      >${group}</div>
    `,
  )}`;
}

/**
 * What a Grid control is called for a listener. Beat Mode says "Beat" because a
 * listener counts a bar in beats and has no use for the written unit's name —
 * `CONTEXT.md`'s Beat control entry is where that is recorded, and this is the
 * one place Polynome says it. Subdivision Mode addresses a pattern position and
 * says "Step", which is the interface's word for it rather than the glossary's.
 *
 * Presentation, so it lives here: `grid.ts` is read by `configuration.ts` and
 * has no business holding a string neither of them will ever show.
 */
function controlNoun(rhythm) {
  return rhythm.displayMode === "beat" ? "Beat" : "Step";
}

function GridControl({ voice, control, noun }) {
  const name = `${noun} ${control + 1}`;
  return html`
    <button
      type="button"
      class="step step-${voice}"
      data-action="control"
      data-control=${control}
      aria-label=${`${name}: ${voice} voice`}
      title=${`${name}: ${voice}`}
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

function updatePlayButton() {
  const playing = engine.playing;
  const enteringPlayMode = playing && !playMode;
  if (
    enteringPlayMode &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement.closest(
      ".page-header, .top-panel, .cycle-settings, .rhythm-settings, .edit-button, .remove-button, .envelope-mark, .add-rhythm, #add-cycle, .rhythm-identity",
    )
  ) {
    elements.play.focus();
  }
  playMode = playing;
  elements.appShell.classList.toggle("is-play-mode", playing);
  elements.play.classList.toggle("is-playing", playing);
  elements.play.setAttribute("aria-pressed", String(playing));
  elements.play.setAttribute("aria-label", playing ? "Stop metronome" : "Play metronome");
  elements.playIcon.textContent = playing ? "■" : "▶";
  elements.restartAudio.hidden = !playing;
  elements.status.textContent = playing ? "Playing" : "Stopped";
  if (enteringPlayMode) {
    // The active-step pass removes every inactive Cycle in the same turn. Let
    // that focused layout settle before asking the window for its final scroll
    // position, or scroll anchoring can restore the pre-filter position.
    requestAnimationFrame(() => {
      if (!engine.playing) return;
      elements.transport.scrollIntoView({ block: "start" });
    });
  }
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
  const activeCycleId =
    position?.cycleId ?? state.sequence.cycles.find((cycle) => cycle.repetitions > 0)?.id;
  const focusedCycle =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest(".cycle-group")
      : null;
  if (focusedCycle && focusedCycle.getAttribute("data-cycle-id") !== activeCycleId) {
    elements.play.focus();
  }
  for (const cycle of state.sequence.cycles) {
    const cycleElement = elements.cycles.querySelector(`[data-cycle-id="${CSS.escape(cycle.id)}"]`);
    if (!cycleElement) continue;
    const active = cycle.id === activeCycleId;
    cycleElement.classList.toggle("is-active-cycle", active);
    cycleElement.querySelector(".cycle-card")?.classList.toggle("is-current", active);
    cycleElement.querySelectorAll(".repeat-dot").forEach((element, index) => {
      element.classList.toggle("is-current", active && index === position?.repetitionIndex);
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
      const stepElements = steps.querySelectorAll(".step");
      stepElements.forEach((element) => {
        element.classList.remove("is-current");
      });
      const current = stepElements[controlIndexAt(rhythm, activeIndex)];
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
  animationFrame = null;
  updateActiveSteps();
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

async function restartAudio() {
  try {
    await engine.restartAudio(state);
    elements.status.textContent = "Audio restarted";
  } catch (error) {
    renderTransport();
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
elements.restartAudio.addEventListener("click", restartAudio);
elements.presetsToggle.addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  if (presetsOpen) {
    helpOpen = false;
    accentOpen = false;
    renderPresetPanel();
  }
  renderPanels();
});
elements.presetsClose.addEventListener("click", () => {
  presetsOpen = false;
  renderPanels();
  elements.presetsToggle.focus();
});
// Colour is a fourth subject, so it follows the rule Help follows: opening it
// closes the other three, and any of them closes it. There is no close control
// and no Escape handler, unlike Save — Escape's job in that panel is abandoning
// a half-typed name, and a row of swatches has nothing to abandon.
elements.accentToggle.addEventListener("click", () => {
  accentOpen = !accentOpen;
  if (accentOpen) {
    helpOpen = false;
    presetsOpen = false;
    savePanelOpen = false;
  }
  renderPanels();
});
elements.accentSwatches.addEventListener("click", (event) => {
  const swatch = (event.target as HTMLElement).closest("[data-accent]");
  if (!swatch) return;
  const name = (swatch as HTMLElement).dataset.accent;
  applyAccent(name);
  writeAccent(name);
  // Only the panels are redrawn: the Accent is a custom property every rule
  // already reads, so nothing about the Configuration or the Sequence has
  // changed and there is nothing else to re-render.
  renderPanels();
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
    accentOpen = false;
  }
  renderPanels();
});
elements.bpm.addEventListener("change", (event) =>
  changeTempo((event.target as HTMLInputElement).value),
);
/**
 * The slider reports whatever tempo the pointer is over and the Configuration
 * takes it as it comes. Nothing here rounds it toward the tempos the tick row
 * draws: the slider's own step is five BPM, which is coarser than the two either
 * side of a mark such a snap could catch, so every tempo it would have moved is
 * one this control cannot produce in the first place — a drag lands exactly on a
 * mark or a full five from one, and never in between. The row below the slider
 * is a scale rather than a set of stops.
 */
elements.bpmSlider.addEventListener("input", (event) => {
  // While playing the slider tracks the live tempo rather than setting one, so
  // an input event here is the render's own write coming back, or a gesture the
  // `disabled` attribute did not catch. Either way it is not an edit.
  if (engine.playing) return;
  const dragged = (event.target as HTMLInputElement).value;
  applyEdit({ type: "set-tempo", bpm: dragged }, { deferConsequence: true, render: false });
  // The grid is deliberately not re-rendered under a drag, so this is what keeps
  // everything the tempo is spoken by in step with the thumb: the number in the
  // readout above it, the stepper keys marking themselves unavailable at either
  // bound, and the type size and glitch the tempo drives.
  renderTransport();
  renderPresetPanel();
  renderCycleTempos();
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
  renderCycleTempos();
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

const tempoKeys = [
  [elements.bpmDown, -1],
  [elements.bpmUp, 1],
] as [HTMLButtonElement, number][];
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
  const target = event.target as HTMLElement;
  const deleteButton = target.closest("[data-delete-preset-id]") as HTMLElement | null;
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

  const button = target.closest("[data-preset-id]") as HTMLElement | null;
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
  // Help and Colour are different subjects wanting the same room. The preset
  // panel is not: it is this panel's other half, and saving with it open is what
  // puts the new Preset on screen where the save leaves focus.
  helpOpen = false;
  accentOpen = false;
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
  const actionElement = (event.target as HTMLElement).closest(
    "[data-action]",
  ) as HTMLElement | null;
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
    case "timing-mode":
      applyEdit({
        type: "set-cycle-timing-mode",
        cycleId: cycle.id,
        timingMode: actionElement.dataset.timingMode,
      });
      break;
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
      {
        const committed = description.cycles
          .find(({ id }) => id === cycle.id)
          ?.rhythms.find(({ id }) => id === rhythm.id);
        if (committed) elements.status.textContent = `Subdivision ${committed.subdivision}`;
      }
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
    // One action for both Display modes: the listener pressed a control, and
    // which pattern positions that control runs across is the layer's to say.
    case "control": {
      if (!rhythm) return;
      applyEdit({
        type: "advance-control-voice",
        cycleId: cycle.id,
        rhythmId: rhythm.id,
        control: Number(actionElement.dataset.control),
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
  if (engine.playing) return;
  const target = event.target as HTMLElement;
  if (target.matches('[data-field="pan"]')) {
    event.preventDefault();
    const pan = target as HTMLInputElement;
    pan.value = "0";
    pan.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (target.closest("button, input, select, label")) return;
  const context = findContext(target);
  if (context?.rhythm) toggleRhythmSettings(context.rhythm.id);
});

elements.cycles.addEventListener("keydown", (event) => {
  const option = (event.target as HTMLElement).closest(".subdivision-option") as HTMLElement | null;
  if (!option) {
    if (event.key === "Escape" && openSubdivisionMenu) dismissSubdivisionMenu();
    return;
  }

  const options = [
    ...option.closest(".subdivision-menu").querySelectorAll(".subdivision-option"),
  ] as HTMLElement[];
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
  if (!openSubdivisionMenu || (event.target as HTMLElement).closest(".notation-picker")) return;
  openSubdivisionMenu = null;
  renderCycles();
});

// The arming click reaches here too, so a delete button is what keeps it armed.
document.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-delete-preset-id]")) return;
  dismissPendingDelete();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  dismissPendingDelete();
  // The dialog this panel replaced answered Escape natively, and a panel that
  // stopped doing so would be a regression a user notices before a test does.
  if (savePanelOpen && !engine.playing) closeSavePanel();
});

/**
 * A drag re-renders on every pointer move, so these two readouts are written
 * here rather than by re-rendering the grid around them. `textContent` is what
 * they must not be written with: it replaces the Text node instead of changing
 * it, and the node it replaces is one the renderer put there and still holds a
 * reference to, so every later render of this readout goes into a node that is
 * no longer in the document. Changing the node's data leaves the renderer's
 * reference pointing at what the reader is actually reading.
 */
function writeRenderedText(element: Element, text: string) {
  const readout = element.firstChild as Text;
  readout.data = text;
}

function writeReadout(rhythmElement: Element, field: string, text: string) {
  writeRenderedText(rhythmElement.querySelector(`[data-output="${field}"]`), text);
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
  if ((event.target as HTMLElement).matches(BALANCE_SLIDERS)) balanceSliderDragging = true;
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
  const target = event.target as HTMLInputElement;
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
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const field = target.dataset.field;
  if (!field || ["volume", "pan"].includes(field)) return;
  const context = findContext(target);
  if (!context) return;
  // The field is text rather than a number input, because a number input will
  // not hold a U+2212 at all — and the sign is the one thing a Flat has to be
  // able to say. What the field accepts and what it is left showing are
  // therefore both this listener's: the committed amount is written back, so an
  // entry the domain refuses — a fraction, or a number past the shape's range —
  // is left reading as what the envelope actually holds rather than as what was
  // typed at it.
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
  const committed = description.cycles
    .find(({ id }) => id === cycle.id)
    ?.rhythms.find(({ id }) => id === rhythm.id);
  if (committed) elements.status.textContent = `Meter ${committed.meter}`;
});

engine.addEventListener("playstate", () => {
  // Every transport run starts here, so this is the one place that knows the
  // tempo the audible run is playing at.
  runBpm = engine.playing ? state.bpm : null;
  renderTransport();
  renderCycles();
  if (engine.playing) startAnimation();
});
engine.addEventListener("audioerror", (event) => showError((event as CustomEvent).detail));
document.addEventListener("keydown", (event) => {
  if (elements.appShell.inert) return;
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

function checkAudioAfterForeground() {
  if (document.visibilityState === "visible") engine.checkAudioAfterForeground();
}

// A backgrounded tab can be frozen or discarded without ever firing pagehide,
// and hiding is the last moment a mobile browser reliably hands over.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistence.flush();
  else checkAudioAfterForeground();
});
window.addEventListener("pageshow", checkAudioAfterForeground);
document.addEventListener("resume", checkAudioAfterForeground);
window.addEventListener("focus", checkAudioAfterForeground);

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
// Before the first render rather than after it, so nothing is ever painted in a
// colour the browser did not choose. The shell paints before this module runs,
// but the regions the Accent reaches — the step grids, the Preset cards, the
// tick labels — are rendered from here and do not exist until it has.
applyAccent(loadAccent());
// The count is not part of `renderInterface`: no Configuration edit changes the
// stored list, so every edit-driven render would rewrite a number that cannot
// have moved. It is rendered once here and again wherever `savedPresets` does.
renderPresetCount();
elements.shareConfiguration.hidden = !(
  typeof CompressionStream === "function" && typeof DecompressionStream === "function"
);
elements.shareConfiguration.addEventListener("click", shareCurrentConfiguration);
// Started before the first render rather than after it: everything up to the
// decode runs synchronously, so a link already in the URL closes the workspace
// before anything is painted into it.
openSharedConfiguration(state);
renderInterface();

window.addEventListener("hashchange", () => {
  openSharedConfiguration(state);
});
