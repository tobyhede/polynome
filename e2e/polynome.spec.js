import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

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
  const preset = page.getByRole("button", { name: "4/4", exact: true });
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
  await expect(page.getByRole("button", { name: "4/4", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
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
