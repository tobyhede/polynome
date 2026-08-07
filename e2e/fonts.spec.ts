import { type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test";

/**
 * What the two embedded faces actually draw, asked of the painted page rather
 * than of the font files.
 *
 * The mechanism is CDP `CSS.getPlatformFontsForNode`, which reports the families
 * Chromium shaped a node's text with, straight off the shaping result, with a
 * glyph count per family — so a node whose text fell back partway shows two
 * entries and says how many glyphs each face contributed. Nothing else answers
 * the question. `document.fonts.check()` reports load state and the declared
 * `unicode-range`, never the file's character map, and returned `true` for a
 * character the loaded face demonstrably lacked; a width comparison cannot help
 * either, because every face in both of this repository's stacks is monospaced
 * at the same advance, so a fallback moves the measurement by hundredths of a
 * pixel and by exactly nothing for a single glyph. Both were measured, in
 * `docs/research/detecting-font-fallback-in-browser-tests.md`, which also
 * carries the three silent traps the helpers below route around.
 */

type ShapedFont = { family: string; embedded: boolean; glyphs: number };

/**
 * The families that shaped one element's text.
 *
 * `documentNodeId` is optional because it answers two different needs. A single
 * probe takes the document again on every call, which is what keeps it correct
 * across a Preact re-render: `getPlatformFontsForNode` resolves a `nodeId`
 * through the DOM agent, which only knows nodes `DOM.getDocument` has pushed. A
 * sweep instead takes it once and hands it to every element, because it tags the
 * tree and reads it straight back with no render in between, and a hundred
 * elements is a hundred round trips saved.
 */
async function shapedBy(
  session: CDPSession,
  selector: string,
  documentNodeId?: number,
): Promise<ShapedFont[]> {
  const root = documentNodeId ?? (await session.send("DOM.getDocument")).root.nodeId;
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root, selector });
  expect(nodeId, `no element matched ${selector}`).toBeGreaterThan(0);
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });

  // An empty report is the trap this assertion exists for: it means the text is
  // more than two element levels below the node, or the node has no layout box,
  // and it reads exactly like "nothing fell back". Chromium descends two levels
  // and no further, so `.preset-notation` — whose text sits deeper — reports
  // nothing at all, as does anything inside a `hidden` section.
  expect(fonts, `${selector} reported no shaped text`).not.toHaveLength(0);

  // Keyed by family rather than by PostScript name: the body face is variable,
  // and Chromium names the instance, so one family arrives as
  // JetBrainsMono-Regular, JetBrainsMonoRoman-Bold and
  // JetBrainsMonoRoman-ExtraBold depending on the weight asked for. The array is
  // built from a hash map, so its order is not specified either.
  return fonts.map((font) => ({
    family: font.familyName,
    embedded: font.isCustomFont,
    glyphs: font.glyphCount,
  }));
}

/**
 * Both faces declare `font-display: swap`, so a reading taken before the face
 * arrives is a reading of the fallback. `document.fonts.ready` is the specified
 * gate and fulfils only once layout has completed with no further font load
 * outstanding — but it fulfils once and never again, so anything drawn after it
 * resolved needs a frame of its own before a shaping result exists to report.
 */
async function settleFonts(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.evaluate(
    () =>
      new Promise<void>((settle) =>
        requestAnimationFrame(() => requestAnimationFrame(() => settle())),
      ),
  );
}

/**
 * `CSS.enable` fails outright with "DOM agent needs to be enabled first", so
 * this order is not a matter of taste.
 */
async function fontSession(page: Page, context: BrowserContext) {
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await settleFonts(page);
  return session;
}

type Probe = { index: number; label: string };

/**
 * Every element carrying a direct, non-whitespace text child, tagged so CDP can
 * reach it by selector and labelled so a failure names something a reader can
 * find in the source.
 *
 * Direct text is what makes this exhaustive without an exception list. The
 * element holding the characters is the one queried, so nothing depends on how
 * deep the interface nests — which matters, because the report only descends two
 * element levels and returns an empty array rather than an error when it runs
 * out.
 *
 * `checkVisibility()` is the other half of that trap. A node with no layout
 * object reports nothing, and nothing reads exactly like "no fallback here":
 * `display: none`, which is what the `hidden` attribute on the closed panels
 * resolves to, has no layout object and must be excluded. Off-screen positioning
 * and `visibility: hidden` both still shape and still report, so the
 * visually-hidden text this interface writes for screen readers is swept rather
 * than waved through.
 */
async function tagTextBearingElements(page: Page): Promise<Probe[]> {
  return page.evaluate(() => {
    const name = (element: Element) => {
      if (element.id !== "") return `#${element.id}`;
      const classes = Array.from(element.classList)
        .map((className) => `.${className}`)
        .join("");
      return `${element.localName}${classes}`;
    };

    const probes: { index: number; label: string }[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      const text = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim();
      if (text === "" || !element.checkVisibility()) continue;
      const index = probes.length;
      element.setAttribute("data-font-probe", String(index));
      probes.push({ index, label: `${name(element)} ${JSON.stringify(text.slice(0, 40))}` });
    }
    return probes;
  });
}

/**
 * Every element in the interface that draws text, reported as the ones drawing
 * any of it in a face Polynome does not ship.
 */
