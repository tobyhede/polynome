import { expect, type Page, test } from "@playwright/test";

import { createConfiguration } from "../configuration.ts";
import { decodeShareConfigurationFragment, encodeShareConfiguration } from "../share.ts";

const STORED_CONFIGURATION_KEY = "polynome-configuration-v2";

type ShareScratchWindow = Window & {
  announcementLog?: string[];
  copiedShareUrl?: string;
  releaseShareDecode?: (index: number) => void;
  shareDecodeBegun?: (index: number) => boolean;
  sharedData?: ShareData;
};

/**
 * Holds Share decoding open, one decode at a time. `DecompressionStream` is the
 * narrowest seam a decode can be stalled through from outside the application,
 * and holding two of them open at once is what turns two concurrent Share loads
 * from a race the runner decides into an interleaving this file chooses: decodes
 * are numbered in the order they begin, and each one resumes only when its own
 * number is released.
 */
async function stallShareDecoding(page: Page) {
  await page.addInitScript(() => {
    const NativeDecompressionStream = window.DecompressionStream;
    const releases: (() => void)[] = [];
    const begun: boolean[] = [];
    const scratch = window as ShareScratchWindow;
    scratch.releaseShareDecode = (index) => releases[index]?.();
    scratch.shareDecodeBegun = (index) => begun[index] === true;
    Object.defineProperty(window, "DecompressionStream", {
      configurable: true,
      value: class {
        readable: ReadableStream;
        writable: WritableStream;

        constructor(format: CompressionFormat) {
          const native = new NativeDecompressionStream(format);
          const index = releases.length;
          const gate = new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          this.writable = native.writable;
          this.readable = native.readable.pipeThrough(
            new TransformStream({
              async transform(chunk, controller) {
                begun[index] = true;
                await gate;
                controller.enqueue(chunk);
              },
            }),
          );
        }
      },
    });
  });
}

const decodeBegun = (page: Page, index: number) =>
  page.evaluate((at) => (window as ShareScratchWindow).shareDecodeBegun?.(at), index);

const releaseDecode = (page: Page, index: number) =>
  page.evaluate((at) => (window as ShareScratchWindow).releaseShareDecode?.(at), index);

const storedBpm = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.bpm,
    STORED_CONFIGURATION_KEY,
  );

const seedStoredConfiguration = (page: Page, bpm: number) =>
  page.addInitScript(
    ([key, seededBpm]) => {
      localStorage.setItem(
        key as string,
        JSON.stringify({ bpm: seededBpm, sequence: { cycles: [{ rhythms: [{}] }] } }),
      );
    },
    [STORED_CONFIGURATION_KEY, bpm],
  );

/**
 * The order in which the shell closes, is handed back, and has each message
 * written into `#status` or `#feedback`. Both regions live inside `<main>`, and
 * an inert subtree is out of the accessibility tree, so a message written while
 * the shell is still inert is a live-region mutation with nothing listening —
 * and lifting `inert` afterwards leaves nothing to announce.
 *
 * The shell's state is carried from record to record rather than read off the
 * document, because handing the shell back and writing the message are one
 * synchronous block and this callback runs after it: read live, `inert` is
 * already gone whichever order the two happened in. Records arrive in the order
 * the mutations did, so this is the ordering itself and not a timing.
 *
 * The shell's own transitions are logged beside the messages, and that is what
 * an assertion can hold the ordering by. A log of messages alone reads
 * `inert=false` throughout on a page where nothing ever sets `inert`, so it
 * passes most easily on the page that has had the behaviour removed.
 *
 * Two things keep an entry to the mutation that produced it. The text comes off
 * the record rather than off the region, because the region read back at flush
 * time holds whatever the last write in the block left, which would stamp the
 * final message onto every earlier entry. And a write that leaves a region
 * showing exactly what it already showed is not logged: a render restating the
 * transport status it was already displaying announces nothing, and logging it
 * would make the timeline a record of renders rather than of what was said.
 */
