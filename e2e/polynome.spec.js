import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

// A preset button's accessible name opens with the preset name and continues
// into its notation summary, and the card's delete button carries the name too,
// so anchoring at the start is what distinguishes the two.
function presetButton(page, name) {
  return page.getByRole("button", { name: new RegExp(`^${name}\\b`) });
}

async function savePreset(page, name) {
  await page.getByRole("textbox", { name: "Save current preset" }).fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`${name} preset saved`);
}

// Deletion arms on the first press and runs on the second; see the test that
// pins that interaction for why it is not a dialog.
async function deletePreset(page, name) {
  await page.getByRole("button", { name: `Delete ${name} preset` }).click();
  await page.getByRole("button", { name: `Confirm deleting ${name} preset` }).click();
}

test("playback toggles from the button and Space key", async ({ page }) => {
  const playButton = page.getByRole("button", { name: "Play metronome" });
  const status = page.getByRole("status");

  await expect(playButton).toHaveAttribute("aria-pressed", "false");
  await playButton.click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(status).toHaveText("Playing");

  await page.getByRole("button", { name: "Stop metronome" }).click();
  await expect(status).toHaveText("Stopped");

  await page.getByRole("heading", { name: "Polynome" }).click();
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Playing");
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Stopped");
});

test("the heading shares the high-tempo BPM glitch", async ({ page }) => {
  const bpm = page.getByLabel("Tempo in beats per minute");
  const heading = page.getByRole("heading", { name: "Polynome" });

  await bpm.fill("251");
  await expect(heading).toHaveClass(/is-glitching/);
  await expect(page.getByLabel("BPM")).toHaveClass(/is-glitching/);
  await expect(heading).toHaveCSS("animation-name", "bpm-glitch");
  await expect(page.getByLabel("BPM")).toHaveCSS("animation-name", "bpm-glitch");

  await bpm.fill("250");
  await expect(heading).not.toHaveClass(/is-glitching/);
  await expect(page.getByLabel("BPM")).not.toHaveClass(/is-glitching/);
  await expect(heading).toHaveCSS("animation-name", "none");
  await expect(page.getByLabel("BPM")).toHaveCSS("animation-name", "none");
});

for (const [name, accessibleName] of [
  ["identity", "4/4 Edit 4/4 rhythm"],
  ["edit button", "Edit 4/4"],
]) {
  test(`rhythm settings preserve focus on the ${name}`, async ({ page }) => {
    const toggle = page.getByRole("button", {
      name: accessibleName,
      exact: true,
    });
    const settings = page.locator(`#${await toggle.getAttribute("aria-controls")}`);

    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(settings).toBeVisible();

    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(settings).toBeHidden();
  });
}

/**
 * The help panel offers the card double-click as one of three ways into a
 * rhythm's settings, and it was the only one nothing pinned. It is also the
 * one with a live exclusion beside it: the handler ignores double-clicks that
 * land on a control, so the identity button opens on the first click and the
 * second closes it again. Both halves are asserted, because the help text is
 * only right while both hold.
 */
test("a double-click opens rhythm settings from the card but not its name", async ({ page }) => {
  const identity = page.locator(".rhythm-identity").first();
  await expect(identity).toHaveAttribute("aria-expanded", "false");

  await page
    .locator(".rhythm-card")
    .first()
    .dblclick({ position: { x: 5, y: 5 } });
  await expect(identity).toHaveAttribute("aria-expanded", "true");

  await page
    .locator(".rhythm-card")
    .first()
    .dblclick({ position: { x: 5, y: 5 } });
  await expect(identity).toHaveAttribute("aria-expanded", "false");

  // Two clicks on the toggle itself are two toggles, not one double-click.
  await identity.dblclick();
  await expect(identity).toHaveAttribute("aria-expanded", "false");
});

test("a newly added rhythm opens its settings", async ({ page }) => {
  const addRhythm = page.getByRole("button", { name: "+ Rhythm" });

  await addRhythm.click();

  const rhythms = page.locator(".rhythm-card");
  await expect(rhythms).toHaveCount(2);
  await expect(rhythms.nth(1).locator(".rhythm-identity")).toHaveAttribute("aria-expanded", "true");
  await expect(rhythms.nth(1).locator(".rhythm-settings")).toBeVisible();
  await expect(addRhythm).toBeFocused();
});

