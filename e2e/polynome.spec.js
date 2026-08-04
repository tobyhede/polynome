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

// The example Presets carry generated identifiers like every other Preset, and
// one name is a prefix of the other, so a card is found through the delete
// button that names it exactly rather than by an identifier or a prefix.
function presetCard(page, name) {
  return page
    .locator(".preset-card")
    .filter({ has: page.getByRole("button", { name: `Delete ${name} preset`, exact: true }) });
}

/**
 * Whether + Save is being offered. It is marked unavailable rather than
 * disabled — it stays in the tab order to say why it will not act — so the
 * attribute is what carries the state, and asserting on it names the mechanism
 * instead of trusting a matcher's reading of it.
 */
function saveOffered(page) {
  return expect(page.getByRole("button", { name: "+ Save" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
}

function saveNotOffered(page) {
  return expect(page.getByRole("button", { name: "+ Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
}

/**
 * + Save is live only while the current Configuration differs from the Preset it
 * came from, so a test that wants to save has to have changed something first.
 * Nudging the tempo is the cheapest edit that does not disturb the Sequence any
 * assertion is about, and it is skipped when there is already something to save.
 *
 * Saving is reachable whether or not the preset panel is open, so this does not
 * open it. The submit reads "Replace" once the typed name is one already stored.
 */
async function savePreset(page, name) {
  const open = page.getByRole("button", { name: "+ Save" });
  if ((await open.getAttribute("aria-disabled")) === "true") {
    const bpm = page.getByLabel("Tempo in beats per minute");
    await bpm.fill(String(Number(await bpm.inputValue()) + 1));
  }
  await saveOffered(page);
  await open.click();
  const panel = page.getByRole("region", { name: /^Save preset/ });
  await panel.getByRole("textbox", { name: "Preset name" }).fill(name);
  await panel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
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

/**
 * The tick row marks every ten BPM and a drag stops on those marks. Asserting a
 * particular tempo at a particular offset would pin the browser's own mapping
 * from pointer position to value, half a thumb width inset at either end, so
 * what is asserted is the property the snap has: a dragged tempo is either on a
 * mark or clear of one by more than the tolerance, never stranded beside it.
 */
test("dragging the tempo slider stops on the ten-BPM marks", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  const track = await slider.boundingBox();
  const y = track.y + track.height / 2;
  const from = track.x + track.width * 0.3;

  await page.mouse.move(from, y);
  await page.mouse.down();
  const dragged = [];
  for (let offset = 0; offset <= 40; offset += 2) {
    await page.mouse.move(from + offset, y);
    dragged.push(Number(await slider.inputValue()));
  }
  await page.mouse.up();

  const distanceToMark = (bpm) => Math.min(bpm % 10, 10 - (bpm % 10));
  expect(dragged.filter((bpm) => distanceToMark(bpm) > 0 && distanceToMark(bpm) <= 2)).toEqual([]);
  // Both confirm the drag moved and that it crossed marks rather than sitting
  // in one gap the whole way, which would satisfy the assertion above trivially.
  expect(dragged.at(-1)).toBeGreaterThan(dragged[0]);
  expect(new Set(dragged.filter((bpm) => bpm % 10 === 0)).size).toBeGreaterThan(1);
});

/**
 * Only the pointer snaps. A keyboard step of one away from a mark would be
 * pulled straight back onto it, and the slider would be stuck on that mark for
 * good, so the arrow keys reach the tempos between the marks and the number
 * input keeps them.
 *
 * The starting tempo is set here rather than taken from the default, so moving
 * that default reads as a changed default rather than as a snap that stopped
 * working.
 */
test("the tempo arrow keys reach and hold the tempos between the marks", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  const readout = page.getByRole("spinbutton", { name: "BPM" });

  await readout.fill("98");
  await readout.blur();
  await expect(slider).toHaveValue("98");

  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(readout).toHaveValue("99");
  await page.keyboard.press("ArrowRight");
  await expect(readout).toHaveValue("100");
  // Stepping off a mark is the case the snap would undo.
  await page.keyboard.press("ArrowRight");
  await expect(readout).toHaveValue("101");

  await readout.fill("108");
  await readout.blur();
  await expect(slider).toHaveValue("108");
});

/**
 * A press can end without the slider ever seeing a release: the context menu
 * takes a right button's, and a press abandoned when the window loses the
 * pointer ends the same way. The drag flag is raised on `pointerdown`, so one
 * left raised would go on snapping — and the first arrow key after it would be
 * pulled straight back onto the mark it stepped off, which is the state the
 * flag exists to prevent. Pressing a key ends the drag for that reason.
 */
test("a press the slider is never released from leaves the arrow keys unsnapped", async ({
  page,
}) => {
  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const track = await slider.boundingBox();

  await page.mouse.move(track.x + track.width * 0.3, track.y + track.height / 2);
  await page.mouse.down({ button: "right" });

  await readout.fill("100");
  await readout.blur();
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(readout).toHaveValue("101");
});

/**
 * The tick row is the drawn form of the marks `snapTempo` stops on, and the
 * slider's own bounds are the range those marks span. The row is built from the
 * model's constants and the bounds are attributes in `index.html`, which cannot
 * import anything, so this is where the three are held to one another.
 */
test("the tick row and the slider's bounds are the tempo range the model names", async ({
  page,
}) => {
  const { limit, interval } = await page.evaluate(async () => {
    const { TEMPO_LIMIT, TEMPO_SNAP } = await import("/model.js");
    return { limit: TEMPO_LIMIT, interval: TEMPO_SNAP.interval };
  });
  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });

  await expect(slider).toHaveAttribute("min", String(limit.minimum));
  await expect(slider).toHaveAttribute("max", String(limit.maximum));

  const marks = await page
    .locator("#bpm-ticks span")
    .evaluateAll((ticks) => ticks.map((tick) => Number(tick.dataset.bpm)));
  expect(marks).toEqual(
    Array.from(
      { length: (limit.maximum - limit.minimum) / interval + 1 },
      (_, index) => limit.minimum + index * interval,
    ),
  );
});

test("storage from the wider meter domain is retired instead of repaired", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("polynome-configuration", JSON.stringify({ bpm: 132 }));
    localStorage.setItem("polynome-presets", JSON.stringify([]));
  });

  await page.reload();

  await expect(page.getByLabel("Tempo in beats per minute")).toHaveValue("96");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        configuration: localStorage.getItem("polynome-configuration"),
        presets: localStorage.getItem("polynome-presets"),
      })),
    )
    .toEqual({ configuration: null, presets: null });
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
  await showSubdivisionMode(page);

  await expect(
    page.getByRole("group", { name: "16/8 step voices" }).getByRole("button"),
  ).toHaveCount(80);
});

/**
 * A drag writes these readouts directly rather than re-rendering the grid on
 * every pointer move, and the renderer owns the same text. Assigning
 * `textContent` swaps in a fresh Text node, which leaves the reconciler holding
 * a detached one and quietly writing every later update into it — the readout
 * then keeps whatever the last drag left and never moves again. Nothing on
 * screen shows that, because a drag's own write is always the current value, so
 * the identity of the node is what has to be asserted.
 */
for (const [field, control, expected] of [
  ["volume", "4/4 level", "40%"],
  ["pan", "4/4 stereo balance", "Right 40%"],
]) {
  test(`dragging the ${field} keeps the readout node the renderer created`, async ({ page }) => {
    await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
    const readout = `[data-output="${field}"]`;
    await page.evaluate((selector) => {
      window.renderedReadout = document.querySelector(selector).firstChild;
    }, readout);

    await page.getByRole("slider", { name: control }).fill("0.4");

    expect(
      await page.evaluate(
        (selector) => ({
          survived: document.querySelector(selector).firstChild === window.renderedReadout,
          text: document.querySelector(selector).textContent,
        }),
        readout,
      ),
    ).toEqual({ survived: true, text: expected });
  });
}

/**
 * Level and Balance stop on marks the way the tempo does. Asserting a particular
 * value at a particular offset would pin the browser's own mapping from pointer
 * position to value, half a thumb width inset at either end, so what is asserted
 * is the property the snap has: a dragged value is either on a mark or clear of
 * one by more than the tolerance, never stranded beside it.
 *
 * Both are counted in the percent their marks are spaced in rather than in the
 * fraction the slider carries, because that is the domain the snap works in and
 * a comparison in the other one is a comparison against float dust.
 */
