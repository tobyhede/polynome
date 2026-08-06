import { expect, test } from "@playwright/test";

/**
 * What the interface costs per frame, counted rather than timed.
 *
 * These four assertions are in a browser because they have nowhere else to be:
 * there is no DOM in Node, and a hand-built one would be measuring the fake.
 * Everything else in the performance suite — audio node allocation, AudioParam
 * traffic, planned-event structure, artifact bytes — is in `test/` and needs no
 * browser at all.
 *
 * Nothing here asserts a duration. `performance.now()` is quantised to 100 µs
 * outside a cross-origin-isolated context, which is coarser than a whole
 * scheduler tick, so an in-page timing of this application would be measuring
 * the clock. The costs that are real are counts: selector-engine calls the
 * playhead repeats sixty times a second, and a read/write ordering in
 * `layoutSteps` that turns one forced layout into one per rhythm the moment it
 * is broken.
 *
 * See `docs/research/performance-optimisation-and-regression-testing.md`.
 */

/**
 * Wraps the DOM entry points whose cost this suite cares about, before any
 * application code runs.
 *
 * The reads and the writes are recorded into one ordered log rather than two
 * counters, because the ordering is itself an assertion: the Chrome team's rule
 * is to batch style reads first and writes after, and `layoutSteps` is written
 * to it. A log is the only shape that can answer "did a read follow a write".
 */
const INSTRUMENT = () => {
  const log = [];
  let recording = false;

  const wrap = (owner, name, kind) => {
    const original = owner[name];
    owner[name] = function instrumented(...args) {
      if (recording) log.push({ kind, name });
      return original.apply(this, args);
    };
  };

  // Selector-engine calls: the playhead's per-frame cost.
  wrap(Element.prototype, "querySelector", "select");
  wrap(Element.prototype, "querySelectorAll", "select");
  wrap(Document.prototype, "querySelector", "select");
  wrap(Document.prototype, "querySelectorAll", "select");

  // Layout-forcing reads and the style writes they must precede.
  wrap(Element.prototype, "getBoundingClientRect", "read");
  wrap(window, "getComputedStyle", "read");

  // The write side records which property it wrote, because the assertion is
  // about one pass rather than about the whole render. A step click renders
  // through Preact first, and reconciliation writes inline styles of its own
  // well before `layoutSteps` starts measuring; treating those as the boundary
  // would report the measure loop as a violation of an ordering it satisfies.
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function instrumented(property, ...rest) {
    if (recording) log.push({ kind: "write", name: property });
    return setProperty.call(this, property, ...rest);
  };

  const escapeIdentifier = CSS.escape.bind(CSS);
  CSS.escape = (value) => {
    if (recording) log.push({ kind: "escape", name: "CSS.escape" });
    return escapeIdentifier(value);
  };

  window.__perf = {
    start() {
      log.length = 0;
      recording = true;
    },
    stop() {
      recording = false;
      return log.slice();
    },
    /** Counts one frame at a time, so a per-frame budget is a real per-frame number. */
    async overFrames(frames) {
      const perFrame = [];
      for (let index = 0; index < frames; index += 1) {
        log.length = 0;
        recording = true;
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        recording = false;
        perFrame.push({
          select: log.filter((entry) => entry.kind === "select").length,
          escape: log.filter((entry) => entry.kind === "escape").length,
        });
      }
      return perFrame;
    },
  };
};

const startPlaying = async (page) => {
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toBeVisible();
};

/** Fills the one Cycle to `MAX_RHYTHMS`, which is the shape every budget below is set against. */
const fillToMaximumRhythms = async (page) => {
  const add = page.locator(".add-rhythm").first();
  for (let index = 0; index < 11; index += 1) {
    if (await add.isDisabled()) break;
    await add.click();
  }
  await expect(page.locator("[data-layer-id]")).toHaveCount(12);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(INSTRUMENT);
  await page.goto("/");
});

/**
 * `updateActiveSteps` re-derives every element it touches from a selector on
 * every frame: three per Cycle and two per rhythm layer, plus a `CSS.escape`
 * for each identifier it interpolates. At twelve layers that is up to 39
 * selector calls and 13 escapes per frame — 2,340 and 780 per second — none of
 * which describes an element that moved.
 *
 * The budgets are the structural maxima — `3C + 2R` selector calls and `C + R`
 * escapes, plus one `querySelectorAll(".step")` per rhythm on a frame where an
 * onset moves the highlight. A sample that catches no onset frame measures the
 * lower figure, which is why the budget is set at the maximum rather than at
 * what a given run happens to observe: a run that does catch one must not fail.
 *
 * They are ceilings in the spirit of the coverage ratchet: raise deliberately,
 * never lower one to make a change fit. Caching those lookups is a candidate
 * optimisation the research ranked "measure first", and this is the measurement
 * it was waiting for.
 */