test("Meter selects expose the complete constrained signature vocabulary", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const numerator = page.getByRole("combobox", { name: "4/4 meter numerator" });
  const denominator = page.getByRole("combobox", { name: "4/4 meter denominator" });

  await expect(numerator.locator("option")).toHaveText(
    Array.from({ length: 16 }, (_, index) => String(index + 1)),
  );
  await expect(denominator.locator("option")).toHaveText(["1", "2", "4", "8"]);
  await expect(numerator).toHaveValue("4");
  await expect(denominator).toHaveValue("4");

  await numerator.focus();
  await numerator.selectOption("7");
  await expect(page.getByRole("button", { name: "Edit 7/4", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "7/4 meter numerator" })).toBeFocused();
  // Both components announce what was committed, not the denominator alone.
  await expect(page.locator("#status")).toHaveText("Meter 7/4");

  const updatedDenominator = page.getByRole("combobox", {
    name: "7/4 meter denominator",
  });
  await updatedDenominator.focus();
  await updatedDenominator.selectOption("8");

  await expect(page.getByRole("button", { name: "Edit 7/8", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "7/8 meter denominator" })).toBeFocused();
  await expect(page.locator("#status")).toHaveText("Meter 7/8");
});

/**
 * A numerator committed during playback restarts the Transport, and the restart
 * reports "Playing" through the same live region the Meter announcement uses.
 * The committed Meter has to be the message left standing, which holds only
 * because the restart reaches its event synchronously; a restart that ever
 * began awaiting first would overwrite the announcement without failing
 * anything else.
 */
test("a Meter committed during playback announces the Meter, not the restart", async ({ page }) => {
  // Not `getByRole("status")`: an open rhythm's level and balance outputs carry
  // that role too, so only the transport's own region is addressed by id.
  const status = page.locator("#status");
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(status).toHaveText("Playing");

  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await page.getByRole("combobox", { name: "4/4 meter numerator" }).selectOption("5");

  await expect(page.getByRole("button", { name: "Edit 5/4", exact: true })).toBeVisible();
  await expect(status).toHaveText("Meter 5/4");
});

test("the widest rhythm grid is reachable through the constrained selects", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();

  await page.getByRole("combobox", { name: "4/4 meter numerator" }).selectOption("16");
  await page.getByRole("combobox", { name: "16/4 meter denominator" }).selectOption("8");
  await page.getByRole("button", { name: "16/8 subdivision" }).click();
  await page.getByRole("option").last().click();

  await expect(
    page.getByRole("group", { name: "16/8 step levels" }).getByRole("button"),
  ).toHaveCount(80);
});

test("a step control cycles full, half, quarter, off and back", async ({ page }) => {
  const steps = page.getByRole("group", { name: "4/4 step levels" });
  const first = steps.getByRole("button", { name: /^Step 1:/ });
  const second = steps.getByRole("button", { name: /^Step 2:/ });

  await expect(first).toHaveAttribute("aria-label", "Step 1: full level");
  await expect(second).toHaveAttribute("aria-label", "Step 2: half level");

  for (const level of ["half", "quarter", "off", "full"]) {
    await first.click();
    await expect(first).toHaveAttribute("aria-label", `Step 1: ${level} level`);
    await expect(second).toHaveAttribute("aria-label", "Step 2: half level");
  }
});

test("disabling a cycle preserves focus and the sole active cycle indicator", async ({ page }) => {
  await page.getByRole("button", { name: "+ Cycle", exact: true }).click();

  const firstRepetitions = page.getByRole("group", { name: "Cycle 1 repetitions" });
  const secondRepetitions = page.getByRole("group", { name: "Cycle 2 repetitions" });
  const firstDot = firstRepetitions.getByRole("button", { name: "Disable Cycle 1" });

  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(firstDot).toHaveClass(/\bis-current\b/);

  const disableSecond = secondRepetitions.getByRole("button", { name: "Disable Cycle 2" });
  await disableSecond.focus();
  await disableSecond.click();

  const enableSecond = secondRepetitions.getByRole("button", {
    name: "Set Cycle 2 to 1 repetition",
  });
  const lockedFirstDot = firstRepetitions.getByRole("button", {
    name: "Cycle 1 must remain active at 1 repetition",
  });
  await expect(enableSecond).toBeFocused();
  await expect(
    page.locator(".cycle-group.is-inactive").filter({ has: secondRepetitions }),
  ).toBeVisible();
  await expect(lockedFirstDot).toBeDisabled();
  await expect(lockedFirstDot).toHaveClass(/\bis-current\b/);
  await expect(lockedFirstDot).toHaveCSS("opacity", "1");
  expect(await lockedFirstDot.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
    "none",
  );
});