for (const { name, control, interval, tolerance } of [
  { name: "Level", control: "4/4 level", interval: 10, tolerance: 2 },
  { name: "Balance", control: "4/4 stereo balance", interval: 25, tolerance: 5 },
]) {
  test(`dragging the ${name} stops on its marks`, async ({ page }) => {
    await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
    const slider = page.getByRole("slider", { name: control });
    const track = await slider.boundingBox();
    const y = track.y + track.height / 2;
    const from = track.x + track.width * 0.2;
    const span = Math.round(track.width * 0.5);

    await page.mouse.move(from, y);
    await page.mouse.down();
    const dragged = [];
    for (let offset = 0; offset <= span; offset += 2) {
      await page.mouse.move(from + offset, y);
      dragged.push(Math.round(Number(await slider.inputValue()) * 100));
    }
    await page.mouse.up();

    const distanceToMark = (percent) => {
      const remainder = ((percent % interval) + interval) % interval;
      return Math.min(remainder, interval - remainder);
    };
    expect(
      dragged.filter((percent) => {
        const distance = distanceToMark(percent);
        return distance > 0 && distance <= tolerance;
      }),
      `${name} settled beside a mark rather than on it: ${dragged.join(", ")}`,
    ).toEqual([]);
    // Both confirm the drag moved and that it crossed marks rather than sitting
    // in one gap the whole way, which would satisfy the assertion above
    // trivially.
    expect(dragged.at(-1)).toBeGreaterThan(dragged[0]);
    expect(new Set(dragged.filter((percent) => percent % interval === 0)).size).toBeGreaterThan(1);
  });
}

/**
 * Centre is the mark that has to be exactly reachable, because `panLabel` calls
 * anything inside four percent of the middle "Centre" — a reading a drag could
 * not make true before, leaving the word over a Balance that was audibly off to
 * one side. The tolerance is wider than that window, so what reads Centre is
 * centred.
 */
test("dragging the Balance through the middle lands on centre exactly", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const slider = page.getByRole("slider", { name: "4/4 stereo balance" });
  const readout = page.locator('[data-output="pan"]');
  const track = await slider.boundingBox();
  const y = track.y + track.height / 2;

  await page.mouse.move(track.x + track.width * 0.3, y);
  await page.mouse.down();
  const crossing = [];
  for (let offset = -6; offset <= 6; offset += 1) {
    await page.mouse.move(track.x + track.width / 2 + offset, y);
    crossing.push(await slider.inputValue());
  }
  // Released on the middle rather than wherever the sweep ended, because what
  // the sweep shows is that centre is reachable and what this shows is that it
  // is what a pointer resting there leaves behind.
  await page.mouse.move(track.x + track.width / 2, y);
  await page.mouse.up();

  expect(crossing, "a pointer crossing the middle never landed on centre").toContain("0");
  await expect(slider).toHaveValue("0");
  await expect(readout).toHaveText("Centre");
});

/**
 * Only the pointer snaps. A keyboard step of one away from a mark would be
 * pulled straight back onto it and the slider would be stuck there for good, so
 * the arrow keys reach the values between the marks and hold them. Both sliders
 * are stepped off a mark, which is the case the snap would undo.
 */
test("the mix arrow keys reach and hold the values between the marks", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const level = page.getByRole("slider", { name: "4/4 level" });
  const balance = page.getByRole("slider", { name: "4/4 stereo balance" });

  await level.fill("0.5");
  await level.focus();
  await page.keyboard.press("ArrowRight");
  await expect(level).toHaveValue("0.51");
  await expect(page.locator('[data-output="volume"]')).toHaveText("51%");

  await balance.fill("0.5");
  await balance.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(balance).toHaveValue("0.49");
  await expect(page.locator('[data-output="pan"]')).toHaveText("Right 49%");
});

/**
 * A press can end without the slider ever seeing a release: the context menu
 * takes a right button's, and a press abandoned when the window loses the
 * pointer ends the same way. One flag serves both sliders and every rhythm, so a
 * press left raised on one of them would go on snapping the others — and the
 * first arrow key after it would be pulled straight back onto the mark it
 * stepped off. Pressing a key ends the drag for that reason, and this abandons
 * the press on one slider to step the other.
 */
test("a press the mix is never released from leaves the arrow keys unsnapped", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const level = page.getByRole("slider", { name: "4/4 level" });
  const balance = page.getByRole("slider", { name: "4/4 stereo balance" });
  const track = await level.boundingBox();

  await page.mouse.move(track.x + track.width * 0.3, track.y + track.height / 2);
  await page.mouse.down({ button: "right" });

  await balance.fill("0.5");
  await balance.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(balance).toHaveValue("0.49");
});

test("a step control cycles primary, secondary, tertiary, off and back", async ({ page }) => {
  await showSubdivisionMode(page);
  const steps = page.getByRole("group", { name: "4/4 step voices" });
  const first = steps.getByRole("button", { name: /^Step 1:/ });
  const second = steps.getByRole("button", { name: /^Step 2:/ });

  await expect(first).toHaveAttribute("aria-label", "Step 1: primary voice");
  await expect(second).toHaveAttribute("aria-label", "Step 2: secondary voice");

  for (const voice of ["secondary", "tertiary", "off", "primary"]) {
    await first.click();
    await expect(first).toHaveAttribute("aria-label", `Step 1: ${voice} voice`);
    await expect(second).toHaveAttribute("aria-label", "Step 2: secondary voice");
  }
});

test("each Rhythm layer chooses Beat or Subdivision steps from its settings", async ({ page }) => {
  await page.getByRole("button", { name: "+ Rhythm", exact: true }).click();
  await setSubdivision(page, 3);

  const card = page.locator(".rhythm-card").first();
  const otherCard = page.locator(".rhythm-card").nth(1);
  const mode = card.getByRole("group", { name: "Steps" });
  const beat = mode.getByRole("button", { name: "Beat", exact: true });
  const subdivision = mode.getByRole("button", { name: "Subdivision", exact: true });
  const voices = card.getByRole("group", { name: "4/4 beat voices" });
  await expect(voices.getByRole("button")).toHaveCount(4);
  await expect(voices.getByRole("button").first()).toHaveAccessibleName("Beat 1: primary voice");
  await expect(beat).toHaveAttribute("aria-pressed", "true");
  await expect(subdivision).toHaveAttribute("aria-pressed", "false");
  await expect(
    otherCard.getByRole("group", { name: "4/4 beat voices" }).getByRole("button"),
  ).toHaveCount(4);
  expect(
    await card
      .locator(".rhythm-actions button")
      .evaluateAll((buttons) => buttons.map((button) => button.dataset.action)),
  ).toEqual(["mute", "toggle-settings", "remove-rhythm"]);

  await subdivision.click();

  await expect(
    card.getByRole("group", { name: "4/4 step voices" }).getByRole("button"),
  ).toHaveCount(12);
  await expect(subdivision).toHaveAttribute("aria-pressed", "true");
  await expect(subdivision).toBeFocused();
});

test("changing Steps mode resets edited voices in either direction", async ({ page }) => {
  await setSubdivision(page, 3);
  const card = page.locator(".rhythm-card").first();
  const mode = card.getByRole("group", { name: "Steps" });
  const beat = mode.getByRole("button", { name: "Beat", exact: true });
  const subdivision = mode.getByRole("button", { name: "Subdivision", exact: true });

  await subdivision.click();
  await card.getByRole("button", { name: "Step 1: primary voice" }).click();
  await expect(card.getByRole("button", { name: "Step 1: secondary voice" })).toBeVisible();
  await beat.click();
  await expect(card.getByRole("button", { name: "Beat 1: primary voice" })).toBeVisible();

  await card.getByRole("button", { name: "Beat 1: primary voice" }).click();
  await expect(card.getByRole("button", { name: "Beat 1: secondary voice" })).toBeVisible();
  await subdivision.click();
  await expect(card.getByRole("button", { name: "Step 1: primary voice" })).toBeVisible();
});

test("a Beat control visibly pulses at every Subdivision onset", async ({ page }) => {
  await page.getByLabel("Tempo in beats per minute").fill("300");
  await setSubdivision(page, 3);
  const firstBeat = page.getByRole("button", { name: "Beat 1: primary voice" });
  await firstBeat.evaluate((element) => {
    element.dataset.pulseCount = "0";
    element.addEventListener("animationstart", () => {
      element.dataset.pulseCount = String(Number(element.dataset.pulseCount) + 1);
    });
  });

  await page.getByRole("button", { name: "Play metronome" }).click();

  await expect
    .poll(async () => Number(await firstBeat.getAttribute("data-pulse-count")))
    .toBeGreaterThanOrEqual(3);
});

/**
 * Display Mode changes only which controls represent the running Rhythm layer;
 * they do not restart its transport run. The newly visible controls therefore
 * have to pick up the playhead even when the same absolute step is still active.
 */
