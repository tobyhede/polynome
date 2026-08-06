import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Accessible names are easy to write and hard to notice when they never reach
 * assistive technology. These tests read the shipped markup — the static shell
 * and the templates `app.ts` renders — rather than any recreation of it.
 */

const GENERIC_TAGS = new Set(["span", "div"]);

/** Surfaces any reading text can sit on. The lightest one is the worst case. */
const SURFACE_TOKENS = ["--paper", "--card", "--soft"];

const AA_NORMAL_TEXT = 4.5;

/**
 * Rules that colour an ornamental `/` separator. These carry no information
 * for any user — the layout already separates the parts — so WCAG 1.4.3 treats
 * them as incidental.
 *
 * `aria-hidden` is not the test for belonging here. `.balance-axis` is hidden
 * from assistive technology because the adjacent `<output>` states the value,
 * yet its "L · R" is the only cue a sighted user gets about which way the
 * slider runs, so it has to meet the ratio like any other label.
 */
const DECORATIVE_RULES = new Set([
  ".cycle-heading h2 .cycle-divider",
  ".panel-heading h2 .panel-divider",
  '.rhythm-identity > span[aria-hidden="true"]',
  ".signature-input > span",
]);

/**
 * A grouped rule is exempt only when every selector in the group is. One
 * ornament sharing a declaration with something a sighted user reads makes the
 * whole rule answerable for the ratio, which is the safe way around: grouping
 * can widen what a colour applies to, and the exemption must not follow it
 * there unnoticed.
 */
function decorative(prelude) {
  return prelude.split(",").every((selector) => DECORATIVE_RULES.has(selector.trim()));
}

function channelLuminance(component) {
  const channel = component / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance, from a `#rrggbb` string. */
function relativeLuminance(hex) {
  const [red, green, blue] = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .map(channelLuminance);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [foreground, background].map(relativeLuminance).sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Custom properties resolved to a hex value, following a property declared as
 * `var()` on another through to the literal it ends at.
 *
 * The alias has to be followed rather than skipped, because every check below
 * ignores a token it cannot resolve — so a colour that stopped being a literal
 * would not fail here, it would quietly stop being examined, and the test would
 * report on a stylesheet it had lost sight of. `--accent` is exactly that case:
 * it names a swatch rather than repeating one's hex.
 *
 * A chain is walked to its end for the same reason, and the seen set is what
 * keeps a pair of properties naming each other from walking forever.
 */
function colorTokens(css) {
  const tokens = new Map(
    Array.from(css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi), (match) => [
      match[1],
      match[2].toLowerCase(),
    ]),
  );
  const aliases = new Map(
    Array.from(css.matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)\s*;/g), (match) => [
      match[1],
      match[2],
    ]),
  );

  for (const name of aliases.keys()) {
    const seen = new Set();
    let target = name;
    while (aliases.has(target) && !seen.has(target)) {
      seen.add(target);
      target = aliases.get(target);
    }
    const value = tokens.get(target);
    if (value) tokens.set(name, value);
  }

  return tokens;
}

/**
 * Flat `selector { declarations }` rules. Rules nested inside an at-rule match
 * on their own; the at-rule preludes left over between them do not declare
 * colours, so they contribute nothing.
 */
function* cssRules(css) {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    yield { selector: match[1].trim(), declarations: match[2] };
  }
}

/**
 * Yields every start tag with its raw attribute text. Attribute values are
 * skipped over so a `>` inside one cannot end the tag early, and only
 * attribute *names* are inspected, which keeps the value an `app.ts` template
 * interpolates from mattering.
 *
 * A value is skipped in whichever form it is written: quoted, as `index.html`
 * writes them, or an unquoted `${...}`, as the `htm` templates do. The
 * interpolation is matched to its closing brace through one level of nesting,
 * which is what a template literal holding a placeholder needs. The branches
 * are disjoint on their first character — a lone `$` has its own — so the
 * alternation walks the tag once rather than backtracking through it.
 */
function* startTags(source) {
  const interpolation = String.raw`\$\{(?:[^{}]|\{[^{}]*\})*\}`;
  const attributes = String.raw`(?:[^>"'$]|\$(?!\{)|"[^"]*"|'[^']*'|${interpolation})*`;
  const pattern = new RegExp(`<([a-z][a-z0-9-]*)(${attributes})>`, "gi");
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    yield { tag: match[1].toLowerCase(), attributes: match[2], line };
  }
}

const hasAttribute = (attributes, name) => new RegExp(`(^|\\s)${name}\\s*=`, "i").test(attributes);

/**
 * `aria-label` is prohibited on elements with an implicit `generic` role, so a
 * bare `<span>` or `<div>` carrying one is silently dropped by screen readers.
 * The name has to come from text content — visually hidden when the design
 * only shows part of it — or the element needs a role that supports naming.
 */