test("sound customization clears preset selection and persists", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  // A preset button carries its name and a notation preview, so its accessible
  // name is the whole summary; the identifier is what stays stable.
  const preset = page.locator('[data-preset-id="built-in-4-4"]');
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const lowSound = page.getByRole("button", { name: "low", exact: true });
  await lowSound.click();

  await expect(lowSound).toHaveAttribute("aria-pressed", "true");
  await expect(preset).toHaveAttribute("aria-pressed", "false");
  await expect(preset).not.toHaveClass(/\bis-selected\b/);

  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(page.locator('[data-preset-id="built-in-4-4"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The preset assertion above only shows the stored configuration differs from
  // the default one the "4/4" preset builds. Ask the sound itself, so the test
  // keeps meaning what its name says if preset matching ever changes.
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await expect(lowSound).toHaveAttribute("aria-pressed", "true");
});

/**
 * Saved Presets live under one storage key that every tab rewrites whole, so a
 * tab that saves from the list it read at startup writes back whatever another
 * tab has since removed. Writing from storage instead of from that snapshot is
 * what keeps a deletion deleted. The change here is made from inside this page,
 * which is precisely a change it cannot observe: a storage event reaches every
 * same-origin document except the one that wrote it.
 */
test("saving writes what storage holds now, not what this tab read at startup", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Shared");

  await page.evaluate(() => localStorage.setItem("polynome-presets", "[]"));
  await savePreset(page, "Later");

  await expect(presetButton(page, "Later")).toBeVisible();
  await expect(presetButton(page, "Shared")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(presetButton(page, "Later")).toBeVisible();
  await expect(presetButton(page, "Shared")).toHaveCount(0);
});

test("deleting removes one preset without dropping presets this tab never saw", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Doomed");

  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("polynome-presets"));
    stored.push({ id: "preset-elsewhere-1", name: "Keeper", configuration: {} });
    localStorage.setItem("polynome-presets", JSON.stringify(stored));
  });
  await deletePreset(page, "Doomed");

  await expect(page.getByRole("status")).toHaveText("Doomed preset deleted");
  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await expect(presetButton(page, "Keeper")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await expect(presetButton(page, "Keeper")).toBeVisible();
});

test("an open preset panel follows another tab's saves and deletions", async ({
  page,
  context,
}) => {
  const heading = page.getByRole("heading", { name: /^Presets/ });
  const other = await context.newPage();
  await other.goto("/");
  await page.getByRole("button", { name: "Presets" }).click();
  await other.getByRole("button", { name: "Presets" }).click();

  await savePreset(other, "Rehearsal");
  await expect(presetButton(page, "Rehearsal")).toBeVisible();
  await expect(heading).toContainText("3");

  await deletePreset(other, "Rehearsal");
  await expect(presetButton(page, "Rehearsal")).toHaveCount(0);
  await expect(heading).toContainText("2");
});

test("a preset deleted in another tab stays deleted when this tab saves", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Retired");

  await other.goto("/");
  await other.getByRole("button", { name: "Presets" }).click();
  await deletePreset(other, "Retired");
  await expect(presetButton(other, "Retired")).toHaveCount(0);

  await savePreset(page, "Current");
  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(presetButton(page, "Current")).toBeVisible();
  await expect(presetButton(page, "Retired")).toHaveCount(0);
});

/**
 * A modal blocks the renderer for as long as it is open, and the scheduler that
 * feeds the metronome is a 25ms interval on that same thread with a 120ms
 * horizon, so a confirm dialog stops the audio it is asking about. Confirming in
 * place keeps deletion deliberate without stalling anything.
 */