test("the current control follows a display mode change during playback", async ({ page }) => {
  await page.getByLabel("Tempo in beats per minute").fill("60");
  await setSubdivision(page, 3);
  const card = page.locator(".rhythm-card").first();
  const secondBeat = card.getByRole("button", { name: /^Beat 2:/ });
  await secondBeat.evaluate((element) => {
    element.dataset.pulseCount = "0";
    element.addEventListener("animationstart", () => {
      const count = Number(element.dataset.pulseCount) + 1;
      element.dataset.pulseCount = String(count);
      if (count !== 2) return;
      document.querySelector('[data-display-mode="subdivision"]').click();
      requestAnimationFrame(() => {
        document.body.dataset.currentAfterDisplayMode =
          document.querySelector(".step.is-current")?.getAttribute("aria-label") ?? "absent";
      });
    });
  });

  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect
    .poll(() => page.locator("body").getAttribute("data-current-after-display-mode"))
    .toMatch(/^Step 5:/);
});

/**
 * The playhead redraws only at an onset, and what it last drew is what tells it
 * an onset has arrived. The display mode decides both how many controls there
 * are and which one an absolute step falls on, so a record of the last draw that
 * does not carry the mode answers for the grid the other mode had: the highlight
 * stays where the replaced controls left it, or goes missing with them, until
 * the next onset repairs it — which at a slow tempo is a long time watching a
 * metronome that has stopped following itself.
 */
test("the playhead redraws where a display mode change moved it", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  await readout.fill("30");
  await readout.blur();
  await setSubdivision(page, 2);
  await showSubdivisionMode(page);

  const card = page.locator(".rhythm-card").first();
  const controls = card.locator(".step");
  await page.getByRole("button", { name: "Play metronome" }).click();

  // A subdivision pulse lasts a second at this tempo, and the beat this one
  // belongs to does not come round again for another seven. Catching the onset
  // rather than sampling for it leaves the whole of that second to change the
  // mode and assert in, and makes a highlight that only arrives at the following
  // onset a failure rather than a slow pass.
  await page.waitForFunction(
    () => document.querySelectorAll(".rhythm-card .step")[3]?.classList.contains("is-current"),
    null,
    { polling: "raf" },
  );

  await card
    .getByRole("group", { name: "Steps" })
    .getByRole("button", { name: "Beat", exact: true })
    .click();

  await expect(controls).toHaveCount(4);
  await expect(controls.nth(1)).toHaveClass(/\bis-current\b/);
});

/**
 * A voice edit is a redraw too, and the reconciler rewrites the class of the one
 * control whose voice changed — which is the control under the playhead whenever
 * a listener edits the beat they are hearing. Neither the mode nor the active
 * step has moved, so a record of the last draw that survives the redraw answers
 * for a highlight the grid no longer carries, and the playhead goes missing until
 * the next onset puts it somewhere else. One control to a beat at thirty beats
 * per minute makes that two seconds of a metronome that has stopped following
 * itself, and it happens in either display mode.
 */
for (const [mode, control] of [
  ["Beat Mode", "Beat 1"],
  ["Subdivision Mode", "Step 1"],
]) {
  test(`editing the current control in ${mode} keeps the playhead on it`, async ({ page }) => {
    await page.getByLabel("Tempo in beats per minute").fill("30");
    if (mode === "Subdivision Mode") await showSubdivisionMode(page);
    const card = page.locator(".rhythm-card").first();

    await page.getByRole("button", { name: "Play metronome" }).click();

    // Catching the onset rather than sampling for it leaves the whole of the
    // first beat to edit and to assert in, and makes a highlight that only comes
    // back at the following onset a failure rather than a slow pass: that onset
    // moves to the second control, and the first is not current again for eight
    // seconds.
    await page.waitForFunction(
      () => document.querySelector(".rhythm-card .step")?.classList.contains("is-current"),
      null,
      { polling: "raf" },
    );

    await card.getByRole("button", { name: `${control}: primary voice` }).click();

    await expect(card.locator(".step.is-current")).toHaveAccessibleName(
      `${control}: secondary voice`,
    );
  });
}

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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  // A preset button carries its name and a notation preview, so its accessible
  // name is the whole summary; the card its delete button names is what stays
  // addressable once every Preset's identifier is generated.
  const preset = presetCard(page, "4/4").locator(".preset-button");
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  const lowSound = page.getByRole("button", { name: "low", exact: true });
  await lowSound.click();

  await expect(lowSound).toHaveAttribute("aria-pressed", "true");
  await expect(preset).toHaveAttribute("aria-pressed", "false");
  await expect(preset).not.toHaveClass(/\bis-selected\b/);

  await page.reload();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(presetCard(page, "4/4").locator(".preset-button")).toHaveAttribute(
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
 * The examples are Presets a first run writes, not a kind of Preset that lives
 * outside storage. Writing them at once is what makes the second load an
 * ordinary one, with nothing left that has to be rebuilt from a name.
 */
test("a first load seeds the example Presets into storage", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();

  await expect(presetCard(page, "4/4")).toBeVisible();
  await expect(presetCard(page, "4/4 + 3/4")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("polynome-presets-v2") ?? "null")?.map(({ name }) => name),
      ),
    )
    .toEqual(["4/4", "4/4 + 3/4"]);
});

/**
 * Deleting the last Preset leaves an empty list, which is a written key. Seeding
 * an empty list rather than an absent one would put the examples back the moment
 * they were removed, which is the whole of what this change is for.
 */
test("a deleted example Preset stays deleted across a reload", async ({ page }) => {
  await page.getByRole("button", { name: "Presets" }).click();
  await deletePreset(page, "4/4 + 3/4");
  await expect(page.getByRole("status")).toHaveText("4/4 + 3/4 preset deleted");

  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(presetCard(page, "4/4 + 3/4")).toHaveCount(0);
  await expect(presetCard(page, "4/4")).toBeVisible();

  await deletePreset(page, "4/4");
  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await expect(page.locator(".preset-card")).toHaveCount(0);
});

test("an example Preset's name is the listener's to take back", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  await page.getByRole("button", { name: "Presets" }).click();
  await deletePreset(page, "4/4");

  await tempo.fill("144");
  await savePreset(page, "4/4");
  await page.reload();
  await page.getByRole("button", { name: "Presets" }).click();
  await tempo.fill("96");

  await presetCard(page, "4/4").locator(".preset-button").click();
  await expect(page.getByLabel("BPM")).toHaveValue("144");
});

/**
 * The heading counts the Presets, and the shell ships that number for the first
 * paint. Correcting it only when the panel opens was safe while the two examples
 * could not be deleted, because the count could not be wrong before then. Now
 * any load that is not a first run can contradict it, so the count follows the
 * stored list rather than the panel.
 */
test("the preset heading counts the stored Presets before the panel is opened", async ({
  page,
}) => {
  const heading = page.getByRole("heading", { name: /^Presets/ });
  const count = page.locator("#preset-count");
  const noun = page.locator("#preset-count-noun");
  await page.getByRole("button", { name: "Presets" }).click();
  await deletePreset(page, "4/4 + 3/4");

  await page.reload();
  await expect(heading).toBeHidden();
  await expect(count).toHaveText("1");
  await expect(noun).toHaveText("preset");

  await page.getByRole("button", { name: "Presets" }).click();
  await deletePreset(page, "4/4");
  await page.reload();
  await expect(heading).toBeHidden();
  await expect(count).toHaveText("0");
  await expect(noun).toHaveText("presets");
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Shared");

  await page.evaluate(() => localStorage.setItem("polynome-presets-v2", "[]"));
  await savePreset(page, "Later");

  await expect(presetButton(page, "Later")).toBeVisible();
  await expect(presetButton(page, "Shared")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(presetButton(page, "Later")).toBeVisible();
  await expect(presetButton(page, "Shared")).toHaveCount(0);
});

test("deleting removes one preset without dropping presets this tab never saw", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Doomed");

  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("polynome-presets-v2"));
    stored.push({ id: "preset-elsewhere-1", name: "Keeper", configuration: {} });
    localStorage.setItem("polynome-presets-v2", JSON.stringify(stored));
  });
  await deletePreset(page, "Doomed");

  await expect(page.getByRole("status")).toHaveText("Doomed preset deleted");
  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await expect(presetButton(page, "Keeper")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await other.getByRole("button", { name: "Presets", exact: true }).click();

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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Retired");

  await other.goto("/");
  await other.getByRole("button", { name: "Presets", exact: true }).click();
  await deletePreset(other, "Retired");
  await expect(presetButton(other, "Retired")).toHaveCount(0);

  await savePreset(page, "Current");
  await page.reload();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Ghost");
  await page.evaluate(() => localStorage.setItem("polynome-presets-v2", "[]"));

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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Watched");
  // Saving requires an edit, and the edit available to `savePreset` is the
  // tempo, so the arithmetic below starts from a value this test states rather
  // than from whatever it was left at.
  await page.getByRole("spinbutton", { name: "BPM" }).fill("96");
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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

  await page.getByRole("button", { name: "Presets", exact: true }).click();
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
    const panel = page.getByRole("region", { name: /^Save preset/ });
    const openSave = page.getByRole("button", { name: "+ Save" });
    const name = panel.getByRole("textbox", { name: "Preset name" });
    const save = panel.getByRole("button", { name: /^(?:Save|Replace)$/ });
    await page.goto("/");
    await page.getByRole("button", { name: "Presets", exact: true }).click();

    await page.getByLabel("Tempo in beats per minute").fill("101");
    await openSave.click();
    await name.fill("First");
    await save.click();
    await expect(status).toHaveText("Preset could not be saved in this browser");
    await expect(presetButton(page, "First")).toBeVisible();

    await page.getByLabel("Tempo in beats per minute").fill("102");
    await openSave.click();
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
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Watched");
  const example = presetCard(page, "4/4").locator(".preset-button");
  await example.click();
  await expect(example).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    window.presetListRebuilds = 0;
    new MutationObserver((records) => {
      window.presetListRebuilds += records.length;
    }).observe(document.querySelector("#preset-list"), { childList: true, subtree: true });
  });

  const slider = page.getByRole("slider", { name: "Tempo in beats per minute" });
  await slider.focus();
  for (let press = 0; press < 10; press += 1) await page.keyboard.press("ArrowRight");

  await expect(example).toHaveAttribute("aria-pressed", "false");
  await expect(example).not.toHaveClass(/\bis-selected\b/);
  await expect(presetButton(page, "Watched")).toBeVisible();
  expect(await page.evaluate(() => window.presetListRebuilds)).toBe(0);
});