async function recordAnnouncements(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as ShareScratchWindow).announcementLog = log;
    let shellInert = false;
    const announced: Record<string, string> = {};
    new MutationObserver((records) => {
      for (const record of records) {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (!element) continue;
        if (record.type === "attributes") {
          if (!element.matches("main")) continue;
          shellInert = element.hasAttribute("inert");
          log.push(`shell inert=${shellInert}`);
          continue;
        }
        const region = element.closest("#status, #feedback");
        if (!region) continue;
        const text = (
          record.type === "childList"
            ? Array.from(record.addedNodes, (node) => node.textContent ?? "").join("")
            : (record.target as CharacterData).data
        ).trim();
        if (!text || announced[region.id] === text) continue;
        announced[region.id] = text;
        log.push(`${region.id} inert=${shellInert}: ${text}`);
      }
    }).observe(document, {
      attributeFilter: ["inert"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

const announcements = (page: Page) =>
  page.evaluate(() => (window as ShareScratchWindow).announcementLog ?? []);

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

  await page.goto(`/?display=compact#share=${payload}`);

  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("175");
  // The Meter travelled too, and this is the only place that says so through the
  // browser: the layer names itself 7/8 and lays out one Beat control per
  // signature unit, so both halves of the Signature are read back off what was
  // rendered rather than off the payload. The codec seam is covered from Node in
  // `test/share.test.ts`; what is asserted here is that the link reached the
  // interface.
  const voices = page.getByRole("group", { name: "7/8 beat voices" });
  await expect(voices).toBeVisible();
  await expect(voices.getByRole("button")).toHaveCount(7);
  await expect(voices.getByRole("button").first()).toHaveAccessibleName("Beat 1: primary voice");
  await expect(page.getByRole("button", { name: "Play metronome" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("status")).toHaveText("Stopped");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?display=compact");
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

test("the workspace stays unavailable until a Share link finishes loading", async ({ page }) => {
  const payload = await encodeShareConfiguration(createConfiguration({ bpm: 175 }));
  await seedStoredConfiguration(page, 90);
  await stallShareDecoding(page);

  await page.goto(`/#share=${payload}`);
  await expect.poll(() => decodeBegun(page, 0)).toBe(true);

  const workspace = page.locator("main");
  await expect(workspace).toHaveAttribute("inert", "");
  const play = page.getByRole("button", { name: "Play metronome" });
  const playBox = await play.boundingBox();
  if (!playBox) throw new Error("Play control has no bounding box");
  await page.mouse.click(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "false");

  await releaseDecode(page, 0);

  await expect(workspace).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("175");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.waitForTimeout(500);
  await expect.poll(() => storedBpm(page)).toBe(175);
});

/**
 * The two loads below are the pair the application cannot serialize on its own:
 * a startup load and a `hashchange` load, in flight together and finishing in
 * whatever order their decoding does. Both tests hold each decode open by number
 * so the losing one finishes at a moment of this file's choosing.
 */
test("a superseded Share load leaves the newer link's workspace alone", async ({ page }) => {
  // Gzips cleanly, so the stalled decode reaches the Configuration check and
  // fails there. That is the branch worth superseding: it carries a fallback
  // captured before the newer link existed, and a message that would land over a
  // Configuration which loaded correctly.
  const supersededPayload = await encodeShareConfiguration({ sequence: { cycles: [] } });
  const newerPayload = await encodeShareConfiguration(createConfiguration({ bpm: 143 }));
  await seedStoredConfiguration(page, 90);
  await stallShareDecoding(page);

  await page.goto(`/#share=${supersededPayload}`);
  await expect.poll(() => decodeBegun(page, 0)).toBe(true);
  await page.evaluate((payload) => {
    location.hash = `share=${payload}`;
  }, newerPayload);
  await expect.poll(() => decodeBegun(page, 1)).toBe(true);

  await releaseDecode(page, 1);

  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await expect(bpm).toHaveValue("143");
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect.poll(() => storedBpm(page)).toBe(143);

  await releaseDecode(page, 0);
  // A superseded load does nothing, and nothing is what there is to wait for, so
  // this is the settle a negative needs: long enough for the released decode and
  // everything chained behind it to have run.
  await page.waitForTimeout(500);

  await expect(bpm).toHaveValue("143");
  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Stopped");
  expect(await storedBpm(page)).toBe(143);
});

test("a superseded Share load does not hand back a workspace still loading", async ({ page }) => {
  const supersededPayload = await encodeShareConfiguration(createConfiguration({ bpm: 175 }));
  const newerPayload = await encodeShareConfiguration(createConfiguration({ bpm: 143 }));
  await seedStoredConfiguration(page, 90);
  await stallShareDecoding(page);

  await page.goto(`/#share=${supersededPayload}`);
  await expect.poll(() => decodeBegun(page, 0)).toBe(true);
  await page.evaluate((payload) => {
    location.hash = `share=${payload}`;
  }, newerPayload);
  await expect.poll(() => decodeBegun(page, 1)).toBe(true);

  await releaseDecode(page, 0);
  await page.waitForTimeout(500);

  const workspace = page.locator("main");
  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await expect(workspace).toHaveAttribute("inert", "");
  await expect(bpm).toHaveValue("90");
  await expect(page.locator("#feedback")).toBeHidden();
  expect(await storedBpm(page)).toBe(90);

  await releaseDecode(page, 1);

  await expect(workspace).not.toHaveAttribute("inert", "");
  await expect(bpm).toHaveValue("143");
  await expect.poll(() => storedBpm(page)).toBe(143);
});

/**
 * The window the numbering alone cannot close, and the reason the two loads
 * below release their decode from inside the block that moves the hash rather
 * than after it. Assigning `location.hash` moves the URL synchronously and
 * queues the `hashchange` as a task; everything from a released decode to the
 * write it lands is microtasks, and microtasks drain before the next task runs.
 * So the load in flight resolves while it is still the newest number anyone has
 * claimed, which is exactly the moment it must be made to notice that the link
 * it decoded is no longer the link in the URL. Awaiting anything between the two
 * statements hands the queued `hashchange` its turn and tests the numbering
 * again instead.
 */
test("a Share load replaced before its hashchange runs takes neither the URL nor the workspace", async ({
  page,
}) => {
  const supersededPayload = await encodeShareConfiguration(createConfiguration({ bpm: 175 }));
  const newerPayload = await encodeShareConfiguration(createConfiguration({ bpm: 143 }));
  await seedStoredConfiguration(page, 90);
  await stallShareDecoding(page);

  await page.goto(`/#share=${supersededPayload}`);
  await expect.poll(() => decodeBegun(page, 0)).toBe(true);

  await page.evaluate((payload) => {
    location.hash = `share=${payload}`;
    (window as ShareScratchWindow).releaseShareDecode?.(0);
  }, newerPayload);
  // Nothing is what the replaced load has to do, so this is the settle a
  // negative needs: long enough for it to have finished, and for the
  // `hashchange` queued behind it to have begun the newer link's own decode.
  await page.waitForTimeout(500);

  const workspace = page.locator("main");
  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await expect(bpm).toHaveValue("90");
  expect(await storedBpm(page)).toBe(90);
  // The newer link is still in the URL to be loaded from, which is what a load
  // that consumed the fragment with `history.replaceState` would have taken with
  // it — leaving a page whose hash a refresh could not recover the link from.
  expect(await page.evaluate(() => location.hash)).toBe(`#share=${newerPayload}`);
  await expect(workspace).toHaveAttribute("inert", "");
  expect(await decodeBegun(page, 1)).toBe(true);

  await releaseDecode(page, 1);

  await expect(workspace).not.toHaveAttribute("inert", "");
  await expect(bpm).toHaveValue("143");
  await expect(page.locator("#feedback")).toBeHidden();
  await expect.poll(() => storedBpm(page)).toBe(143);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
});

/**
 * The same window entered from the side no number is ever claimed on: a hash
 * that is not a Share link starts no load, so nothing exists to supersede the
 * one in flight, and it must still leave the hash the reader navigated to alone.
 * The workspace is the other half, and it is the half that has no successor — no
 * later load is coming to hand it back, so the abandoned load has to.
 */
test("a Share load abandoned for an ordinary hash gives the workspace back", async ({ page }) => {
  const payload = await encodeShareConfiguration(createConfiguration({ bpm: 175 }));
  await seedStoredConfiguration(page, 90);
  await stallShareDecoding(page);

  await page.goto(`/#share=${payload}`);
  await expect.poll(() => decodeBegun(page, 0)).toBe(true);

  await page.evaluate(() => {
    location.hash = "help";
    (window as ShareScratchWindow).releaseShareDecode?.(0);
  });
  await page.waitForTimeout(500);

  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(bpm).toHaveValue("90");
  await expect(page.locator("#feedback")).toBeHidden();
  expect(await storedBpm(page)).toBe(90);
  expect(await page.evaluate(() => location.hash)).toBe("#help");
});

test("a Share fragment received by an open page replaces the workspace", async ({ page }) => {
  const payload = await encodeShareConfiguration(createConfiguration({ bpm: 167 }));
  await page.addInitScript(() => {
    localStorage.setItem(
      "polynome-configuration-v2",
      JSON.stringify({ bpm: 90, sequence: { cycles: [{ rhythms: [{}] }] } }),
    );
  });
  await page.goto("/?display=compact");
  const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
  await bpm.fill("111");
  await bpm.blur();
  await page.getByRole("button", { name: "Play metronome" }).click();
  await expect(page.getByRole("button", { name: "Stop metronome" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.evaluate((sharePayload) => {
    location.hash = `share=${sharePayload}`;
  }, payload);

  await expect(bpm).toHaveValue("167");
  await expect(page.getByRole("button", { name: "Play metronome" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("status")).toHaveText("Stopped");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?display=compact");
  await page.waitForTimeout(500);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("polynome-configuration-v2") ?? "null")?.bpm,
      ),
    )
    .toBe(167);
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
  await page.goto("/?display=compact");
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
  expect(sharedUrl.search).toBe("");
  expect(sharedUrl.hash).toMatch(/^#share=[A-Za-z0-9_-]+$/);
  expect((await decodeShareConfigurationFragment(sharedUrl.hash)).bpm).toBe(145);
  await expect(page.getByRole("button", { name: "Stop metronome" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("status")).toHaveText("Playing");
});

test("a successful native share clears an earlier failure", async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new DOMException("Share failed", "NotAllowedError"))
          : Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Clipboard refused")) },
    });
  });
  await page.goto("/");

  const share = page.getByRole("button", { name: "Share current configuration" });
  await share.click();
  await expect(page.locator("#feedback")).toHaveText("Configuration could not be shared");
  await expect(page.locator("#feedback")).toBeVisible();

  await share.click();

  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Stopped");
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
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#share=not-a-gzip-payload");
});

/**
 * A load that fails adopts the workspace it was handed as its own fallback, so
 * the Configuration left on screen is the one that was already there and nothing
 * about it arrived from the link — least of all the Preset it came from. Clearing
 * the Preset origin regardless leaves a Configuration identical to a stored
 * Preset reading as unsaved, and + Save then offers, under a blank name, to store
 * a second copy of the Preset that is already there.
 */
test("an invalid Share link leaves an applied Preset still saved", async ({ page }) => {
  await page.goto("/");
  const presets = page.getByRole("button", { name: "Presets", exact: true });
  await presets.click();
  await page.getByRole("button", { name: /^4\/4 8ths\b/ }).click();
  await presets.click();
  const openSave = page.getByRole("button", { name: "+ Save" });
  await expect(openSave).toHaveAttribute("aria-disabled", "true");

  await page.evaluate(() => {
    location.hash = "share=not-a-gzip-payload";
  });

  await expect(page.locator("#feedback")).toHaveText("This share link could not be loaded.");
  await expect(page.getByRole("status")).toHaveText("This share link could not be loaded.");
  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("120");
  await expect(openSave).toHaveAttribute("aria-disabled", "true");
  await expect(openSave).toHaveAttribute("title", "No changes to save");
  await expect(openSave).not.toHaveClass(/\bis-live\b/);
  await expect(page.locator("#preset-save-reason")).toHaveText("No changes to save");
});

/**
 * Issue #34 asks the Share feedback surface for corresponding live-region
 * announcements, and both regions sit inside the shell a Share load makes inert.
 * The two tests below hold the ordering that makes the announcement reach the
 * accessibility tree at all, on each of the paths that can load a link.
 *
 * The whole timeline is asserted rather than the two messages being looked for
 * within it, and that is what makes either test capable of failing. A load that
 * never closed the shell would report `inert=false` at every point and satisfy
 * any assertion phrased as "each message carried `inert=false`", so the closing
 * and the handing back are entries in their own right and the message entries
 * have to fall after both. Asserted as a whole rather than as a subset, a
 * message written twice — once into the inert shell and again out of it — is a
 * timeline that no longer matches, where a subset would still find what it was
 * looking for.
 *
 * It opens on the transport status the markup arrives carrying, logged as the
 * parser writes it and before any load has begun.
 */
const FAILURE_ANNOUNCEMENTS = [
  "status inert=false: Stopped",
  "shell inert=true",
  "shell inert=false",
  "feedback inert=false: This share link could not be loaded.",
  "status inert=false: This share link could not be loaded.",
];

test("an invalid Share link announces its failure outside the inert shell", async ({ page }) => {
  await recordAnnouncements(page);
  await seedStoredConfiguration(page, 91);

  await page.goto("/#share=not-a-gzip-payload");

  await expect(page.locator("#feedback")).toHaveText("This share link could not be loaded.");
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  // The workspace the link failed to replace, which is the other half of what a
  // failure has to leave behind: the message says so, and this is what it is
  // saying it about.
  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("91");
  expect(await announcements(page)).toEqual(FAILURE_ANNOUNCEMENTS);
});

test("an invalid Share fragment on an open page announces outside the inert shell", async ({
  page,
}) => {
  await recordAnnouncements(page);
  await seedStoredConfiguration(page, 91);
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Stopped");

  await page.evaluate(() => {
    location.hash = "share=not-a-gzip-payload";
  });

  await expect(page.locator("#feedback")).toHaveText("This share link could not be loaded.");
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" }),
  ).toHaveValue("91");
  expect(await announcements(page)).toEqual(FAILURE_ANNOUNCEMENTS);
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
  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Stopped");
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
