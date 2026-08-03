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

  await bpm.fill("250");
  await expect(heading).not.toHaveClass(/is-glitching/);
  await expect(page.getByLabel("BPM")).not.toHaveClass(/is-glitching/);
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
    const settings = page.locator(
      `#${await toggle.getAttribute("aria-controls")}`,
    );

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

test("a newly added rhythm opens its settings", async ({ page }) => {
  const addRhythm = page.getByRole("button", { name: "+ Rhythm" });

  await addRhythm.click();

  const rhythms = page.locator(".rhythm-card");
  await expect(rhythms).toHaveCount(2);
  await expect(rhythms.nth(1).locator(".rhythm-identity")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(rhythms.nth(1).locator(".rhythm-settings")).toBeVisible();
  await expect(addRhythm).toBeFocused();
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
  await expect(page.locator(".cycle-group.is-inactive").filter({ has: secondRepetitions })).toBeVisible();
  await expect(lockedFirstDot).toBeDisabled();
  await expect(lockedFirstDot).toHaveClass(/\bis-current\b/);
  await expect(lockedFirstDot).toHaveCSS("opacity", "1");
  expect(await lockedFirstDot.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
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
test("saving writes what storage holds now, not what this tab read at startup", async ({ page }) => {
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

test("deleting removes one preset without dropping presets this tab never saw", async ({ page }) => {
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

test("an open preset panel follows another tab's saves and deletions", async ({ page, context }) => {
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

test("a preset deleted in another tab stays deleted when this tab saves", async ({ page, context }) => {
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
  await expect(page.getByRole("status")).toHaveText("Delete Scratch preset? Select again to confirm");
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

  const ratio = await page.getByRole("button", { name: "Delete Chosen preset" })
    .evaluate((element) => {
      const channel = (value) => (value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4));
      const luminance = (colour) => {
        const [red, green, blue] = colour.match(/[\d.]+/g).slice(0, 3)
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

  // 3+1 is the shape this guards against: four beats have to wrap 4, 2, or 1 to
  // a row, and 768 is a width where packing by available space would not.
  for (const width of [375, 540, 700, 768, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    const rows = await page.evaluate(() => {
      const tops = [...document.querySelectorAll(".rhythm-card .beat")]
        .map((beat) => Math.round(beat.getBoundingClientRect().top));
      const perRow = new Map();
      for (const top of tops) perRow.set(top, (perRow.get(top) ?? 0) + 1);
      return [...perRow.values()];
    });

    expect(rows.length, `${width}px produced no rows`).toBeGreaterThan(0);
    expect(new Set(rows).size, `${width}px wrapped as ${rows.join("+")}`).toBe(1);
  }
});

test("core controls fit a 375px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  await expect(page.getByRole("button", { name: "Play metronome" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "BPM" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Cycle", exact: true })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});