/**
 * The rebuild that adopts another tab's deletion destroys whatever the user had
 * focused. Restoring by identifier finds nothing when the identifier is what was
 * deleted, and focus falls to the document, which is where a keyboard user least
 * expects to be. The panel's close control is where deleting in this tab already
 * leaves it, and unlike a Preset card it is always there to receive focus.
 */
test("focus survives another tab deleting the preset it was on", async ({ page, context }) => {
  const other = await context.newPage();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await savePreset(page, "Doomed");
  await page.getByRole("button", { name: "Delete Doomed preset" }).focus();

  await other.goto("/");
  await other.getByRole("button", { name: "Presets", exact: true }).click();
  await deletePreset(other, "Doomed");

  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close presets" })).toBeFocused();
});

/**
 * A selected card paints the accent colour under its delete button, which keeps
 * the muted grey it was given for the unselected surface. The declared colours
 * are each fine against the surface they were written for, so only the rendered
 * pair shows it: the glyph all but disappears on the card the user just picked.
 */
test("the delete glyph stays readable on a selected preset", async ({ page }) => {
  await page.getByRole("button", { name: "Presets", exact: true }).click();
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

/**
 * The preset count and a cycle's repetition count are the same number in the
 * same heading, and both cross ten while the heading around them holds still.
 * Tabular figures are what stop the width shifting under them, so a panel that
 * borrowed the cycle card's heading has to have borrowed those with it.
 *
 * Each is located as the number a reader sees rather than by the rule that
 * styles it: a heading whose digits jitter fails this however the selector that
 * was meant to reach them is written.
 */
test("both heading counts are set in tabular figures", async ({ page }) => {
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  const presetCount = page.locator("#preset-count");
  const repetitions = page.locator(".cycle-heading h2 span").last();

  await expect(presetCount).toHaveText("2");
  await expect(presetCount).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(repetitions).toHaveText("1");
  await expect(repetitions).toHaveCSS("font-variant-numeric", "tabular-nums");
});

test("beats wrap into equal rows at every width", async ({ page }) => {
  await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
  await page.locator('[data-action="toggle-subdivision-menu"]').first().click();
  await page.locator('.subdivision-option[data-subdivision="4"]').click();
  await showSubdivisionMode(page);
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

/**
 * Both Meter controls live in the settings pane, and the control that reveals it
 * toggles — so opening one already open closes it. Every caller below wants the
 * pane open rather than switched, which is a difference only a caller that
 * happens to be second would ever notice.
 */
async function openRhythmSettings(page) {
  const subdivision = page.locator('[data-action="toggle-subdivision-menu"]').first();
  if (await subdivision.isVisible()) return;
  await page
    .getByRole("button", { name: /^Edit \d+\/\d+$/ })
    .first()
    .click();
  await expect(subdivision).toBeVisible();
}

async function setSignature(page, count) {
  await openRhythmSettings(page);
  await page.getByRole("combobox", { name: /meter numerator$/ }).selectOption(String(count));
}

async function setSubdivision(page, subdivision) {
  await openRhythmSettings(page);
  await page.locator('[data-action="toggle-subdivision-menu"]').first().click();
  await page
    .locator(
      `.subdivision-menu:not([hidden]) .subdivision-option[data-subdivision="${subdivision}"]`,
    )
    .click();
}

async function showSubdivisionMode(page) {
  await openRhythmSettings(page);
  const subdivision = page.locator('[data-display-mode="subdivision"]').first();
  if ((await subdivision.getAttribute("aria-pressed")) === "false") await subdivision.click();
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
    await showSubdivisionMode(page);
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
  await showSubdivisionMode(page);
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

/**
 * The steps stand over evenly spaced onsets, so they have to be evenly spaced
 * themselves. Setting beats further apart than the steps inside them drew a
 * grouping the rhythm does not have — at a Subdivision of two it is exactly the
 * engraved form of a swung pair, which is a claim about the timing that the
 * scheduler does not make. Every Subdivision is walked because the gap that did
 * this scaled with the Subdivision, so one of them alone would not have caught
 * it.
 */
for (const subdivision of [1, 2, 3, 4, 5]) {
  test(`a beat of ${subdivision} spaces its steps evenly with its neighbours`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    if (subdivision !== 1) await setSubdivision(page, subdivision);
    await showSubdivisionMode(page);
    await expect(page.locator(".rhythm-card .step")).toHaveCount(4 * subdivision);
    await settleLayout(page);

    const deltas = await page.evaluate(() => {
      const centres = [...document.querySelectorAll(".rhythm-card .step")].map((step) => {
        const { left, right, top } = step.getBoundingClientRect();
        return { centre: (left + right) / 2, row: Math.round(top) };
      });
      return (
        centres
          .slice(1)
          .map((step, index) => ({ step, previous: centres[index] }))
          // A row break is not a gap between two steps, so it is not one of the
          // distances this compares.
          .filter(({ step, previous }) => step.row === previous.row)
          .map(({ step, previous }) => Math.round(step.centre - previous.centre))
      );
    });

    expect(deltas.length).toBeGreaterThan(0);
    expect(new Set(deltas), `subdivision ${subdivision} spaced steps ${deltas.join(", ")}`).toEqual(
      new Set([deltas[0]]),
    );
  });
}

/**
 * Even spacing means the grid no longer says where a beat starts, and the first
 * step of a bar cannot say it either: its voice is the listener's to change, and
 * a downbeat switched off is the dimmest circle in the row. So a dot marks it,
 * under the step the beat begins on.
 *
 * The dots hang below their row, and it is the pulsed dot the row gap has to
 * clear rather than the resting one — a dot that grew into the steps beneath it
 * would only do so while playing, which is exactly when nobody is looking for
 * it. Sixteen steps of four is where that shows, because it is the widest grid
 * that still wraps.
 */
test("a dot marks each beat, clear of the row below even when it pulses", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await setSubdivision(page, 4);
  await settleLayout(page);

  // One round trip per beat, with the dot's own 90ms transition allowed to
  // settle between writing the class and reading the style. Settling inside a
  // single `evaluate` with animation frames is not enough: it can land before
  // the style engine has processed the change, which reads back as a dot that
  // never pulsed and fails only under load.
  const measureLit = async (beat) => {
    await page.evaluate((index) => {
      const steps = [...document.querySelectorAll(".rhythm-card .step")];
      steps.forEach((step, position) => {
        step.classList.toggle("is-current", position === index * 4);
      });
    }, beat);
    await page.waitForTimeout(150);
    return page.evaluate((index) => {
      const element = document.querySelectorAll(".rhythm-card .beat")[index];
      const dot = getComputedStyle(element, "::after");
      const size = parseFloat(dot.height);
      const scale = Number(dot.transform.match(/matrix\(([\d.]+)/)?.[1] ?? 1);
      const top = element.getBoundingClientRect().bottom + parseFloat(dot.marginTop);
      return {
        content: dot.content,
        left: parseFloat(dot.left),
        scale,
        beatBottom: element.getBoundingClientRect().bottom,
        // A pseudo-element has no box to measure, so its reach comes from the
        // beat it hangs off and its own resolved lengths, grown about its centre.
        reach: top + size / 2 + (size * scale) / 2,
      };
    }, beat);
  };

  const dots = [];
  for (const beat of [0, 1, 2, 3]) dots.push(await measureLit(beat));

  const frame = await page.evaluate(() => {
    const card = document.querySelector(".rhythm-card");
    for (const step of card.querySelectorAll(".step")) step.classList.remove("is-current");
    const steps = [...card.querySelectorAll(".step")];
    return {
      stepSize: steps[0].getBoundingClientRect().width,
      stepTops: steps.map((step) => step.getBoundingClientRect().top),
      rowBottom: card.querySelector(".steps").getBoundingClientRect().bottom,
    };
  });

  expect(dots).toHaveLength(4);
  for (const [index, dot] of dots.entries()) {
    expect(dot.content, `beat ${index + 1} draws no dot`).not.toBe("none");
    // Without this the rest of the loop silently measures the resting dot, and
    // the gap it clears is not the gap that has to be cleared.
    expect(dot.scale, `beat ${index + 1} was measured at rest, not pulsing`).toBeGreaterThan(1);
    // Half a step in from the beat's left edge is the centre of its first step,
    // which is the onset the dot stands for.
    expect(dot.left, `beat ${index + 1} is not over its own step`).toBeCloseTo(
      frame.stepSize / 2,
      0,
    );

    // A step starting below this beat's own bottom edge is a step on a later
    // row, and the pulsed dot hangs in the space between the two.
    for (const top of frame.stepTops.filter((top) => top > dot.beatBottom)) {
      expect(top, `beat ${index + 1} pulses into the row beneath it`).toBeGreaterThanOrEqual(
        dot.reach,
      );
    }
    expect(dot.reach, `beat ${index + 1} pulses out of the step row`).toBeLessThanOrEqual(
      frame.rowBottom,
    );
  }
});

/**
 * The rhythm re-renders on every edit — a step click, a Meter change, a Preset
 * applied — and the dot has to go on pulsing after one. This walks the playhead
 * the way `updateActiveSteps` does, but only after reconciliation has replaced
 * the beat's children, because that is the state a mark keyed off its own
 * subtree can quietly stop tracking.
 *
 * Walked under both motion settings. Reduced motion is a reader's setting and
 * not a harness convenience, and it changes when the style behind this mark is
 * recalculated — so a dot that pulses for one reader and not the other is a
 * defect neither run alone would find.
 *
 * The 150ms is the dot's own 90ms transition settling, not a guess at how long
 * a runner takes.
 */
for (const motion of ["no-preference", "reduce"]) {
  test(`the dot still pulses after a re-render with motion ${motion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    // The re-render. Every beat below is a node reconciliation has just written.
    await setSubdivision(page, 4);
    await settleLayout(page);

    const dotsAt = async (step) => {
      await page.evaluate((current) => {
        const steps = [...document.querySelectorAll(".rhythm-card .step")];
        steps.forEach((element, index) => {
          element.classList.toggle("is-current", index === current);
        });
      }, step);
      await page.waitForTimeout(150);
      return page.evaluate(() =>
        [...document.querySelectorAll(".rhythm-card .beat")].map(
          (beat) => getComputedStyle(beat, "::after").transform,
        ),
      );
    };

    const resting = await dotsAt(-1);
    expect(new Set(resting).size, "a dot was already pulsing at rest").toBe(1);

    for (const beat of [0, 1, 2, 3]) {
      const lit = await dotsAt(beat * 4);
      expect(lit[beat], `beat ${beat + 1} did not pulse after a re-render`).not.toBe(resting[beat]);
      for (const other of [0, 1, 2, 3].filter((index) => index !== beat)) {
        expect(lit[other], `beat ${other + 1} pulsed on beat ${beat + 1}'s onset`).toBe(
          resting[other],
        );
      }
    }
  });
}

