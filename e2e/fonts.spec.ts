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
 * The node the report can be asked about, which is not the element until the DOM
 * agent has been told the element exists.
 *
 * `documentNodeId` is optional because it answers two different needs. A single
 * probe takes the document again on every call, which is what keeps it correct
 * across a Preact re-render: `getPlatformFontsForNode` resolves a `nodeId`
 * through the DOM agent, which only knows nodes `DOM.getDocument` has pushed. A
 * sweep instead takes it once and hands it to every element, because it tags the
 * tree and reads it straight back with no render in between, and a hundred
 * elements is a hundred round trips saved.
 */
async function nodeFor(session: CDPSession, selector: string, documentNodeId?: number) {
  const root = documentNodeId ?? (await session.send("DOM.getDocument")).root.nodeId;
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root, selector });
  expect(nodeId, `no element matched ${selector}`).toBeGreaterThan(0);
  return nodeId;
}

/** The families that shaped one element's text. */
async function shapedBy(
  session: CDPSession,
  selector: string,
  documentNodeId?: number,
): Promise<ShapedFont[]> {
  const nodeId = await nodeFor(session, selector, documentNodeId);
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });

  // An empty report is the trap this assertion exists for: it means the text is
  // more than two element levels below the node, or the node has no layout box,
  // and it reads exactly like "nothing fell back". Chromium descends two levels
  // and no further, so `.preset-notation` — whose text sits deeper — reports
  // nothing at all, as does anything inside a `hidden` section.
  expect(fonts, `${selector} reported no shaped text`).not.toHaveLength(0);
  return shapedFrom(fonts);
}

/**
 * Keyed by family rather than by PostScript name: the body face is variable, and
 * Chromium names the instance, so one family arrives as JetBrainsMono-Regular,
 * JetBrainsMonoRoman-Bold and JetBrainsMonoRoman-ExtraBold depending on the
 * weight asked for. The array is built from a hash map, so its order is not
 * specified either.
 */
function shapedFrom(fonts: { familyName: string; isCustomFont: boolean; glyphCount: number }[]) {
  return fonts.map((font) => ({
    family: font.familyName,
    embedded: font.isCustomFont,
    glyphs: font.glyphCount,
  }));
}

/**
 * The families that shaped the value a form control draws.
 *
 * A control has no text child, and what draws its value is an editing host
 * inside a user-agent shadow root. How far down that host sits is the type's
 * business: a `<select>` and a `type="text"` field put it one level below the
 * control, where the descent reaches it and this is `shapedBy` under another
 * name. `type="number"` wraps it in the container Chromium hangs the spin
 * buttons off, which puts the text three levels down and one past where the
 * descent gives up — so an empty report on a control is not the trap it is
 * everywhere else in this file. It means look further in, and the shadow tree
 * says whether there is anything to find.
 *
 * A slider and a checkbox hold a value and draw no text at all, and they are the
 * one case an empty report may pass. What lets it pass is their shadow tree
 * holding no text, rather than the report saying none was shaped: the same
 * silence, for two entirely different reasons.
 */
async function valueShapedBy(
  session: CDPSession,
  selector: string,
  documentNodeId?: number,
): Promise<ShapedFont[]> {
  const nodeId = await nodeFor(session, selector, documentNodeId);
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  if (fonts.length > 0) return shapedFrom(fonts);

  const host = await editingHost(session, nodeId);
  if (host === undefined) return [];
  const { fonts: drawn } = await session.send("CSS.getPlatformFontsForNode", { nodeId: host });
  expect(drawn, `${selector} drew text its editing host did not report`).not.toHaveLength(0);
  return shapedFrom(drawn);
}

// CDP gives a node's type as the number the DOM gives it, and `Node` is a
// browser global that does not exist this side of the wire.
const TEXT_NODE = 3;

type PiercedNode = {
  nodeType: number;
  nodeValue: string;
  backendNodeId: number;
  children?: PiercedNode[];
  shadowRoots?: PiercedNode[];
};

/**
 * The element Chromium drew a control's value in: the closest one holding every
 * text node in the control's shadow tree, or `undefined` when that tree holds no
 * text and nothing was drawn.
 *
 * Only the shadow tree is walked. A control's light children are not what it
 * paints — a `<select>`'s `<option>` elements have no layout box of their own,
 * and a `<textarea>`'s text child is the source the editing host renders a copy
 * of, so both report nothing and both would pull the answer away from the
 * element that did the drawing.
 *
 * The closest common ancestor rather than the first text node found, because a
 * control that draws its value in parts — a date, in segments with separators
 * between them — has several, and the report descends two levels from wherever
 * it is pointed. One node holding all of them is one report covering all of them.
 *
 * `DOM.describeNode` hands back shadow nodes with a `nodeId` of 0, because the
 * DOM agent has not pushed them and only pushed nodes can be addressed;
 * `DOM.pushNodesByBackendIdsToFrontend` is what turns the backend id it does
 * carry into one the report accepts.
 */
