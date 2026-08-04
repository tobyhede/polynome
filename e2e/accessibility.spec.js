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
 * `animation-duration`, `animation-iteration-count` and `transition-duration`.
 * It changes no colour, no size, and nothing's visibility, so the settled
 * rendering axe measures here is the same one everyone else sees — it simply
 * arrives immediately. Waiting on a timeout instead would trade this for a
 * number that is too short on a loaded CI runner and too slow everywhere else.
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

async function expectNoViolations(page) {
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

test("the preset panel has no accessibility violations, empty and populated", async ({ page }) => {
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(page.locator("#preset-panel")).toBeVisible();
  await expectNoViolations(page);

  // A saved preset adds the delete button and the armed-delete styling, none of
  // which exists in the built-in rows scanned above. + Save is live only while
  // the Configuration differs from the Preset it came from, so the tempo moves
  // first. The save panel is scanned open, since it is the only state in which
  // its field and submit are in the document at all.
  const bpm = page.getByLabel("Tempo in beats per minute");
  await bpm.fill(String(Number(await bpm.inputValue()) + 1));
  const openSave = page.getByRole("button", { name: "+ Save" });
  await expect(openSave).toBeEnabled();
  await openSave.click();
  const savePanel = page.getByRole("region", { name: "Save preset" });
  await savePanel.getByRole("textbox", { name: "Preset name" }).fill("Scanned");
  await expectNoViolations(page);

  await savePanel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
  await expect(page.getByRole("status")).toHaveText("Scanned preset saved");
  await expectNoViolations(page);

  await page.getByRole("button", { name: "Delete Scanned preset" }).click();
  await expect(page.getByRole("button", { name: "Confirm deleting Scanned preset" })).toBeVisible();
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

test("the playing transport has no accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Playing");
  await expectNoViolations(page);
});