/**
 * The dot takes the accent and grows on the beat the playhead is on, and it
 * pulses on that beat's own onset rather than through its whole length — the
 * selector reads the beat's first step, not any step of it. Reading any step
 * would leave the mark lit through four sixteenths and pulsing at a quarter of
 * the rate it stands for.
 *
 * Driven by writing the class the playhead writes, rather than by running the
 * transport, so what is asserted is a state and not a moment. Reduced motion is
 * emulated and two frames are let past before each reading, for the same
 * reason: the transition is 90ms, and a computed style taken before the first
 * recalc after a class change is the value the transition starts from, which is
 * indistinguishable from the state never having changed. That mistake is what
 * made this look at first like a Chromium bug rather than a measurement error.
 * A timeout would be a number too short on a loaded runner and wasted
 * everywhere else.
 */
test("the beat dot pulses on its own onset, not through the whole beat", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setSubdivision(page, 4);
  await settleLayout(page);

  const dotsWhilePlaying = (step) =>
    page.evaluate(async (index) => {
      const steps = [...document.querySelectorAll(".rhythm-card .step")];
      for (const element of steps) element.classList.remove("is-current");
      if (index !== null) steps[index].classList.add("is-current");
      await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
      return [...document.querySelectorAll(".rhythm-card .beat")].map((beat) => {
        const dot = getComputedStyle(beat, "::after");
        return `${dot.backgroundColor} ${dot.transform}`;
      });
    }, step);

  const resting = await dotsWhilePlaying(null);
  // Step 0 is beat one's own onset; step 2 is inside beat one but past it; step
  // 4 is beat two's onset and must leave beat one alone.
  const atOnset = await dotsWhilePlaying(0);
  const within = await dotsWhilePlaying(2);
  const nextBeat = await dotsWhilePlaying(4);

  expect(new Set(resting).size, "a dot was already pulsing at rest").toBe(1);
  expect(atOnset[0], "beat one did not pulse on its own onset").not.toBe(resting[0]);
  expect(atOnset.slice(1), "a beat pulsed that was not being played").toEqual(resting.slice(1));
  expect(within, "the dot stayed lit past its own onset").toEqual(resting);
  expect(nextBeat[1], "beat two did not pulse on its own onset").not.toBe(resting[1]);
  expect(nextBeat[0], "beat one pulsed on beat two's onset").toBe(resting[0]);

  // Grows rather than merely recolours.
  const scaleOf = (dot) => Number(dot.match(/matrix\(([\d.]+)/)[1]);
  expect(scaleOf(atOnset[0])).toBeGreaterThan(scaleOf(resting[0]));
});

/**
 * The label hangs above the number's box, but what a reader sees is the distance
 * to the ink — and half the leading, the block padding and the display font's
 * own ascent above its capitals all sit between the two, every one of them a
 * share of the glyph size. So a margin that does not pull back at least as fast
 * as the type grows leaves the label drifting away from the number it names,
 * which is what the tempo curve doubling the glyph size makes visible.
 *
 * Measured against the ink rather than the box, because the box is the thing
 * that hides the drift.
 */
test("the BPM label closes on the number as the tempo enlarges it", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });

  const gapAt = async (bpm) => {
    await page.getByLabel("Tempo in beats per minute").fill(String(bpm));
    await settleLayout(page);
    return page.evaluate(async () => {
      // measureText answers against whatever face is loaded when it runs, and
      // the display font is a web font served with `font-display: swap`. A
      // reading taken before it arrives is of the fallback, whose ascent is
      // about 3px shorter at this size — enough to measure the two tempos
      // against two different faces, and to move a gap this small either way.
      await document.fonts.ready;
      const input = document.querySelector("#bpm-input");
      const style = getComputedStyle(input);
      const fontPx = parseFloat(style.fontSize);
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${fontPx}px ${style.fontFamily}`;
      const metrics = context.measureText(input.value);
      const leading =
        (parseFloat(style.lineHeight) -
          (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) /
        2;
      const baseline =
        input.getBoundingClientRect().top +
        parseFloat(style.paddingTop) +
        leading +
        metrics.fontBoundingBoxAscent;
      const inkTop = baseline - metrics.actualBoundingBoxAscent;
      return inkTop - document.querySelector("#bpm-readout label").getBoundingClientRect().bottom;
    });
  };

  const small = await gapAt(30);
  const large = await gapAt(300);

  // Closes rather than opens, and never so far that the two touch.
  expect(large).toBeLessThanOrEqual(small);
  expect(large).toBeGreaterThan(0);
  // A slight reduction, not a collapse: the label must still read as a label
  // sitting above the number rather than as part of it.
  expect(large).toBeGreaterThan(small * 0.6);
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
 * The readout is a box centred in the track, so its width has to be the width
 * of the digits inside it: a box wider than what it holds centres itself and
 * leaves the number off-centre by half the difference.
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
 * The number grows with the tempo but no longer travels with it. It docks in
 * the middle of the track and hangs from the bottom edge, so the growth goes
 * upward into the height the track reserves: the readout stays centred, the
 * slider under it does not move, and neither end of the card is anywhere the
 * number can reach.
 */
test("the tempo readout grows in place rather than travelling", async ({ page }) => {
  for (const width of [320, 500, 968]) {
    await page.setViewportSize({ width, height: 900 });
    let sliderTop = null;

    for (const bpm of [30, 96, 300]) {
      await page.getByLabel("Tempo in beats per minute").fill(String(bpm));
      await settleLayout(page);

      const measured = await page.evaluate(() => {
        const box = (selector) => {
          const { left, right, top, bottom } = document
            .querySelector(selector)
            .getBoundingClientRect();
          return { left, right, top, bottom, centre: (left + right) / 2 };
        };
        return {
          readout: box("#bpm-readout"),
          track: box(".bpm-track"),
          slider: box(".tempo-slider"),
          card: box(".transport"),
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        };
      });

      const where = `${width}px at ${bpm}bpm`;
      expect(measured.readout.centre, `${where} is off the track's centre`).toBeCloseTo(
        measured.track.centre,
        1,
      );
      expect(measured.readout.bottom, `${where} has left the track's floor`).toBeCloseTo(
        measured.track.bottom,
        1,
      );
      expect(
        measured.readout.left,
        `${where} overhangs the track on the left`,
      ).toBeGreaterThanOrEqual(measured.track.left);
      expect(
        measured.readout.right,
        `${where} overhangs the track on the right`,
      ).toBeLessThanOrEqual(measured.track.right);
      expect(
        measured.readout.left,
        `${where} overhangs the card on the left`,
      ).toBeGreaterThanOrEqual(measured.card.left);
      expect(
        measured.readout.right,
        `${where} overhangs the card on the right`,
      ).toBeLessThanOrEqual(measured.card.right);
      expect(measured.scroll, `${where} widened the page`).toBeLessThanOrEqual(measured.client);

      // The reserved height is what makes this true: the number is bottom
      // anchored inside it, so a larger glyph takes room above itself only.
      if (sliderTop === null) sliderTop = measured.slider.top;
      else expect(measured.slider.top, `${where} moved the slider`).toBeCloseTo(sliderTop, 1);
    }
  }
});