async function editingHost(session: CDPSession, nodeId: number): Promise<number | undefined> {
  const { node } = await session.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
  const trails: PiercedNode[][] = [];
  const descend = (parent: PiercedNode, trail: PiercedNode[]) => {
    for (const child of parent.children ?? []) {
      if (child.nodeType === TEXT_NODE) {
        if (child.nodeValue.trim() !== "") trails.push(trail);
      } else descend(child, [...trail, child]);
    }
  };
  for (const shadow of (node as PiercedNode).shadowRoots ?? []) descend(shadow, []);
  if (trails.length === 0) return undefined;

  const shared = trails.reduce((held, trail) => {
    const parts = held.findIndex((ancestor, depth) => trail[depth] !== ancestor);
    return parts === -1 ? held : held.slice(0, parts);
  });
  const host = shared.at(-1);
  expect(host, "a control drew text no element in its shadow tree holds").toBeDefined();
  const { nodeIds } = await session.send("DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: [host.backendNodeId],
  });
  return nodeIds[0];
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

/**
 * Text laid out in a named stack, off-screen, and the families that shaped it.
 *
 * Positioned away rather than hidden, because `display: none` produces no layout
 * object and therefore no shaping result — the same empty array a node whose text
 * sits too deep returns. `visibility: hidden` and an off-screen position both
 * still shape and still report.
 */