test("deleting a preset confirms in place without a browser dialog", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Scratch");

  await page.getByRole("button", { name: "Delete Scratch preset" }).click();
  const confirm = page.getByRole("button", { name: "Confirm deleting Scratch preset" });
  await expect(confirm).toBeFocused();
  await expect(page.getByRole("status")).toHaveText(
    "Delete Scratch preset? Select again to confirm",
  );
  await expect(presetButton(page, "Scratch")).toBeVisible();

  await confirm.click();
  await expect(page.getByRole("status")).toHaveText("Scratch preset deleted");
  await expect(presetButton(page, "Scratch")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("an armed delete is dismissed by Escape and by a click elsewhere", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Scratch");
  const remove = page.getByRole("button", { name: "Delete Scratch preset" });
  const confirm = page.getByRole("button", { name: "Confirm deleting Scratch preset" });

  await remove.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeVisible();
  // Dismissing rebuilds the card, so the key that cancelled must not also send
  // a keyboard user back to the top of the document.
  await expect(remove).toBeFocused();

  await remove.click();
  await expect(confirm).toBeVisible();
  await page.getByRole("heading", { name: "Polynome" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(presetButton(page, "Scratch")).toBeVisible();
});

test("deleting a preset another tab already removed says so and clears it", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Ghost");
  await page.evaluate(() => localStorage.setItem("polynome-presets", "[]"));

  await deletePreset(page, "Ghost");

  await expect(page.getByRole("status")).toHaveText("Ghost preset was already deleted");
  await expect(presetButton(page, "Ghost")).toHaveCount(0);
});

/**
 * Every tempo change re-rendered the preset list, which re-repairs each stored
 * Configuration and rebuilds the whole grid — work that lands on the same thread
 * as the scheduler, for a panel nobody is looking at. The list is rebuilt when
 * the panel opens instead.
 */
test("a hidden preset panel is not rebuilt while the tempo changes", async ({ page }) => {
  const heading = page.getByRole("heading", { name: /^Presets/ });
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Watched");
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(heading).toBeHidden();

  await page.evaluate(() => {
    window.presetListRebuilds = 0;
    new MutationObserver((records) => {
      window.presetListRebuilds += records.length;
    }).observe(document.querySelector("#preset-list"), { childList: true });
  });

  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  await slider.focus();
  for (let press = 0; press < 10; press += 1) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toHaveValue("106");

  expect(await page.evaluate(() => window.presetListRebuilds)).toBe(0);

  await page.getByRole("button", { name: "Presets" }).click();
  await expect(presetButton(page, "Watched")).toBeVisible();
  await expect(heading).toContainText("3");
});

/**
 * Resolving `localStorage` can throw outright, not merely fail per method. The
 * metronome still works, so saving still has to answer honestly: the preset
 * stays on screen and the status says it was not persisted. A refused read is
 * not an empty store, which is why the second save keeps the first.
 */
test("saving into refused storage is reported and keeps earlier saves", async ({ browser }) => {
  // This context is not the one the test fixture manages, so a failed assertion
  // would leak it for the rest of the run without the finally.
  const denied = await browser.newContext();
  try {
    await denied.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("Access denied", "SecurityError");
        },
      });
    });
    const page = await denied.newPage();
    const status = page.getByRole("status");
    const name = page.getByRole("textbox", { name: "Save current preset" });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Presets" }).click();

    await name.fill("First");
    await save.click();
    await expect(status).toHaveText("Preset could not be saved in this browser");
    await expect(presetButton(page, "First")).toBeVisible();

    await name.fill("Second");
    await save.click();
    await expect(presetButton(page, "Second")).toBeVisible();
    await expect(presetButton(page, "First")).toBeVisible();

    await deletePreset(page, "First");
    await expect(status).toHaveText("Preset deletion could not be saved in this browser");
    await expect(presetButton(page, "First")).toHaveCount(0);
    await expect(presetButton(page, "Second")).toBeVisible();
  } finally {
    await denied.close();
  }
});

/**
 * A tempo change can only alter which Preset is selected: every name, notation
 * and delete button is a function of that Preset's own stored Configuration, not
 * of the current one. Rebuilding the grid to change one attribute throws away
 * identical DOM on every pointer move of a drag.
 */
