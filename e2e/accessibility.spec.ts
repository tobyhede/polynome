import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Every scan runs with reduced motion emulated, which is what makes this
 * deterministic rather than a source of intermittent failures.
 *
 * Scanning a panel the moment it opens catches it mid-`drawer-in`, part way
 * through a 140ms fade, and axe reads the half-transparent text as failing
 * contrast — a real measurement of a state no one can read anyway, reported as
 * a serious violation against markup that is correct once it settles.
 *
 * The reduced-motion block in `styles.css` sets only `scroll-behavior`,
 * `animation-duration`, `animation-iteration-count` and `transition-duration`,
 * plus the one rule that keeps that true: an animation filling forwards settles
 * on its final frame the moment its duration is clamped, so the beat pulse is
 * dropped there rather than run instantly to a frame holding no glow. The block
 * changes no colour, no size, and nothing's visibility, so the settled rendering
 * axe measures here is the same one everyone else sees — it simply arrives
 * immediately. Waiting on a timeout instead would trade this for a number that
 * is too short on a loaded CI runner and too slow everywhere else. The test at
 * the foot of this file is what holds the exception honest.
 */
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
});

async function scan(page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}

/**
 * Reported one violation per line with the elements it found, because the
 * default assertion prints the whole result object and buries which rule broke
 * on which node.
 */
function describeViolations(results) {
  return results.violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(" ")).join("\n      ");
      return `  [${violation.impact}] ${violation.id}: ${violation.help}\n      ${targets}`;
    })
    .join("\n");
}

/**
 * Colour is a property of a resting page. A panel part way through its opening
 * fade is showing a fraction of its own contrast — a card caught mid-`pop-in`
 * measures near 1:1 against the surface it is fading in over — and reporting
 * that as a violation blames the palette for a frame nobody sees. Being visible
 * is not the same as having arrived, which is why waiting on the element is not
 * enough.
 *
 * Only what finishes is waited for. The tempo glitch at the top of the range
 * repeats for as long as the tempo stays there, so waiting on it would never
 * return.
 */
async function settleAnimations(page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
  });
}

async function expectNoViolations(page) {
  await settleAnimations(page);
  const results = await scan(page);
  expect(results.violations, `\n${describeViolations(results)}\n`).toEqual([]);
}

test("the default view has no accessibility violations", async ({ page }) => {
  await expectNoViolations(page);
});

test("the help panel has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.locator("#help-panel")).toBeVisible();
  await expectNoViolations(page);
});

test("Share-link failure feedback has no accessibility violations", async ({ page }) => {
  await page.goto("/index.html#share=not-a-gzip-payload");
  await expect(page.locator("#feedback")).toBeVisible();
  await expectNoViolations(page);
});

/**
 * The swatches are the one row of controls here whose visible content is a
 * colour, so their names live entirely in the accessibility tree — a scan is
 * the only thing that would notice them going missing.
 */
test("the colour panel has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.locator("#accent-panel")).toBeVisible();
  await expectNoViolations(page);
});

test("the preset panel has no accessibility violations, populated and empty", async ({ page }) => {
  // A first run opens on the seeded example Presets, so this already scans a
  // populated list and the delete button every card carries.
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(page.locator("#preset-panel")).toBeVisible();
  await expectNoViolations(page);

  // + Save is live only while the Configuration differs from the Preset it came
  // from, so the tempo moves first. The save panel is scanned open, since it is
  // the only state in which its field and submit are in the document at all.
  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await bpm.fill(String(Number(await bpm.inputValue()) + 1));
  await bpm.blur();
  const openSave = page.getByRole("button", { name: "+ Save" });
  // The chip is never `disabled` — it is marked unavailable so that it keeps its
  // place in the tab order and can say why it will not act — so `aria-disabled`
  // is the attribute carrying whether it is being offered, and waiting on it is
  // waiting on the state this click needs. That is what `saveOffered` in
  // `e2e/polynome.spec.ts` asserts, and naming the mechanism keeps this test
  // from resting on a matcher's own reading of the attribute.
  await expect(openSave).toHaveAttribute("aria-disabled", "false");
  await openSave.click();
  const savePanel = page.getByRole("region", { name: "Save preset" });
  await savePanel.getByRole("textbox", { name: "Preset name" }).fill("Scanned");
  await expectNoViolations(page);

  await savePanel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
  await expect(page.getByRole("status")).toHaveText("Scanned preset saved");
  await expectNoViolations(page);

  // The armed-delete styling.
  await page.getByRole("button", { name: "Delete Scanned preset" }).click();
  await expect(page.getByRole("button", { name: "Confirm deleting Scanned preset" })).toBeVisible();
  await expectNoViolations(page);

  // An empty list is a state the listener now arrives at by deleting every
  // Preset, rather than the one a new browser opens in.
  await page.getByRole("button", { name: "Confirm deleting Scanned preset" }).click();
  for (const name of ["4/4 8ths", "4/4 Triplets"]) {
    await page.getByRole("button", { name: `Delete ${name} preset`, exact: true }).click();
    await page
      .getByRole("button", { name: `Confirm deleting ${name} preset`, exact: true })
      .click();
  }
  await expect(page.locator(".preset-card")).toHaveCount(0);
  await expectNoViolations(page);
});