/**
 * The keys are the exact control the slider is not, and both halves of that
 * matter: a tap has to be one bpm rather than a step the acceleration has
 * already run away with, and the end of the range has to be a key that says it
 * cannot act rather than one that silently does nothing.
 */
test("a tap on a tempo key is one bpm and the ends of the range disable one", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const up = page.getByRole("button", { name: "Increase tempo" });
  const down = page.getByRole("button", { name: "Decrease tempo" });

  await readout.fill("112");
  await readout.blur();

  await up.click();
  await expect(readout).toHaveValue("113");
  await down.click();
  await down.click();
  await expect(readout).toHaveValue("111");

  // Space reaches the same hold the pointer does, and the browser's own click
  // on release would be a second step if anything listened for it.
  await up.focus();
  await page.keyboard.press("Space");
  await expect(readout).toHaveValue("112");

  await readout.fill("30");
  await readout.blur();
  await expect(down).toBeDisabled();
  await expect(up).toBeEnabled();

  await readout.fill("300");
  await readout.blur();
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
});

test("non-primary mouse presses do not change or repeat the tempo", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const up = page.getByRole("button", { name: "Increase tempo" });
  await readout.fill("112");
  await readout.blur();

  const key = await up.boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  for (const button of ["right", "middle"]) {
    await page.mouse.down({ button });
    await page.waitForTimeout(700);
    await page.mouse.up({ button });
    await expect(readout).toHaveValue("112");
  }
});

/**
 * The key that reaches the end of the range keeps its place in the tab order.
 * A held key disables itself under the user, and `disabled` would take it out
 * of that order at exactly that moment: focus falls to the document, and the
 * next Tab restarts from the top of the panel rather than continuing from the
 * key they were on. Marked unavailable instead, the control stays where it was
 * and still says it will not act — which is the rule the save chip already
 * follows, for its own reasons.
 *
 * `aria-disabled` states and does not enforce, so the press it is still given
 * has to be declined by what handles it.
 */
test("a tempo key held to the end of its range keeps its place", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const down = page.getByRole("button", { name: "Decrease tempo" });

  await readout.fill("31");
  await readout.blur();
  await down.focus();

  await page.keyboard.press("Space");
  await expect(readout).toHaveValue("30");
  await expect(down).toHaveAttribute("aria-disabled", "true");
  await expect(down).toBeFocused();

  // Still reachable, so the press still arrives, and still declined.
  await page.keyboard.press("Space");
  await expect(readout).toHaveValue("30");
  await expect(down).toBeFocused();

  // And it comes back when there is somewhere to go.
  await readout.fill("40");
  await readout.blur();
  await expect(down).toHaveAttribute("aria-disabled", "false");
});

/**
 * A number field commits on the `change` event, which arrives only once focus
 * has left it — and `pointerdown` on a key runs before the focus shift that
 * produces it. Every other test here leaves the field first, so this is the one
 * that reaches the tempo a user typed and has not yet stepped away from.
 */
test("a tempo typed into the readout is stepped from, not discarded", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const up = page.getByRole("button", { name: "Increase tempo" });
  const down = page.getByRole("button", { name: "Decrease tempo" });

  await readout.fill("200");
  await up.click();
  await expect(readout).toHaveValue("201");

  await readout.fill("90");
  await down.click();
  await expect(readout).toHaveValue("89");

  // The keyboard arrives at the same hold with the key already focused, so the
  // field has committed on its own by then and there is nothing left pending.
  await readout.fill("150");
  await up.focus();
  await page.keyboard.press("Space");
  await expect(readout).toHaveValue("151");
});

/**
 * A hold is what covers a long move, so it has to accelerate. Thirty steps
 * inside the five seconds allowed below is only reachable if the interval
 * decays: a repeat held at `HOLD_DELAY_MS` throughout would take twelve seconds
 * to walk 60 down to 30, and would still be seven seconds short when this gave
 * up on it.
 *
 * It also has to stop at the end of the range and stay stopped once the finger
 * lifts, which is what the wait after the release is for — a timer that outlived
 * the press would show as a number that kept moving after it.
 *
 * What this cannot see is the hold ending itself on the step the range declined.
 * The key that got there is marked `aria-disabled` rather than disabled, so the
 * release still reaches it and ends the hold anyway; ending early is in the code
 * for the work it saves over the rest of the press, and saved work leaves
 * nothing here to assert.
 */
test("holding a tempo key accelerates and stops at the end of the range", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const down = page.getByRole("button", { name: "Decrease tempo" });

  await readout.fill("60");
  await readout.blur();

  const key = await down.boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down();
  // Long enough to pass 30 from 60 several times over if the repeat ran on.
  await expect(down).toBeDisabled({ timeout: 5000 });
  await page.mouse.up();

  await expect(readout).toHaveValue("30");
  await page.waitForTimeout(400);
  await expect(readout).toHaveValue("30");
});

/**
 * Only the primary button holds. The slider's own comment names the lost release
 * from the other side: the context menu takes a right button's release, so a
 * repeat that a right press started is never told to stop and runs unattended to
 * the end of the range — a right-click on − arriving at 30 bpm. The slider comes
 * to no harm from the same loss, because the flag it leaves raised only decides
 * what an `input` event does, and both things that produce one settle it first.
 * What this leaves behind is a timer moving the tempo with nobody holding it, so
 * the press has to be refused before the first step lands.
 *
 * A right press is the case that can be driven here, and it is the one with a
 * native gesture behind it, but the guard is on the button being primary rather
 * than on which non-primary button it was: a middle press has no more claim to
 * a tempo than a right one does.
 */
test("a non-primary button press does not start a tempo hold", async ({ page }) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const down = page.getByRole("button", { name: "Decrease tempo" });

  await readout.fill("112");
  await readout.blur();

  const key = await down.boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down({ button: "right" });
  // Past HOLD_DELAY_MS and the two repeats that land inside it, so this fails on
  // the step a press takes immediately and fails again on everything the
  // acceleration would have added to it.
  await page.waitForTimeout(900);
  await expect(readout).toHaveValue("112");

  await page.mouse.up({ button: "right" });
  await expect(readout).toHaveValue("112");
});

/**
 * Every step of a hold defers its transport consequence, and the acceleration is
 * what makes that necessary: `restart-transport-run` per repeat would begin a
 * new run every 45ms at the floor, and a run that never outlives its own
 * look-ahead is one nobody hears. The engine is module scope and says nothing
 * about itself, so what is read here is what a restart does to the one thing on
 * screen that asks the transport where it is. A restart re-anchors the run
 * `START_DELAY_SECONDS` ahead of the audio clock, and every position before that
 * origin is the top of the pattern, so a run restarted faster than a step lasts
 * is a playhead that never leaves the first step or two. A run left alone walks
 * the pattern. Measured against this build, that is the difference between
 * sampling 0 and 1 and nothing else, and sampling all four steps of 4/4 in turn.
 *
 * The playhead does not go out under the failing version, because `start` calls
 * the scheduler tick that re-anchors inside its own synchronous run. So the
 * assertion below that it never goes out is guarding playback stopping, not the
 * restart; the walk is what carries the restart.
 *
 * Sampled from `classList` rather than from computed style, so unlike the tests
 * that measure the beat dot there is nothing here a transition could be caught
 * part way through, and no reason to emulate reduced motion.
 */