async function textDrawnByAnUnshippedFace(page: Page, session: CDPSession): Promise<string[]> {
  const probes = await tagTextBearingElements(page);
  // A sweep that found nothing to look at is a sweep that passes forever.
  expect(probes.length, "the sweep found no text to check").toBeGreaterThan(0);

  const { root } = await session.send("DOM.getDocument");
  const strangers: string[] = [];
  for (const { index, label } of probes) {
    const shaped = await shapedBy(session, `[data-font-probe="${index}"]`, root.nodeId);
    const foreign = shaped.filter((font) => !font.embedded);
    if (foreign.length === 0) continue;
    strangers.push(
      `${label} drew ${foreign.map(({ family, glyphs }) => `${glyphs} in ${family}`).join(" and ")}`,
    );
  }

  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-font-probe]")) {
      element.removeAttribute("data-font-probe");
    }
  });
  return strangers;
}

/**
 * The states the sweep visits, and why more than the default one is needed: the
 * arrow, the stop mark and the disclosure mark are not on screen when the page
 * loads, and a subset is only proved against the characters something actually
 * draws. Each state arranges itself from a fresh load, so one leaving the
 * workspace changed cannot decide what the next one sweeps.
 */
const INTERFACE_STATES: ReadonlyArray<{ name: string; reach: (page: Page) => Promise<void> }> = [
  {
    name: "the default view",
    reach: async (page) => {
      await page.goto("/");
    },
  },
  {
    name: "the help panel",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Help" }).click();
      await expect(page.locator("#help-panel")).toBeVisible();
    },
  },
  {
    name: "the colour panel",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Colour", exact: true }).click();
      await expect(page.locator("#accent-panel")).toBeVisible();
    },
  },
  {
    /**
     * The seeded Presets are all one Cycle holding one tempo, and such a Preset
     * draws neither the Sequence separator nor an envelope notation. Both reach
     * a card only once a Configuration carrying two Cycles and a pair of ramps
     * has been saved as one, which is also the only place the interface draws
     * the two envelope arrows.
     */
    name: "a saved Preset of two Cycles that change tempo",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Edit Cycle envelope" }).click();
      await page.locator(".cycle-settings").getByRole("button", { name: "Up" }).click();
      await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
      await page.getByRole("button", { name: "Edit Cycle 2 envelope" }).click();
      await page.locator(".cycle-settings").nth(1).getByRole("button", { name: "Down" }).click();
      await page.getByRole("button", { name: "Presets", exact: true }).click();
      const openSave = page.getByRole("button", { name: "+ Save" });
      await expect(openSave).toHaveAttribute("aria-disabled", "false");
      await openSave.click();
      const savePanel = page.getByRole("region", { name: "Save preset" });
      await savePanel.getByRole("textbox", { name: "Preset name" }).fill("Two Cycles");
      await savePanel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
      // `#status` by id rather than by role: the open envelope drawers put two
      // `<output>` elements in the document, and an `<output>` is a status too.
      await expect(page.locator("#status")).toHaveText("Two Cycles preset saved");
      await expect(page.locator(".preset-sequence-arrow").first()).toBeVisible();
      await expect(page.locator(".preset-envelope")).toHaveCount(2);
    },
  },
  {
    name: "a copied Share link",
    reach: async (page) => {
      // Neither sharing route can run unattended, so the copy is stubbed at the
      // point the application reaches for it — which is the same seam
      // `e2e/share.spec.ts` uses, and it leaves the feedback the sweep is here
      // for untouched.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.resolve() },
        });
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Share current configuration" }).click();
      await expect(page.locator("#feedback")).toHaveText("Share link copied");
    },
  },
  {
    name: "a Share link that could not be loaded",
    reach: async (page) => {
      await page.goto("/index.html#share=not-a-gzip-payload");
      await expect(page.locator("#feedback")).toBeVisible();
    },
  },
  {
    /**
     * The rhythm drawer holds most of the interface's form controls, and the
     * Subdivision picker holds the disclosure mark.
     */
    name: "an open rhythm's settings",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
      await expect(page.locator(".rhythm-settings").first()).toBeVisible();
      await page.getByRole("button", { name: "4/4 subdivision" }).click();
      await expect(page.getByRole("option", { name: /3 per quarter unit/ })).toBeVisible();
    },
  },
  {
    /**
     * A Flat envelope is one number; only a ramp draws the arrow, and it draws
     * it in the display face, which is the one place either face is asked for a
     * character outside printable ASCII.
     */
    name: "a rising Cycle envelope",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Edit Cycle envelope" }).click();
      await page.locator(".cycle-settings").getByRole("button", { name: "Up" }).click();
      await expect(page.locator(".envelope-tempo output")).toContainText("→");
    },
  },
  {
    name: "a second Cycle in the Sequence",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
      await page.getByRole("button", { name: "Edit Cycle 2 envelope" }).click();
      await expect(page.locator(".cycle-settings").nth(1)).toBeVisible();
    },
  },
  {
    name: "the playing transport",
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Play metronome" }).click();
      await expect(page.getByRole("button", { name: "Stop metronome" })).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Playing");
    },
  },
];

/**
 * The assertion the upstream cut exists to make possible, and it is
 * unconditional on purpose. An exception list would be a hole that widens: a
 * character waved through here is one nobody notices the subset never carried,
 * and the next one lands beside it.
 */
for (const { name, reach } of INTERFACE_STATES) {
  test(`every character ${name} draws in an embedded face`, async ({ page, context }) => {
    await reach(page);
    const session = await fontSession(page, context);

    expect(await textDrawnByAnUnshippedFace(page, session)).toEqual([]);
  });
}
