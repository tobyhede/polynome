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

/** Custom properties declared with a plain hex value. */
function colorTokens(css) {
  return new Map(
    Array.from(css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi), (match) => [
      match[1],
      match[2].toLowerCase(),
    ]),
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
 * attribute *names* are inspected, which keeps the value an `app.js` template
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
 * The fixture below stands in for a line of `app.js` as the scanner reads it,
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

  for (const file of ["index.html", "app.js"]) {
    const source = await readFile(file, "utf8");
    for (const { tag, line } of genericsNamedByAriaLabel(source)) {
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