test("holding a tempo key while playing leaves the run alone until the release", async ({
  page,
}) => {
  const readout = page.getByRole("spinbutton", { name: "BPM" });
  const down = page.getByRole("button", { name: "Decrease tempo" });
  const status = page.locator("#status");
  const current = page.locator(".rhythm-card .step.is-current");

  // A quarter-second step, so the hold below walks 4/4's four positions twice
  // over, and far enough inside the range that the repeat never reaches a bound
  // and ends itself early.
  await readout.fill("240");
  await readout.blur();
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(status).toHaveText("Playing");
  await expect(current).toHaveCount(1);

  // A frame sampler rather than a poll from here: the playhead is written once
  // per animation frame, so a reading per frame is every value it ever had, and
  // a gap between two polls is a restart this could miss.
  const sampleFrames = () =>
    page.evaluate(() => {
      window.playhead = [];
      const sample = () => {
        const steps = [...document.querySelectorAll(".rhythm-card .step")];
        window.playhead.push(steps.findIndex((step) => step.classList.contains("is-current")));
        window.playheadFrame = requestAnimationFrame(sample);
      };
      sample();
    });
  const sampled = () =>
    page.evaluate(() => {
      cancelAnimationFrame(window.playheadFrame);
      return window.playhead;
    });

  await sampleFrames();
  const key = await down.boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down();
  // The acceleration reaches its floor around 1.4s, so this covers the decaying
  // intervals and then some twenty repeats at 45ms — the interval the deferral
  // exists for, rather than only the leisurely ones before it.
  await page.waitForTimeout(2200);
  const held = await sampled();
  await page.mouse.up();

  expect(held, "playback stopped during the hold").not.toContain(-1);
  expect(
    new Set(held).size,
    "the playhead did not walk the pattern, so the run was being cut off",
  ).toBeGreaterThan(2);

  // The release is where the run is finally handed the tempo, and it has to
  // survive being handed it: still playing, still walking, and carrying the
  // value the hold arrived at rather than the one it started from.
  await expect(status).toHaveText("Playing");
  await expect(page.getByRole("button", { name: "Stop metronome" })).toBeVisible();
  expect(Number(await readout.inputValue())).toBeLessThan(240);

  await sampleFrames();
  // Longer than four steps at the tempo the hold arrived at, so a walk is what
  // this sees rather than a step that happened to be long.
  await page.waitForTimeout(1200);
  const released = await sampled();
  expect(
    new Set(released.filter((index) => index >= 0)).size,
    "the playhead stopped walking after the release",
  ).toBeGreaterThan(2);
});

/**
 * One control height in the panel: the keys are the play bar's height at every
 * width, and they are a tap target at the narrowest one.
 */
test("the tempo keys are the play bar's height and stay a tap target", async ({ page }) => {
  for (const width of [320, 500, 968]) {
    await page.setViewportSize({ width, height: 900 });
    await settleLayout(page);

    const measured = await page.evaluate(() => {
      const size = (selector) => {
        const { width, height } = document.querySelector(selector).getBoundingClientRect();
        return { width, height };
      };
      return { down: size("#bpm-down"), up: size("#bpm-up"), play: size(".play-button") };
    });

    for (const [name, key] of [
      ["−", measured.down],
      ["+", measured.up],
    ]) {
      expect(key.height, `${name} is not the play bar's height at ${width}px`).toBeCloseTo(
        measured.play.height,
        1,
      );
      expect(key.width, `${name} is not square at ${width}px`).toBeCloseTo(key.height, 1);
      expect(key.height, `${name} is under 48px at ${width}px`).toBeGreaterThanOrEqual(48);
    }
  }
});

/**
 * Saving is offered only when there is something to save. Applying a Preset and
 * saving one both leave the Configuration equal to a stored Preset, and offering
 * to write a copy of what is already there invites a duplicate under a second
 * name. The rule is the same in both directions, so both are walked here.
 */
test("saving is offered only while the setup differs from the preset it came from", async ({
  page,
}) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const bpm = page.getByRole("spinbutton", { name: "BPM" });

  // The default Configuration is the 4/4 preset exactly, adopted at startup.
  await saveNotOffered(page);

  await tempo.fill("120");
  await saveOffered(page);

  // Back to what the preset holds: the edit undid itself, so there is again
  // nothing to save. Nothing records that an edit happened, only what it left.
  await tempo.fill("96");
  await saveNotOffered(page);

  await tempo.fill("132");
  await savePreset(page, "Brisk");
  await saveNotOffered(page);

  await tempo.fill("133");
  await saveOffered(page);

  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await presetButton(page, "Brisk").click();
  await expect(bpm).toHaveValue("132");
  await saveNotOffered(page);
});

/**
 * A Preset the Configuration came from can stop existing while the Configuration
 * it produced is still on screen — deleted here, or deleted in another tab — and
 * what is left is a setup stored nowhere. That is the state most worth saving,
 * and a record of an origin that no longer exists is what silently reads as
 * nothing to save: the chip stays inert, and the only way back to a save is an
 * edit the user did not want to make. Both routes to the deletion are walked,
 * because they are separate code paths and only one of them is a click.
 */
test("deleting the preset the setup came from offers the save again", async ({ page, context }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const presets = page.getByRole("button", { name: "Presets", exact: true });

  await tempo.fill("137");
  await savePreset(page, "Doomed");
  await saveNotOffered(page);

  await presets.click();
  await deletePreset(page, "Doomed");
  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await saveOffered(page);

  // The same Configuration, now saved again, and removed by a tab that is not
  // this one. Nothing here is clicked, so only the storage event can notice.
  await savePreset(page, "Doomed");
  await saveNotOffered(page);

  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Presets", exact: true }).click();
  await deletePreset(other, "Doomed");

  await expect(presetButton(page, "Doomed")).toHaveCount(0);
  await saveOffered(page);
});

/**
 * Deleting some other Preset is not a reason to forget which one this setup came
 * from. The origin survives it, and the field still opens on the name a save
 * would replace — the count is what proves nothing was duplicated.
 */
test("deleting another preset leaves the name the save field opens on", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const heading = page.getByRole("heading", { name: /^Presets/ });

  await tempo.fill("138");
  await savePreset(page, "Spare");
  await tempo.fill("139");
  await savePreset(page, "Kept");
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(heading).toContainText("4");

  await deletePreset(page, "Spare");
  await expect(heading).toContainText("3");
  await saveNotOffered(page);

  await tempo.fill("140");
  await page.getByRole("button", { name: "+ Save" }).click();
  const panel = page.getByRole("region", { name: /^Save preset/ });
  await expect(panel.getByRole("textbox", { name: "Preset name" })).toHaveValue("Kept");
  await panel.getByRole("button", { name: "Replace" }).click();
  await expect(heading).toContainText("3");
});

/**
 * The field opens holding the Preset this Configuration came from, so carrying
 * an edit back onto it is the default and renaming is the deliberate act. That
 * replaces rather than duplicates — the count is what proves it — and the
 * submit says which of the two it is about to do before it is pressed.
 */
test("the save field opens on the preset the setup came from", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const bpm = page.getByRole("spinbutton", { name: "BPM" });
  const panel = page.getByRole("region", { name: /^Save preset/ });
  const name = panel.getByRole("textbox", { name: "Preset name" });
  const heading = page.getByRole("heading", { name: /^Presets/ });

  await tempo.fill("144");
  await savePreset(page, "Fast");
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(heading).toContainText("3");

  await tempo.fill("145");
  await page.getByRole("button", { name: "+ Save" }).click();
  await expect(name).toHaveValue("Fast");
  await expect(name).toBeFocused();
  await expect(panel.getByRole("button", { name: "Replace" })).toBeVisible();

  await panel.getByRole("button", { name: "Replace" }).click();
  await expect(page.getByRole("status")).toHaveText("Fast preset saved");
  await expect(panel).toBeHidden();
  await expect(heading).toContainText("3");
  await presetButton(page, "Fast").click();
  await expect(bpm).toHaveValue("145");
});

/**
 * The panel replaced a native dialog, which answered Escape without being asked.
 * Closing must not save: the field is left holding an edited name and the stored
 * Preset has to be untouched by it.
 */