test("an open preset panel is not rebuilt when only the selection changes", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Watched");
  const builtIn = page.locator('[data-preset-id="built-in-4-4"]');
  await builtIn.click();
  await expect(builtIn).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    window.presetListRebuilds = 0;
    new MutationObserver((records) => {
      window.presetListRebuilds += records.length;
    }).observe(document.querySelector("#preset-list"), { childList: true, subtree: true });
  });

  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  await slider.focus();
  for (let press = 0; press < 10; press += 1) await page.keyboard.press("ArrowRight");

  await expect(builtIn).toHaveAttribute("aria-pressed", "false");
  await expect(builtIn).not.toHaveClass(/\bis-selected\b/);
  await expect(presetButton(page, "Watched")).toBeVisible();
  expect(await page.evaluate(() => window.presetListRebuilds)).toBe(0);
});

/**
 * The rebuild that adopts another tab's deletion destroys whatever the user had
 * focused. Restoring by identifier finds nothing when the identifier is what was
 * deleted, and focus falls to the document, which is where a keyboard user least
 * expects to be. The save field is where deleting in this tab already leaves it.
 */
test("focus survives another tab deleting the preset it was on", async ({ page, context }) => {
  const other = await context.newPage();
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Doomed");
  await page.getByRole("button", { name: "Delete Doomed preset" }).focus();

  await other.goto("/");
  await other.getByRole("button", { name: "Presets" }).click();
  await deletePreset(other, "Doomed");

  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Save current preset" })).toBeFocused();
});

/**
 * A selected card paints the accent colour under its delete button, which keeps
 * the muted grey it was given for the unselected surface. The declared colours
 * are each fine against the surface they were written for, so only the rendered
 * pair shows it: the glyph all but disappears on the card the user just picked.
 */
