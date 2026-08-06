import { expect, test } from "@playwright/test";

const bundle = new URL("../dist/polynome.html", import.meta.url).href;

test("the single-file bundle boots and plays from the filesystem", async ({ page }) => {
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));

  await page.goto(bundle);

  const play = page.getByRole("button", { name: "Play metronome" });
  await expect(play).toBeVisible();
  await expect(page.getByRole("group", { name: "4/4 beat voices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share current configuration" })).toBeVisible();

  await play.click();
  await expect(page.getByRole("status")).toHaveText("Playing");

  expect(failures).toEqual([]);
});