test("closing the save panel abandons what was typed", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const bpm = page.getByRole("spinbutton", { name: "BPM" });
  const panel = page.getByRole("region", { name: /^Save preset/ });
  const openSave = page.getByRole("button", { name: "+ Save" });

  await tempo.fill("150");
  await savePreset(page, "Kept");
  await tempo.fill("151");

  await openSave.click();
  await panel.getByRole("textbox", { name: "Preset name" }).fill("Discarded");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await openSave.click();
  await panel.getByRole("button", { name: "Close save preset" }).click();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(presetButton(page, "Discarded")).toHaveCount(0);
  await expect(presetButton(page, "Kept")).toBeVisible();
  await presetButton(page, "Kept").click();
  await expect(bpm).toHaveValue("150");
});

/**
 * An example Preset is stored like any other, so its name is offered back and
 * saving under it replaces it — where a reserved name once forced the field
 * open empty. Starting a Preset of your own from an example is still one act,
 * renaming before saving, but it is now the deliberate one rather than the only
 * one available.
 */
test("editing an example preset opens the save field on its name", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const panel = page.getByRole("region", { name: /^Save preset/ });
  const name = panel.getByRole("textbox", { name: "Preset name" });

  await tempo.fill("128");
  await page.getByRole("button", { name: "+ Save" }).click();
  await expect(name).toHaveValue("4/4");
  await expect(panel.getByRole("button", { name: "Replace" })).toBeVisible();

  await name.fill("Mine");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Mine preset saved");

  // Saved under its own name, the Preset now offers itself back for replacing.
  await tempo.fill("129");
  await page.getByRole("button", { name: "+ Save" }).click();
  await expect(name).toHaveValue("Mine");
});

/**
 * Available is read as "this control exists", not as "this control has something
 * to do", and the two look identical in a row of chips. An edit that leaves the
 * header exactly as it was is an edit nothing on screen acknowledges, so the
 * chip carries a live treatment for as long as there is something to save —
 * from the first edit until the save or the preset that makes it moot.
 */
test("the save chip reads as live for as long as there is something to save", async ({ page }) => {
  const openSave = page.getByRole("button", { name: "+ Save" });
  const tempo = page.getByLabel("Tempo in beats per minute");

  // The default Configuration is the 4/4 preset exactly: nothing to save, and
  // nothing to advertise.
  await saveNotOffered(page);
  await expect(openSave).not.toHaveClass(/\bis-live\b/);

  await tempo.fill("120");
  await saveOffered(page);
  await expect(openSave).toHaveClass(/\bis-live\b/);

  await savePreset(page, "Kept");
  await saveNotOffered(page);
  await expect(openSave).not.toHaveClass(/\bis-live\b/);
});

/**
 * The chip is marked unavailable rather than disabled, so that the reason it
 * will not act reaches the people a disabled control tells least: it keeps its
 * place in the tab order, and the reason is a description rather than a tooltip
 * a pointer is needed to find. Nothing about `aria-disabled` stops a click, so
 * the click has to decline for itself — the panel staying shut is what proves
 * it does.
 */
test("the inert save chip is reachable, says why, and does not act", async ({ page }) => {
  const openSave = page.getByRole("button", { name: "+ Save" });
  const panel = page.getByRole("region", { name: /^Save preset/ });
  const reason = page.locator("#preset-save-reason");

  await saveNotOffered(page);
  await expect(openSave).toHaveAttribute("aria-describedby", "preset-save-reason");
  await expect(reason).toHaveText("No changes to save");

  // Focusable, which a disabled button is not: this is the whole reason for
  // marking it rather than disabling it.
  await openSave.focus();
  await expect(openSave).toBeFocused();

  // Activated from the keyboard rather than clicked, and not only because
  // Playwright declines to click what it reads as disabled. Being reachable is
  // what puts a keyboard user on this control at all, so pressing it is the
  // press that has to be declined — `aria-disabled` states and does not enforce,
  // and the browser delivers the activation either way.
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(openSave).toHaveAttribute("aria-expanded", "false");

  await page.getByLabel("Tempo in beats per minute").fill("120");
  await saveOffered(page);
  await expect(reason).toHaveText("Save this setup as a preset");
  await openSave.click();
  await expect(panel).toBeVisible();
});

/**
 * The word came off the submit, so for a reader who can see it the glyph is the
 * only thing left saying which of the two acts is about to happen: a check
 * writes a Preset that is not there, the arrow writes over one that is. The
 * control's name carries the same distinction where a glyph carries none, and
 * both have to follow the typed name rather than one of them.
 */
test("the submit shows in a glyph and in its name which of the two acts it will perform", async ({
  page,
}) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const panel = page.getByRole("region", { name: /^Save preset/ });
  const name = panel.getByRole("textbox", { name: "Preset name" });
  const check = panel.locator("#preset-save-icon-save");
  const arrow = panel.locator("#preset-save-icon-replace");

  await tempo.fill("120");
  await savePreset(page, "Rehearsal");

  await tempo.fill("121");
  await page.getByRole("button", { name: "+ Save" }).click();
  // It opens on the Preset this Configuration came from, which is a name already
  // stored, so this is a replacement before a key is pressed.
  await expect(name).toHaveValue("Rehearsal");
  await expect(arrow).toBeVisible();
  await expect(check).toBeHidden();
  await expect(panel.getByRole("button", { name: "Replace" })).toBeVisible();

  await name.fill("Rehearsal 2");
  await expect(check).toBeVisible();
  await expect(arrow).toBeHidden();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});

/**
 * The panel is as wide as the page, and a name field that took all of it put its
 * submit ten pixels inside the close control above — two unrelated actions in
 * one crowded corner. A name is short, so the field is bounded and the submit is
 * an icon beside it: one square the height of the field, and the row ends well
 * before the column the close control sits in.
 */
test("the save row is a bounded field and a square icon clear of the close control", async ({
  page,
}) => {
  const panel = page.getByRole("region", { name: /^Save preset/ });
  await page.getByLabel("Tempo in beats per minute").fill("120");
  await page.getByRole("button", { name: "+ Save" }).click();

  const field = await panel.getByRole("textbox", { name: "Preset name" }).boundingBox();
  const submit = await panel.getByRole("button", { name: /^(?:Save|Replace)$/ }).boundingBox();
  const close = await panel.getByRole("button", { name: "Close save preset" }).boundingBox();

  // Compared to the pixel rather than to the float: a field's height is padding
  // plus a line box, and a font metric that lands a fraction differently on
  // another platform is not the crowded corner this is here to catch.
  expect(submit.height).toBeCloseTo(field.height, 0);
  expect(submit.width).toBeCloseTo(submit.height, 0);
  expect(field.width).toBeLessThanOrEqual(360);
  expect(submit.x + submit.width).toBeLessThan(close.x - 24);
});

/**
 * A save closes the panel it was made from and makes the control that opened it
 * inert — what was just written is what this Configuration now is, so there is
 * nothing left to save. The submit focus was on goes with the panel, so both
 * branches have to place focus rather than let it fall to the document.
 */
test("saving keeps focus on a control rather than dropping it", async ({ page }) => {
  const tempo = page.getByLabel("Tempo in beats per minute");
  const presets = page.getByRole("button", { name: "Presets", exact: true });
  const openSave = page.getByRole("button", { name: "+ Save" });

  // Closed: focus returns to the chip the save was started from, which is inert
  // now and holds focus anyway, because it is marked rather than disabled.
  await tempo.fill("112");
  await savePreset(page, "Unwatched");
  await saveNotOffered(page);
  await expect(openSave).toBeFocused();

  // Open: the Preset the save just produced is on screen and is what the user
  // is most likely to act on next.
  await presets.click();
  await tempo.fill("113");
  await savePreset(page, "Watched");
  await expect(presetButton(page, "Watched")).toBeFocused();
});

/**
 * Three panels and two rules. Presets and Save are halves of one subject and sit
 * together — the save leaves focus on the new Preset, which requires the list to
 * be there. Help is a third subject and takes the same room, so it closes both,
 * and neither can be left rendered behind it.
 */
test("help replaces the preset and save panels, which sit together", async ({ page }) => {
  const presets = page.getByRole("button", { name: "Presets", exact: true });
  const openSave = page.getByRole("button", { name: "+ Save" });
  const presetPanel = page.locator("#preset-panel");
  const savePanel = page.locator("#save-panel");
  const helpPanel = page.locator("#help-panel");

  await page.getByLabel("Tempo in beats per minute").fill("120");
  await presets.click();
  await openSave.click();
  await expect(presetPanel).toBeVisible();
  await expect(savePanel).toBeVisible();

  await page.getByRole("button", { name: "Help" }).click();
  await expect(helpPanel).toBeVisible();
  await expect(presetPanel).toBeHidden();
  await expect(savePanel).toBeHidden();
  await expect(openSave).toHaveAttribute("aria-expanded", "false");

  // And back the other way: opening a save closes the help it replaced.
  await openSave.click();
  await expect(savePanel).toBeVisible();
  await expect(helpPanel).toBeHidden();
});