function* genericsNamedByAriaLabel(source) {
  for (const { tag, attributes, line } of startTags(source)) {
    if (!GENERIC_TAGS.has(tag)) continue;
    if (!hasAttribute(attributes, "aria-label")) continue;
    if (hasAttribute(attributes, "role")) continue;
    yield { tag, line };
  }
}

/**
 * The rule above is only as good as the tag it is handed, and the templates it
 * reads now write their values as `htm` interpolations rather than quoted
 * strings. An expression that compares its way to a value carries a `>` that no
 * quote encloses, and a scanner that ended the tag there would hand this rule
 * half a tag: every attribute past the comparison disappears, the `aria-label`
 * among them, and the check reports nothing while looking like it ran.
 *
 * The fixture below stands in for a line of `app.ts` as the scanner reads it,
 * so its placeholder has to survive as characters rather than be interpolated.
 */
test("a `>` inside an interpolated attribute value does not end the tag", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the fixture
  const source = '<div hidden=${count > 1} aria-label="Levels"></div>';

  assert.deepEqual(
    Array.from(genericsNamedByAriaLabel(source), ({ tag }) => tag),
    ["div"],
  );
});

test("no generic element is named with aria-label", async () => {
  const offenders = [];

  for (const file of ["index.html", "app.ts"]) {
    const source = await readFile(file, "utf8");
    for (const { tag, line } of genericsNamedByAriaLabel(source)) {
      offenders.push(`${file}:${line} <${tag}>`);
    }
  }

  assert.deepEqual(offenders, []);
});

/**
 * `app.ts` resolves its controls once at module scope and never null-checks
 * them, so an id that the shell stops emitting fails as a TypeError deep in a
 * render rather than at startup. Visually hidden label spans are the easiest
 * to drop by accident, because removing one changes nothing on screen.
 */
test("every element app.ts resolves by id exists in the shell", async () => {
  const [app, html] = await Promise.all([
    readFile("app.ts", "utf8"),
    readFile("index.html", "utf8"),
  ]);
  const ids = Array.from(
    app.matchAll(/document\.querySelector\("#([A-Za-z][\w-]*)"\)/g),
    (match) => match[1],
  );

  assert.ok(ids.length, "Expected app.ts to resolve controls by id");
  const missing = ids.filter((id) => !new RegExp(`\\sid="${id}"`).test(html));
  assert.deepEqual(missing, []);
});

/**
 * A hint sitting next to a field is read by everyone who can see it and by
 * nobody who cannot, unless the field points at it. `aria-describedby` is also
 * silent when it names an element that is not there, so the reference has to
 * resolve rather than merely exist.
 *
 * One has to exist, and it is the save chip's. `aria-disabled` says a control
 * will not act and has no way of saying why; the chip is marked that way for as
 * long as there is nothing to save, and the reason is the described-by it points
 * at. Losing that reference would leave a control announced as unavailable with
 * nothing anywhere saying what would make it available again — which is silent,
 * and looks from the outside exactly like working code.
 */
test("every aria-describedby names an element the shell emits", async () => {
  const html = await readFile("index.html", "utf8");
  const references = Array.from(html.matchAll(/aria-describedby="([^"]+)"/g), (match) =>
    match[1].trim().split(/\s+/),
  ).flat();

  assert.ok(references.length, "Expected the shell to describe a control");
  const missing = references.filter((id) => !new RegExp(`\\sid="${id}"`).test(html));
  assert.deepEqual(missing, []);
});

/**
 * The Accent is the one colour a listener chooses, and `--accent` is read in
 * both directions: as text on the surfaces, and as a background beneath a glyph
 * coloured for the paper. Contrast is symmetric, so the two uses reduce to one
 * demand — every swatch clears AA against the lightest surface — and the set is
 * fixed precisely so that demand can be asserted here. A free colour picker
 * would move the decision somewhere nothing can check it, and this test would
 * go on passing while the running interface was illegible.
 *
 * The default is declared as an alias rather than a second copy of Blue's hex.
 * Two literals holding one colour is the version of this that drifts, and the
 * one that drifts silently: nothing downstream would report a default that had
 * stopped naming a swatch anyone can choose.
 */