test("the delete glyph stays readable on a selected preset", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await savePreset(page, "Chosen");
  const preset = presetButton(page, "Chosen");
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");

  const ratio = await page
    .getByRole("button", { name: "Delete Chosen preset" })
    .evaluate((element) => {
      const channel = (value) =>
        value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      const luminance = (colour) => {
        const [red, green, blue] = colour
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map((value) => channel(Number(value) / 255));
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      // The glyph is transparent, so the colour behind it is the selected
      // button's, which is the pair a reader actually sees.
      const glyph = luminance(getComputedStyle(element).color);
      const behind = luminance(getComputedStyle(element.previousElementSibling).backgroundColor);
      return (Math.max(glyph, behind) + 0.05) / (Math.min(glyph, behind) + 0.05);
    });

  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("beats wrap into equal rows at every width", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await page.locator('[data-action="toggle-subdivision-menu"]').first().click();
  await page.locator('.subdivision-option[data-subdivision="4"]').click();
  await expect(page.locator(".rhythm-card .step")).toHaveCount(16);
  // Sixteen steps alone do not pin the grouping this test measures: eight beats
  // of two would satisfy that count and still wrap evenly.
  await expect(page.locator(".rhythm-card .beat")).toHaveCount(4);

  // 3+1 is the shape this guards against: four beats have to wrap 4, 2, or 1 to
  // a row, and 768 is a width where packing by available space would not.
  for (const width of [375, 540, 700, 768, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = await settledBeatsPerRow(page, width);

    expect(rows.length, `${width}px produced no rows`).toBeGreaterThan(0);
    expect(new Set(rows).size, `${width}px wrapped as ${rows.join("+")}`).toBe(1);
  }
});

/**
 * Waits for a resize to land on equal rows, then hands that grouping back.
 *
 * Every caller asserts the same precondition — the rows are equal — and a
 * resize reaches it through intermediate frames, so this is what separates a
 * layout still on its way from one that is genuinely wrong. Polling re-measures
 * the geometry each attempt; a fixed frame count only guesses how long settling
 * takes. The pattern is the invariant itself: a `+`-joined grouping whose every
 * row repeats the first row's count.
 */
async function settledBeatsPerRow(page, width) {
  await expect
    .poll(async () => (await beatsPerRow(page)).join("+"), {
      message: `${width}px never settled into equal rows`,
    })
    .toMatch(/^(\d+)(\+\1)*$/);
  return beatsPerRow(page);
}

/**
 * Reads the beat grouping off the rendered layout: how many beats share each
 * row, top to bottom. The grouping is only ever expressed as geometry, so
 * asserting on `--beats-per-row` would test the input rather than the result.
 */
async function beatsPerRow(page) {
  return page.evaluate(() => {
    const perRow = new Map();
    for (const beat of document.querySelectorAll(".rhythm-card .beat")) {
      const top = Math.round(beat.getBoundingClientRect().top);
      perRow.set(top, (perRow.get(top) ?? 0) + 1);
    }
    return [...perRow.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count);
  });
}

async function setSignature(page, count) {
  await page
    .getByRole("button", { name: /^Edit \d+\/\d+$/ })
    .first()
    .click();
  await page.getByRole("combobox", { name: /meter numerator$/ }).selectOption(String(count));
}

async function setSubdivision(page, subdivision) {
  await page.locator('[data-action="toggle-subdivision-menu"]').first().click();
  await page.locator(`.subdivision-option[data-subdivision="${subdivision}"]`).click();
}

/**
 * A prime beat count has no divisor between one and itself, so the rule's whole
 * job is to refuse the plausible-looking uneven split. 7/8 must be one row of
 * seven or seven rows of one, never 4+3.
 */
test("a prime meter never splits into unequal rows", async ({ page }) => {
  await setSignature(page, 7);
  await expect(page.locator(".rhythm-card .beat")).toHaveCount(7);

  for (const width of [375, 540, 700, 768, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = await settledBeatsPerRow(page, width);

    expect(new Set(rows).size, `${width}px wrapped as ${rows.join("+")}`).toBe(1);
    expect([7, 1], `${width}px grouped ${rows[0]} beats to a row`).toContain(rows[0]);
  }
});

/**
 * The sixteen-step ceiling is an invariant here rather than a discriminating
 * case: the shell caps at 1000px, which leaves at most ~966px of row, and
 * seventeen 58px steps need ~1146px. Width therefore rejects every grouping the
 * ceiling would have rejected, and no viewport makes the ceiling the deciding
 * bound. This pins the property anyway — widening the shell or shrinking a step
 * is exactly the change that would let a thirty-two step row through, and this
 * is what would notice.
 */
for (const { beats, subdivision, steps } of [
  { beats: 8, subdivision: 4, steps: 32 },
  { beats: 16, subdivision: 2, steps: 32 },
]) {
  test(`${beats} beats of ${subdivision} never puts more than sixteen steps on a row`, async ({
    page,
  }) => {
    await setSignature(page, beats);
    if (subdivision !== 1) await setSubdivision(page, subdivision);
    await expect(page.locator(".rhythm-card .step")).toHaveCount(steps);

    for (const width of [1600, 1024, 540]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await settledBeatsPerRow(page, width);

      expect(new Set(rows).size, `${width}px wrapped as ${rows.join("+")}`).toBe(1);
      expect(
        rows[0] * subdivision,
        `${width}px put ${rows[0] * subdivision} steps on a row`,
      ).toBeLessThanOrEqual(16);
    }
  });
}

/**
 * When even one beat is wider than the row there is no grouping left to choose,
 * so the pattern scrolls rather than shrinking the steps. Nothing else asserts
 * that the fallback both engages and actually scrolls.
 */
test("a beat wider than the row scrolls instead of shrinking", async ({ page }) => {
  // A beat of five is the case the fallback exists for: five 52px steps and
  // their gaps are 300px, and the narrowest row is 274px.
  await setSignature(page, 3);
  await setSubdivision(page, 5);
  await page.setViewportSize({ width: 320, height: 900 });

  const steps = page.locator(".rhythm-card .steps");
  await expect(steps).toHaveClass(/is-scrolling/);

  const overflow = await steps.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(overflow.overflowX).toBe("auto");
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

  // The page itself must not inherit the overflow; only the step row scrolls.
  const document_ = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(document_.scroll).toBeLessThanOrEqual(document_.client);

  // Overlay scrollbars show nothing at rest, so the fade is the only cue that
  // the row continues.
  await expect(steps).not.toHaveCSS("mask-image", "none");

  // ...but it must not dim the focus ring of a step the user has tabbed to.
  await steps.getByRole("button").last().focus();
  await expect(steps).toHaveCSS("mask-image", "none");
});

test("core controls fit a 375px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  await expect(page.getByRole("button", { name: "Play metronome" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Cycle", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "4/4 meter denominator" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

async function settleLayout(page) {
  await page.evaluate(
    () =>
      new Promise((settle) => {
        requestAnimationFrame(() => requestAnimationFrame(settle));
      }),
  );
}

/**
 * The readout is a box positioned over the tempo it names, so its width has to
 * be the width of the digits inside it: the box is what centres the number on
 * its own point of the track, and what `--bpm-half` measures to keep it inside
 * the card.
 *
 * A reader who raises their browser's default text size is what pulls the two
 * apart. The glyphs are sized in `rem` and grow; a width computed in pixels
 * from an assumed 16px root does not.
 */
test("the tempo readout fits its digits at an enlarged root text size", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 24px }" });
  await page.getByLabel("Tempo in beats per minute").fill("300");
  await settleLayout(page);

  const readout = await page.locator("#bpm-readout").evaluate((element) => ({
    box: element.getBoundingClientRect().width,
    digits: element.querySelector("input").scrollWidth,
  }));

  expect(readout.box).toBeGreaterThanOrEqual(readout.digits);
});

/**
 * `container-type` makes the transport card a query container for what is
 * inside it, never for itself — a container's own declarations cannot query the
 * size those declarations would change. So the card's own spacing resolves
 * against the viewport while its contents resolve against the card.
 *
 * The 4% and 13% below deliberately mirror the stylesheet: the question this
 * asks is not what the percentages are but which box each one applies to, and
 * the `not` assertions are what make it an answer rather than a restatement.
 * Below about 500px the two candidates straddle the clamps and disagree, which
 * is the only place the difference is observable.
 */
test("transport spacing follows the viewport and its contents follow the card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await settleLayout(page);

  const measured = await page.evaluate(() => {
    const card = document.querySelector(".transport");
    const style = getComputedStyle(card);
    return {
      viewportWidth: window.innerWidth,
      cardWidth: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      padding: parseFloat(style.paddingTop),
      playHeight: parseFloat(getComputedStyle(document.querySelector(".play-button")).height),
    };
  });

  const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
  const share = (percent, of) => (percent * of) / 100;

  expect(measured.cardWidth).toBeLessThan(measured.viewportWidth);
  expect(measured.padding).toBeCloseTo(clamp(14, share(4, measured.viewportWidth), 20), 1);
  expect(measured.padding).not.toBeCloseTo(clamp(14, share(4, measured.cardWidth), 20), 1);
  expect(measured.playHeight).toBeCloseTo(clamp(48, share(13, measured.cardWidth), 60), 1);
  expect(measured.playHeight).not.toBeCloseTo(clamp(48, share(13, measured.viewportWidth), 60), 1);
});

/**
 * The readout travels the width of the track and grows with the tempo, so the
 * two ends are where it can hang off the card. Nothing else pins that: the
 * inline padding that used to reserve room for it is gone, and `--bpm-half`
 * now holds it half its own width inside either end instead.
 */
test("the travelling tempo readout stays inside the transport card", async ({ page }) => {
  for (const width of [320, 375, 540, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const bpm of [30, 96, 300]) {
      await page.getByLabel("Tempo in beats per minute").fill(String(bpm));
      await settleLayout(page);

      const {
        readout,
        card,
        page: viewport,
      } = await page.evaluate(() => {
        const box = (selector) => {
          const { left, right } = document.querySelector(selector).getBoundingClientRect();
          return { left, right };
        };
        return {
          readout: box("#bpm-readout"),
          card: box(".transport"),
          page: {
            client: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
          },
        };
      });

      const where = `${width}px at ${bpm}bpm`;
      expect(readout.left, `${where} overhangs the card on the left`).toBeGreaterThanOrEqual(
        card.left,
      );
      expect(readout.right, `${where} overhangs the card on the right`).toBeLessThanOrEqual(
        card.right,
      );
      expect(viewport.scroll, `${where} widened the page`).toBeLessThanOrEqual(viewport.client);
    }
  }
});
