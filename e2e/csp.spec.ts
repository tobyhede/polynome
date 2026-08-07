import { expect, type Page, test } from "@playwright/test";

import { buildDistribution } from "../scripts/build.ts";

type ViolationScratchWindow = Window & { cspViolations?: string[] };

/**
 * The Content-Security-Policy both distributions carry, checked where it is
 * enforced. Everything else about it can be asserted from Node — the directives,
 * the digests, the absence of `'unsafe-inline'` — and none of that can tell a
 * hash that matches from one that does not. That distinction is only visible to
 * a browser, and its failure mode is the reason this file exists: a script the
 * policy refuses does not throw, does not 404, and does not stop the parser. The
 * page still lays out, because the markup is static, so the artifact looks very
 * nearly right while the application is not running at all.
 *
 * Two things are asserted together, and neither is sufficient alone. Zero
 * `securitypolicyviolation` events says the policy admitted everything the page
 * asked for; the interface booting and wearing the stored Accent says the page
 * asked for the right things. A policy of `default-src *` would pass the first
 * and a document with no policy at all would pass the second.
 *
 * `page.addInitScript` is how the listener gets in ahead of the document's own
 * scripts, and it is worth saying why that is sound: it is injected through the
 * debugging protocol rather than parsed out of the markup, so the policy under
 * test does not govern it — measured, not assumed, since a listener the policy
 * blocked would report zero violations for the happiest of wrong reasons.
 */
const RECORD_VIOLATIONS = () => {
  const violations: string[] = [];
  (window as ViolationScratchWindow).cspViolations = violations;
  document.addEventListener(
    "securitypolicyviolation",
    (event) => {
      violations.push(
        `${event.effectiveDirective} refused ${event.blockedURI}${event.sample ? `: ${event.sample}` : ""}`,
      );
    },
    true,
  );
};

/**
 * Read back rather than asserted on directly, because an absent array and an
 * empty one have to stay distinguishable: `undefined` means the init script did
 * not run, which is a broken test rather than a clean page.
 */
const violationsOn = (page: Page) =>
  page.evaluate(() => (window as ViolationScratchWindow).cspViolations);

/**
 * The Accent, in force. `paintedColour` reads the glyph and the swatch through
 * two different custom properties — `--accent` and `--accent-acid` — so the two
 * agreeing is the head script having named the right token rather than this file
 * naming a hex twice, which is the pairing `e2e/polynome.spec.ts` makes for the
 * same check against source.
 */
const paintedColour = (locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor);

async function expectBootedWithAccent(page: Page) {
  await expect(page.getByRole("button", { name: "Play metronome" })).toBeVisible();
  await expect(page.getByRole("group", { name: "4/4 beat voices" })).toBeVisible();

  const glyph = await paintedColour(page.locator("#accent-toggle .accent-glyph"));
  expect(glyph).toBe(await paintedColour(page.locator('[data-accent="acid"]')));
  expect(glyph).not.toBe(await paintedColour(page.locator('[data-accent="signal"]')));
}

const bundle = new URL("../dist/polynome.html", import.meta.url).href;

/**
 * `file://` is the case the single-file artifact's policy is shaped by, and it
 * is the one no `'self'` survives: an opaque origin matches no origin
 * expression, including its own. Loading it from disk here is what proves the
 * hash-only policy admits all three inline elements — the stylesheet, the
 * bootstrap, and the bundled application — rather than merely looking as though
 * it would.
 */
test("the single-file artifact runs from the filesystem with nothing refused", async ({ page }) => {
  await page.addInitScript(RECORD_VIOLATIONS);
  await page.goto(bundle);
  await page.evaluate(() => localStorage.setItem("polynome-accent-v1", "acid"));
  await page.reload();

  await expectBootedWithAccent(page);
  expect(await violationsOn(page)).toEqual([]);
});

/**
 * The site artifact is built here rather than taken as found: `npm run
 * test:browser` runs `npm run bundle` and not `npm run site`, so `site/` is
 * whatever a previous command happened to leave, and a policy checked against a
 * stale document is not checked at all. The development server serves the
 * repository directory, so what the build writes is reachable at the path it
 * wrote to — over `http://`, which is the origin `'self'` needs and the one the
 * deployed site has.
 */
test.describe("the site artifact", () => {
  test.beforeAll(async () => {
    await buildDistribution({
      target: "site",
      version: "csp",
      projectRoot: new URL("..", import.meta.url),
    });
  });

  test("loads over http with nothing refused", async ({ page }) => {
    await page.addInitScript(RECORD_VIOLATIONS);
    await page.goto("/site/index.html");
    await page.evaluate(() => localStorage.setItem("polynome-accent-v1", "acid"));
    await page.reload();

    await expectBootedWithAccent(page);
    expect(await violationsOn(page)).toEqual([]);
  });

  /**
   * The module is a separate request here, which is the one thing the
   * single-file artifact cannot offer: blocking it leaves the static shell and
   * whatever ran inside it, so a glyph already wearing Acid is the hashed
   * bootstrap having executed and nothing else. That is the assertion the digest
   * exists for, isolated — everywhere else the module would repaint the same
   * colour a frame later and hide a bootstrap the policy had refused.
   */
  test("admits the hashed bootstrap that paints the Accent before the module runs", async ({
    page,
  }) => {
    await page.addInitScript(RECORD_VIOLATIONS);
    await page.goto("/site/index.html");
    await page.evaluate(() => localStorage.setItem("polynome-accent-v1", "acid"));
    await page.route("**/app-csp.js", (route) => route.abort());
    await page.reload();

    const glyph = await paintedColour(page.locator("#accent-toggle .accent-glyph"));
    expect(glyph).toBe(await paintedColour(page.locator('[data-accent="acid"]')));
    expect(await violationsOn(page)).toEqual([]);
  });

  /**
   * `form-action 'none'` is the directive with a live element behind it: the
   * save panel is a real `<form>` with a submit button, and the handler's
   * `preventDefault` is the only reason no navigation is attempted. Exercising
   * it — a name that saves, then an empty one that fails validation — is what
   * says the directive costs the interface nothing, rather than that nobody
   * pressed the button.
   */
  test("submits the one form without the policy refusing a navigation", async ({ page }) => {
    await page.addInitScript(RECORD_VIOLATIONS);
    await page.goto("/site/index.html");

    // Nudging the tempo is what makes + Save live, which is the same edit
    // `e2e/polynome.spec.ts` reaches for and for the same reason: it is the
    // cheapest change that disturbs nothing else.
    const bpm = page.getByRole("spinbutton", { name: "Starting tempo in beats per minute" });
    await bpm.fill(String(Number(await bpm.inputValue()) + 1));
    await bpm.blur();
    await page.getByRole("button", { name: "+ Save" }).click();
    const panel = page.getByRole("region", { name: /^Save preset/ });
    await panel.getByRole("textbox", { name: "Preset name" }).fill("Policy");
    await panel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();
    await expect(page.locator("#status")).toHaveText("Policy preset saved");

    // And the refused submit, which is the path that ends in `reportValidity`
    // rather than in a write. Neither navigates, and that is what the directive
    // is being held against.
    await bpm.fill(String(Number(await bpm.inputValue()) + 1));
    await bpm.blur();
    await page.getByRole("button", { name: "+ Save" }).click();
    await panel.getByRole("textbox", { name: "Preset name" }).fill("");
    await panel.getByRole("button", { name: /^(?:Save|Replace)$/ }).click();

    expect(await violationsOn(page)).toEqual([]);
  });
});