/**
 * The settings panel holds most of the interface's form controls — the ones
 * carrying labels, described-by references and validity messages — and none of
 * them are in the document until a rhythm is opened.
 */
test("open rhythm settings have no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await expect(page.locator(".rhythm-settings").first()).toBeVisible();
  await expectNoViolations(page);
});

test("active and inactive Cycle envelope drawers have no accessibility violations", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Edit Cycle envelope" }).click();
  await expect(page.locator(".cycle-settings").first()).toBeVisible();
  await expectNoViolations(page);

  await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
  await page.getByRole("button", { name: "Edit Cycle 2 envelope" }).click();
  await page
    .getByRole("group", { name: "Cycle 2 repetitions" })
    .getByRole("button", { name: "Disable Cycle 2" })
    .click();
  await expect(page.locator(".cycle-settings").nth(1)).toBeVisible();
  await expectNoViolations(page);
});

test("the closed Cycle's envelope mark has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Cycle envelope" }).click();
  await page.locator(".cycle-settings").getByRole("button", { name: "Up" }).click();
  await page.getByRole("button", { name: "Edit Cycle envelope" }).click();

  await expect(page.locator(".envelope-mark")).toBeVisible();
  await expectNoViolations(page);
});

test("Subdivision Mode has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await page.getByRole("button", { name: "4/4 subdivision" }).click();
  await page.getByRole("option", { name: /3 per quarter unit/ }).click();
  await page.getByRole("button", { name: "Subdivision", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "4/4 step voices" }).getByRole("button"),
  ).toHaveCount(12);
  await expectNoViolations(page);
});

/**
 * The playhead restarts the beat pulse at every onset, so a sample taken at an
 * arbitrary instant reads wherever that pulse happens to be rather than where it
 * leaves the control. Waiting for every animation and transition on the element
 * to finish is what makes this the value the control settles on, and the element
 * is asked for again afterwards because the playhead may have moved on by then.
 */
function settledCurrentGlow(page) {
  return page.evaluate(async () => {
    const current = () => document.querySelector(".step.is-current");
    const running = current()?.getAnimations() ?? [];
    // A restarted animation rejects the promise of the one it replaced, and a
    // replacement is the ordinary case here rather than a failure.
    await Promise.all(running.map((animation) => animation.finished.catch(() => {})));
    const element = current();
    return element ? getComputedStyle(element).boxShadow : "absent";
  });
}

/**
 * Every scan above rests on the reduced-motion block changing only timing, and
 * `animation-fill-mode: forwards` is where a duration override stops being one:
 * clamped to nothing, an animation settles on its final frame immediately, and
 * the beat pulse's final frame is no glow at all. A listener who asks for less
 * motion is asking for less motion, not for the playhead to stop being visible.
 *
 * The current step in Subdivision Mode carries the same rule without the pulse
 * over it, so it is the glow this one is measured against rather than a colour
 * written out here that the stylesheet could move away from.
 */
test("the current beat keeps the current step's glow when motion is reduced", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect(page.locator('.steps[data-display-mode="beat"] .step.is-current')).toHaveCount(1);
  const beatGlow = await settledCurrentGlow(page);
  // Both readings come from one declaration, so a glow that stopped resolving
  // would agree with itself about there being none. This is what says there is
  // one at all.
  expect(beatGlow).not.toBe("none");

  await page.getByRole("button", { name: "Stop metronome" }).click();
  await page.getByRole("button", { name: "Subdivision", exact: true }).click();
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(
    page.locator('.steps[data-display-mode="subdivision"] .step.is-current'),
  ).toHaveCount(1);

  expect(beatGlow).toBe(await settledCurrentGlow(page));
});

test("the playing transport has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Playing");
  await expectNoViolations(page);
});
