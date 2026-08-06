import { expect, test } from "@playwright/test";

import { createConfiguration } from "../configuration.ts";
import { decodeSharePayload, encodeShareConfiguration } from "../share.ts";

type ShareScratchWindow = Window & {
  copiedShareUrl?: string;
  sharedData?: ShareData;
};

test("a Share link replaces and persists the unnamed stopped workspace", async ({ page }) => {
  const payload = await encodeShareConfiguration(
    createConfiguration({
      bpm: 175,
      sequence: { cycles: [{ rhythms: [{ signature: { count: 7, unit: 8 } }] }] },
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "polynome-configuration-v2",
      JSON.stringify({ bpm: 90, sequence: { cycles: [{ rhythms: [{}] }] } }),
    );
    localStorage.setItem("polynome-presets-v3", "[]");
  });

  await page.goto(`/#share=${payload}`);

  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("175");
  await expect(page.getByRole("button", { name: "Play metronome" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("status")).toHaveText("Shared configuration loaded");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  expect(
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem("polynome-configuration-v2") ?? "null");
      return {
        bpm: stored?.bpm,
        presets: localStorage.getItem("polynome-presets-v3"),
      };
    }),
  ).toEqual({ bpm: 175, presets: "[]" });

  await page.getByRole("button", { name: "+ Save" }).click();
  await expect(page.getByRole("textbox", { name: "Preset name" })).toHaveValue("");
});

test("Share is available between Save and Colour when gzip streams are supported", async ({
  page,
}) => {
  await page.goto("/");

  const share = page.getByRole("button", { name: "Share current configuration" });
  await expect(share).toBeVisible();
  await expect(share).toHaveAttribute("title", "Share current configuration");
  expect(
    await page
      .locator(".header-actions > button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") || button.textContent?.trim()),
      ),
  ).toEqual(["Presets", "+ Save", "Share current configuration", "Colour", "Help"]);
});

test("Share stays hidden without both gzip stream APIs", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "CompressionStream", { value: undefined });
  });
  await page.goto("/");

  await expect(page.locator("#share-configuration")).toBeHidden();
});

test("Share sends the current Configuration URL to the native share sheet", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data) => {
        (window as ShareScratchWindow).sharedData = data;
        return Promise.resolve();
      },
    });
  });
  await page.goto("/");
  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await bpm.fill("145");
  await bpm.blur();
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Share current configuration" }).click();

  await expect
    .poll(() => page.evaluate(() => (window as ShareScratchWindow).sharedData))
    .toMatchObject({ title: "Polynome" });
  const shared = await page.evaluate(() => (window as ShareScratchWindow).sharedData);
  if (!shared?.url) throw new Error("Native share did not receive a URL");
  expect(shared).not.toHaveProperty("text");
  const sharedUrl = new URL(shared.url);
  expect(sharedUrl.origin).toBe(new URL(page.url()).origin);
  expect(sharedUrl.pathname).toBe("/");
  expect(sharedUrl.hash).toMatch(/^#share=[A-Za-z0-9_-]+$/);
  expect((await decodeSharePayload(sharedUrl.hash.slice("#share=".length))).bpm).toBe(145);
  await expect(page.getByRole("button", { name: "Stop metronome" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("status")).toHaveText("Configuration shared");
});

test("Share copies the URL when native sharing is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value) => {
          (window as ShareScratchWindow).copiedShareUrl = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Share current configuration" }).click();

  await expect
    .poll(() => page.evaluate(() => (window as ShareScratchWindow).copiedShareUrl))
    .toMatch(/#share=[A-Za-z0-9_-]+$/);
  await expect(page.locator("#feedback")).toHaveText("Share link copied");
  await expect(page.locator("#feedback")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Share link copied");
});

test("Share falls back to copying after a native-share failure", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Share failed", "NotAllowedError")),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value) => {
          (window as ShareScratchWindow).copiedShareUrl = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Share current configuration" }).click();

  await expect
    .poll(() => page.evaluate(() => (window as ShareScratchWindow).copiedShareUrl))
    .toMatch(/#share=[A-Za-z0-9_-]+$/);
  await expect(page.locator("#feedback")).toHaveText("Share link copied");
});

test("cancelling native sharing is silent", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Cancelled", "AbortError")),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          throw new Error("Clipboard must not run after cancellation");
        },
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Share current configuration" }).click();

  await expect(page.getByRole("status")).toHaveText("Stopped");
  await expect(page.locator("#feedback")).toBeHidden();
});

test("Help explains that a Share link remains unnamed until saved", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Help" }).click();

  await expect(page.getByRole("region", { name: "Help" })).toContainText(
    "Share creates a link to the current configuration. It remains unnamed until you save it as a preset.",
  );
});

test("an invalid Share link preserves the stored workspace and reports the failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "polynome-configuration-v2",
      JSON.stringify({ bpm: 91, sequence: { cycles: [{ rhythms: [{}] }] } }),
    );
  });

  await page.goto("/#share=not-a-gzip-payload");

  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("91");
  await expect(page.locator("#feedback")).toHaveText("This share link could not be loaded.");
  await expect(page.locator("#feedback")).toBeVisible();
  const feedback = page.locator(".page-header + #feedback");
  await expect(feedback).toBeVisible();
  expect(await feedback.evaluate((element) => getComputedStyle(element).paddingTop)).not.toBe(
    "0px",
  );
  const feedbackBox = await feedback.boundingBox();
  if (!feedbackBox) throw new Error("Visible Share feedback has no bounding box");
  expect(feedbackBox.x + feedbackBox.width).toBeLessThanOrEqual(360);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
});

test("a Share link remains recoverable when workspace storage is refused", async ({ page }) => {
  const payload = await encodeShareConfiguration(createConfiguration({ bpm: 188 }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage refused", "SecurityError");
      },
    });
  });

  await page.goto(`/#share=${payload}`);

  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("188");
  await expect(page.locator("#feedback")).toHaveText(
    "Shared configuration could not be saved in this browser",
  );
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#share=${payload}`);
});

test("Share remains usable in the narrow mobile header", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");

  const share = page.getByRole("button", { name: "Share current configuration" });
  await expect(share).toBeVisible();
  const box = await share.boundingBox();
  if (!box) throw new Error("Visible Share control has no bounding box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});