test("the playhead frame does not grow its per-frame selector cost", async ({ page }) => {
  await startPlaying(page);
  const frames = await page.evaluate(() => window.__perf.overFrames(30));

  const worstSelect = Math.max(...frames.map((frame) => frame.select));
  const worstEscape = Math.max(...frames.map((frame) => frame.escape));
  console.log(`one layer: worst frame ${worstSelect} selector calls, ${worstEscape} CSS.escape`);

  expect(
    worstSelect,
    "selector-engine calls in the busiest frame at one rhythm layer",
  ).toBeLessThanOrEqual(6);
  expect(
    worstEscape,
    "CSS.escape calls in the busiest frame at one rhythm layer",
  ).toBeLessThanOrEqual(2);
});

test("the playhead frame stays inside budget at the domain maximum", async ({ page }) => {
  await fillToMaximumRhythms(page);
  await startPlaying(page);
  const frames = await page.evaluate(() => window.__perf.overFrames(30));

  const worstSelect = Math.max(...frames.map((frame) => frame.select));
  const worstEscape = Math.max(...frames.map((frame) => frame.escape));
  console.log(
    `twelve layers: worst frame ${worstSelect} selector calls, ${worstEscape} CSS.escape`,
  );

  expect(
    worstSelect,
    "selector-engine calls in the busiest frame at twelve rhythm layers",
  ).toBeLessThanOrEqual(39);
  expect(
    worstEscape,
    "CSS.escape calls in the busiest frame at twelve rhythm layers",
  ).toBeLessThanOrEqual(13);
});

/**
 * The invariant `layoutSteps` was written to hold and has no test for.
 *
 * It measures every rhythm and only then writes every rhythm, because a write
 * invalidates the layout the next read needs: interleaving costs one
 * synchronous reflow per rhythm instead of one for the pass, on every render
 * including every step click. This is not a threshold — it is a correctness
 * property, and the number it protects grows with the number of layers on
 * screen, which is exactly when it matters most.
 *
 * A step click is the cheapest way to provoke the pass, because `renderCycles`
 * calls `layoutSteps` at the end of every render.
 */
test("a render measures every rhythm before it writes any", async ({ page }) => {
  await fillToMaximumRhythms(page);

  await page.evaluate(() => window.__perf.start());
  await page.locator(".step").first().click();
  const log = await page.evaluate(() => window.__perf.stop());

  // The pass is bounded by the property it exists to write. Anything before the
  // first `--beats-per-row` is the render that preceded it; anything after the
  // last is whatever ran next.
  const writes = log
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.kind === "write" && entry.name === "--beats-per-row");

  expect(writes.length, "the click provoked no layoutSteps pass to check").toBeGreaterThan(0);

  const readsInsideWritePhase = log
    .slice(writes[0].index, writes.at(-1).index + 1)
    .filter((entry) => entry.kind === "read")
    .map((entry) => entry.name);

  expect(
    readsInsideWritePhase,
    "a layout-forcing read landed between two row-count writes, which costs one synchronous reflow per rhythm instead of one for the pass",
  ).toEqual([]);

  // The measure phase has to have happened, or the assertion above holds
  // vacuously against a pass that measured nothing.
  const readsBeforeWritePhase = log
    .slice(0, writes[0].index)
    .filter((entry) => entry.kind === "read").length;
  expect(readsBeforeWritePhase, "every rhythm is measured before any is written").toBeGreaterThan(
    0,
  );
});

/**
 * The one end-to-end check that the scheduler is not being starved, expressed
 * as a boolean at a threshold three thousand times the measured cost of a tick.
 *
 * A long task is 50 ms of blocked main thread. The look-ahead absorbs stalls up
 * to 120 ms, so a single long task is not yet audible — which is the point of
 * asserting zero rather than asserting that audio survived. This catches the
 * regression while it is still inaudible.
 *
 * What is measured is *steady-state* playback. Starting a run creates the
 * AudioContext, which acquires a device and a render thread, and that is
 * measured here at around 130 ms — genuinely a long task, genuinely once, and
 * unavoidable: the context cannot be created before the gesture that permits
 * it. Including it would make this assert that starting audio is free, which is
 * not a property anything can hold. The observer therefore goes in after the
 * run has settled, and what it watches is the loop that then runs forever.
 */
test("steady-state playback produces no long task", async ({ page }) => {
  await fillToMaximumRhythms(page);
  await startPlaying(page);
  await page.waitForTimeout(1_000);

  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
  });
  await page.waitForTimeout(5_000);

  const durations = await page.evaluate(() => window.__longTasks);
  expect(durations, `long tasks during playback: ${durations.join(", ")}`).toEqual([]);
});