async function probeFonts(page: Page, session: CDPSession, text: string, stack: string) {
  await page.evaluate(
    ([text, stack]) => {
      const probe = document.createElement("span");
      probe.id = "font-probe";
      probe.textContent = text;
      probe.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font-family:${stack}`;
      document.body.append(probe);
    },
    [text, stack],
  );
  await settleFonts(page);
  const shaped = await shapedBy(session, "#font-probe");
  await page.evaluate(() => document.getElementById("font-probe").remove());
  return shaped;
}

/**
 * The floor both faces keep, and the reason the body face keeps it: it renders
 * Preset names, which the listener types, so a glyph set derived from this
 * interface's own strings would show tofu the first time somebody named a Preset
 * something the interface never says.
 */
const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, index) =>
  String.fromCodePoint(0x20 + index),
).join("");

test("the body face carries every printable ASCII character", async ({ page, context }) => {
  await page.goto("/");
  const session = await fontSession(page, context);

  // One entry, not two: a single character missing from the subset would split
  // the run and report the fallback family beside the count it took. Served a
  // subset built with `Q` removed, this reads
  // `Menlo:1 | JetBrains Mono:94`.
  expect(await probeFonts(page, session, PRINTABLE_ASCII, "var(--body-font)")).toEqual([
    { family: "JetBrains Mono", embedded: true, glyphs: 95 },
  ]);
});

/**
 * The display face keeps the same floor, which is a decision rather than a
 * consequence: it draws only fixed interface text today, and cutting it to
 * exactly those strings would save about 1.5 KB and break the first time a
 * heading used a letter the old headings never did.
 */
test("the display face carries every printable ASCII character", async ({ page, context }) => {
  await page.goto("/");
  const session = await fontSession(page, context);

  // Served a subset built with `Q` removed, this reads
  // `Major Mono Display:94 | Courier:1` — the display stack falls back to bare
  // `monospace`, so the family that catches it is not the body stack's.
  expect(await probeFonts(page, session, PRINTABLE_ASCII, "var(--display-font)")).toEqual([
    { family: "Major Mono Display", embedded: true, glyphs: 95 },
  ]);
});

/**
 * The panel a Preset is named in, opened the way the listener opens it.
 *
 * The `aria-disabled` gate is a wait rather than a decoration. `+ Save` is
 * offered only while the Configuration differs from the Preset it came from, and
 * it is marked unavailable rather than `disabled`, so that it keeps its place in
 * the tab order and declines the click in its own handler. Playwright's
 * actionability checks know `disabled` and not `aria-disabled`, so a click that
 * lands before the render flipping the attribute is delivered, swallowed, and
 * leaves the panel shut — and the failure then surfaces a line later, on a name
 * field that was never on screen.
 */
async function openSavePanel(page: Page) {
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  const openSave = page.getByRole("button", { name: "+ Save" });
  await expect(openSave).toHaveAttribute("aria-disabled", "false");
  await openSave.click();
  return page.getByRole("region", { name: "Save preset" });
}

/**
 * A Preset saved the way the listener saves one: named through the panel and
 * read back from the confirmation the interface writes.
 *
 * The submit is matched on the whole of its accessible name and on both of the
 * names it takes: saving under a name already stored replaces that Preset, and
 * the control says `Replace` rather than `Save` from the moment the typed name
 * makes that true.
 *
 * The confirmation is read from `#status` by id rather than by role: the open
 * envelope drawers put two `<output>` elements in the document, and an
 * `<output>` is a status too.
 */
async function savePresetNamed(page: Page, name: string) {
  const savePanel = await openSavePanel(page);
  await savePanel.getByRole("textbox", { name: "Preset name" }).fill(name);
  await savePanel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
  await expect(page.locator("#status")).toHaveText(`${name} preset saved`);
}

/**
 * The control that proves the two assertions above can fail, and the only thing
 * in this file that says the detector detects anything at all. Everything else
 * here asserts that text was drawn in an embedded face, so a `shapedBy` that had
 * quietly started reporting the embedded face unconditionally would leave every
 * one of them passing forever. This is what would catch it.
 *
 * A Cyrillic Preset name falling back is also the intended behaviour rather than
 * a defect: the floor is printable ASCII, and a name outside it is drawn by
 * whatever the reader's platform offers. The Preset is saved through the
 * interface rather than probed with a scratch element, because a name the
 * listener typed is exactly the case the floor exists for.
 */
test("a Preset named outside the subset is seen to fall back", async ({ page, context }) => {
  await page.goto("/");
  // + Save is offered only while the Configuration differs from the Preset it
  // came from, so something has to change before there is anything to save.
  await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
  await savePresetNamed(page, "Привет");

  // Tagged rather than addressed by position: which card the new Preset lands on
  // is not this test's claim.
  await page
    .locator(".preset-card", { hasText: "Привет" })
    .locator("strong")
    .evaluate((element) => element.setAttribute("data-font-probe", "cyrillic"));

  const session = await fontSession(page, context);
  const shaped = await shapedBy(session, '[data-font-probe="cyrillic"]');

  expect(shaped).toHaveLength(1);
  expect(shaped[0].embedded, "a Cyrillic Preset name was reported as embedded").toBe(false);
});

/**
 * The variable axis, read from the running browser off the shipped file with no
 * font parser anywhere. `CSS.fontsUpdated` carries a `FontFace` for each web font
 * as it loads, including the variation axes the file declares, which is what
 * would catch a subset instanced to a single weight: it draws correctly at 400
 * and asks the browser to synthesise every heavier weight the stylesheet uses.
 *
 * The listener is attached before navigation because the event fires when the
 * face arrives, and a session opened afterwards has already missed it. The axis
 * is 400–800 rather than upstream's 100–800 on purpose — widening it costs 6,956
 * bytes for weights nothing asks for — so the `font-weight: 100 800` in
 * `styles.css` overstates this file and always has.
 */
test("the body face keeps the weight axis the stylesheet varies", async ({ page, context }) => {
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const loaded = [];
  session.on("CSS.fontsUpdated", ({ font }) => {
    // The parameter is optional, and the event fires without it for reasons that
    // are not a font arriving.
    if (font) loaded.push(font);
  });

  await page.goto("/");

  // Polled rather than read once: the event travels the session independently of
  // anything the page can be asked to wait for.
  await expect
    .poll(() =>
      loaded
        .find((font) => font.fontFamily === "JetBrains Mono")
        ?.fontVariationAxes?.map(({ tag, minValue, maxValue, defaultValue }) => ({
          tag,
          minValue,
          maxValue,
          defaultValue,
        })),
    )
    .toEqual([{ tag: "wght", minValue: 400, maxValue: 800, defaultValue: 400 }]);
});

type Probe = { index: number; label: string; control: boolean };

/**
 * Every element drawing non-whitespace text, tagged so CDP can reach it by
 * selector and labelled so a failure names something a reader can find in the
 * source.
 *
 * Almost all of them draw a direct text child, and direct text is what makes
 * this exhaustive without an exception list. The element holding the characters
 * is the one queried, so nothing depends on how deep the interface nests — which
 * matters, because the report only descends two element levels and returns an
 * empty array rather than an error when it runs out.
 *
 * A form control is the exception, and it is why `drawn` exists: its value is an
 * IDL attribute rather than a node, so the tree says nothing about text the
 * control is painting. What it paints is the value, or the placeholder standing
 * in for an empty one, and for a `<select>` the label of the option chosen —
 * whose `<option>` has no layout box of its own, so it is not swept in its own
 * right and reports nothing if it is asked. Controls that hold a value and draw
 * no text, the sliders among them, are tagged too: `valueShapedBy` is what says
 * they drew nothing, from their shadow tree rather than from an empty report, so
 * that no type has to be listed here and a control added later is swept by
 * having been added.
 *
 * `checkVisibility()` is the other half of the empty-report trap. A node with no
 * layout object reports nothing, and nothing reads exactly like "no fallback
 * here": `display: none`, which is what the `hidden` attribute on the closed
 * panels resolves to, has no layout object and must be excluded. Off-screen
 * positioning and `visibility: hidden` both still shape and still report, so the
 * visually-hidden text this interface writes for screen readers is swept rather
 * than waved through.
 */
async function tagTextBearingElements(page: Page): Promise<Probe[]> {
  return page.evaluate(() => {
    // `data-field` is what this interface names its controls by, and several
    // carry neither an id nor a class — a failure reading `input "20"` names
    // nothing anybody can search for.
    const name = (element: Element) => {
      if (element.id !== "") return `#${element.id}`;
      const classes = Array.from(element.classList)
        .map((className) => `.${className}`)
        .join("");
      if (classes === "" && element.hasAttribute("data-field")) {
        return `${element.localName}[data-field="${element.getAttribute("data-field")}"]`;
      }
      return `${element.localName}${classes}`;
    };

    const isControl = (element: Element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement;

    const drawn = (element: Element) => {
      if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.label ?? "";
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value === "" ? element.placeholder : element.value;
      }
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("");
    };

    const probes: Probe[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      const text = drawn(element).trim();
      if (text === "" || !element.checkVisibility()) continue;
      const index = probes.length;
      element.setAttribute("data-font-probe", String(index));
      probes.push({
        index,
        label: `${name(element)} ${JSON.stringify(text.slice(0, 40))}`,
        control: isControl(element),
      });
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
  for (const { index, label, control } of probes) {
    const selector = `[data-font-probe="${index}"]`;
    const shaped = control
      ? await valueShapedBy(session, selector, root.nodeId)
      : await shapedBy(session, selector, root.nodeId);
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
 * The two amounts this interface draws that no text node holds, and the reason
 * one of them needs more reaching than the other.
 *
 * An `<input>` has no text child — its `value` is an IDL attribute, not a node —
 * so both fields are shaped and painted while the tree the sweep walks says
 * nothing about them. What draws a value is an editing host inside a user-agent
 * shadow root, and how far down that host sits depends on the type: a
 * `type="text"` field puts it one level below the control, where the report's
 * two-level descent reaches it, and `type="number"` wraps it in the container
 * Chromium hangs the spin buttons off, which puts the text three levels down and
 * one past where the report gives up.
 *
 * The family is what says the tempo was read rather than the label beside it:
 * `#bpm-readout` holds `BPM` too, and both are three characters, but the label
 * is drawn in the body face and the number in the display one.
 */
test("the tempo and envelope amounts are swept, though neither is a text child", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Edit Cycle envelope" }).click();
  await page.locator(".cycle-settings").getByRole("button", { name: "Up" }).click();
  await expect(page.locator(".envelope-tempo output")).toContainText("→");

  const labels = (await tagTextBearingElements(page)).map(({ label }) => label);
  expect(labels).toContain('#bpm-input "120"');
  expect(labels).toContain('input[data-field="envelope-amount"] "20"');

  const session = await fontSession(page, context);
  expect(await valueShapedBy(session, "#bpm-input")).toEqual([
    { family: "Major Mono Display", embedded: true, glyphs: 3 },
  ]);
});

/**
 * The control for the value route, and the counterpart to the Preset name seen
 * falling back on its card: it says the sweep can catch a character outside the
 * subset in a place no text node carries. The name is typed and not yet saved,
 * which is the state the field holds for as long as somebody is typing, and the
 * field is the only thing drawing those characters while it does.
 *
 * The family is left out of the assertion because which face catches a Cyrillic
 * name is the reader's platform's business. That one Polynome does not ship
 * caught it, and that the sweep said so, is the whole claim.
 */
test("a Preset name typed outside the subset is seen to fall back in the field", async ({
  page,
  context,
}) => {
  await page.goto("/");
  // + Save is offered only while the Configuration differs from the Preset it
  // came from, so something has to change before the field can be opened at all.
  await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
  const savePanel = await openSavePanel(page);
  await savePanel.getByRole("textbox", { name: "Preset name" }).fill("Привет");

  const session = await fontSession(page, context);
  const strangers = await textDrawnByAnUnshippedFace(page, session);

  expect(strangers).toHaveLength(1);
  expect(strangers[0]).toContain('#preset-name "Привет"');
});

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
      await savePresetNamed(page, "Two Cycles");
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