test("every Accent swatch meets WCAG AA against every surface", async () => {
  const css = await readFile("styles.css", "utf8");
  const tokens = colorTokens(css);
  const surfaces = SURFACE_TOKENS.map((name) => {
    const value = tokens.get(name);
    assert.ok(value, `Expected a hex value for the surface token ${name}`);
    return { name, value };
  });
  const swatches = Array.from(tokens).filter(([name]) => name.startsWith("--accent-"));

  assert.ok(swatches.length > 1, "Expected the stylesheet to offer a choice of Accent swatches");
  assert.ok(
    swatches.some(([, value]) => value === tokens.get("--accent")),
    "Expected --accent to resolve to one of the swatches",
  );

  const failures = [];
  for (const [name, value] of swatches) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(value, surface.value);
      if (ratio < AA_NORMAL_TEXT) {
        failures.push(`${name} is ${ratio.toFixed(2)}:1 on ${surface.name}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * The panel is the list of Accents on offer — `app.js` reads the names off it
 * rather than holding a second copy — and the stylesheet is where each of those
 * names becomes a colour. Neither half is much use holding a name the other
 * does not.
 *
 * Both directions fail quietly, which is why both are asserted. A swatch with
 * no token renders unpainted, and worse, it escapes the contrast check above
 * entirely: that test examines tokens, so a colour that never became one is a
 * colour it never looked at. A token with no swatch is a colour nobody can
 * choose, passing its contrast check forever on a set it has dropped out of.
 */
test("the Accent swatches and the Accent tokens name the same colours", async () => {
  const [html, css] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("styles.css", "utf8"),
  ]);
  const offered = Array.from(html.matchAll(/data-accent="([\w-]+)"/g), (match) => match[1]);
  const declared = Array.from(colorTokens(css).keys())
    .filter((name) => name.startsWith("--accent-"))
    .map((name) => name.slice("--accent-".length));

  assert.ok(offered.length, "Expected the shell to offer Accent swatches");
  assert.deepEqual(offered.toSorted(), declared.toSorted());
});

/**
 * The panel's heading counts the swatches, the way the Preset panel's counts
 * Presets. That one is written by `app.js` because it changes; this one is
 * markup because the set does not, which makes it the one number here that can
 * be wrong without anything noticing — a thirteenth colour is added by adding a
 * token and a control, and neither of those passes through the heading.
 */
test("the Accent panel's heading counts the swatches it offers", async () => {
  const html = await readFile("index.html", "utf8");
  const offered = Array.from(html.matchAll(/data-accent="([\w-]+)"/g), (match) => match[1]);
  const counted = html.match(/id="accent-count"[^>]*>(\d+)</);

  assert.ok(counted, "Expected the Accent heading to state a count");
  assert.equal(Number(counted[1]), offered.length);
});

/**
 * Each swatch states the ratio it clears against `--card`, because the caption
 * quotes it and a caption that reads its number off a live calculation would be
 * reporting the arithmetic rather than the palette. Recomputing it here is what
 * makes that a checked copy: the marker is informational and never warns, so
 * nothing else in the interface would ever look wrong if it drifted, and the
 * one reader it is for — whoever adds the thirteenth colour — is exactly the
 * person a stale number would mislead.
 *
 * `--card` and not `--soft`, which the AA floor above is measured against: the
 * card is the surface the Accent is actually set as text on, and quoting the
 * worst case of three would print a number nobody can reproduce by looking.
 */
test("each Accent swatch states the contrast it clears on the card", async () => {
  const [html, css] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("styles.css", "utf8"),
  ]);
  const tokens = colorTokens(css);
  const card = tokens.get("--card");
  assert.ok(card, "Expected a hex value for --card");

  const stated = Array.from(
    html.matchAll(/data-accent="([\w-]+)"[^>]*data-contrast="([\d.]+)"/g),
    (match) => ({ name: match[1], claimed: match[2] }),
  );
  const offered = Array.from(html.matchAll(/data-accent="([\w-]+)"/g), (match) => match[1]);

  assert.equal(stated.length, offered.length, "Expected every swatch to state a contrast");

  const failures = [];
  for (const { name, claimed } of stated) {
    const value = tokens.get(`--accent-${name}`);
    assert.ok(value, `Expected a hex value for --accent-${name}`);
    const actual = (Math.round(contrastRatio(value, card) * 10) / 10).toFixed(1);
    if (claimed !== actual) failures.push(`${name} claims ${claimed}:1 and is ${actual}:1`);
  }

  assert.deepEqual(failures, []);
});

/**
 * The palette separates surfaces, text and lines, and the line tokens are dark
 * enough that borders read as hairlines. Tinting text with one looks
 * deliberate and still fails WCAG 1.4.3, so check the ratio rather than the
 * intent. Only `var()` colours are resolvable here; a literal hex is left to
 * the rule that pairs it with its own background.
 */
test("text colours meet WCAG AA against every surface", async () => {
  const css = await readFile("styles.css", "utf8");
  const tokens = colorTokens(css);
  const surfaces = SURFACE_TOKENS.map((name) => {
    const value = tokens.get(name);
    assert.ok(value, `Expected a hex value for the surface token ${name}`);
    return { name, value };
  });

  const failures = [];
  for (const { selector, declarations } of cssRules(css)) {
    if (decorative(selector)) continue;
    const declared = declarations.match(/(^|[;{\s])color\s*:\s*var\((--[\w-]+)\)/);
    const foreground = declared && tokens.get(declared[2]);
    if (!foreground) continue;

    for (const surface of surfaces) {
      const ratio = contrastRatio(foreground, surface.value);
      if (ratio < AA_NORMAL_TEXT) {
        failures.push(
          `${selector} { color: var(${declared[2]}) } is ${ratio.toFixed(2)}:1 on ${surface.name}`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});
