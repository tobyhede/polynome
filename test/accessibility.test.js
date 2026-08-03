import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Accessible names are easy to write and hard to notice when they never reach
 * assistive technology. These tests read the shipped markup — the static shell
 * and the templates `app.js` renders — rather than any recreation of it.
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
  ".top-panel h2 .panel-divider",
  ".cycle-heading h2 .cycle-divider",
  '.rhythm-identity > span[aria-hidden="true"]',
  ".signature-input > span",
]);

function channelLuminance(component) {
  const channel = component / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance, from a `#rrggbb` string. */
function relativeLuminance(hex) {
  const [red, green, blue] = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .map(channelLuminance);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [foreground, background]
    .map(relativeLuminance)
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Custom properties declared with a plain hex value. */
function colorTokens(css) {
  return new Map(
    Array.from(
      css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi),
      (match) => [match[1], match[2].toLowerCase()],
    ),
  );
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
 * attribute *names* are inspected, which keeps `${...}` interpolation in the
 * `app.js` templates from mattering.
 */
function* startTags(source) {
  const pattern = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    yield { tag: match[1].toLowerCase(), attributes: match[2], line };
  }
}

const hasAttribute = (attributes, name) =>
  new RegExp(`(^|\\s)${name}\\s*=`, "i").test(attributes);

/**
 * `aria-label` is prohibited on elements with an implicit `generic` role, so a
 * bare `<span>` or `<div>` carrying one is silently dropped by screen readers.
 * The name has to come from text content — visually hidden when the design
 * only shows part of it — or the element needs a role that supports naming.
 */
test("no generic element is named with aria-label", async () => {
  const offenders = [];

  for (const file of ["index.html", "app.js"]) {
    const source = await readFile(file, "utf8");
    for (const { tag, attributes, line } of startTags(source)) {
      if (!GENERIC_TAGS.has(tag)) continue;
      if (!hasAttribute(attributes, "aria-label")) continue;
      if (hasAttribute(attributes, "role")) continue;
      offenders.push(`${file}:${line} <${tag}>`);
    }
  }

  assert.deepEqual(offenders, []);
});

/**
 * `app.js` resolves its controls once at module scope and never null-checks
 * them, so an id that the shell stops emitting fails as a TypeError deep in a
 * render rather than at startup. Visually hidden label spans are the easiest
 * to drop by accident, because removing one changes nothing on screen.
 */
test("every element app.js resolves by id exists in the shell", async () => {
  const [app, html] = await Promise.all([
    readFile("app.js", "utf8"),
    readFile("index.html", "utf8"),
  ]);
  const ids = Array.from(
    app.matchAll(/document\.querySelector\("#([A-Za-z][\w-]*)"\)/g),
    (match) => match[1],
  );

  assert.ok(ids.length, "Expected app.js to resolve controls by id");
  const missing = ids.filter((id) => !new RegExp(`\\sid="${id}"`).test(html));
  assert.deepEqual(missing, []);
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
    if (DECORATIVE_RULES.has(selector)) continue;
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
