# Choose the Accent from a fixed set, stored outside the Configuration

The interface's highlight colour is a listener's to choose. It is chosen from
twelve swatches declared in [`styles.css`](../../styles.css) as
`--accent-signal` through `--accent-violet`, offered by a static row of controls
in [`index.html`](../../index.html), and remembered under `polynome-accent-v1` —
a third key [`app.js`](../../app.js) owns beside the Configuration's and the
Presets'. Choosing one writes `--accent` onto the root element as a reference to
that swatch's token, so every `var(--accent)` in the stylesheet follows from a
single assignment.

That assignment is made twice, and the first is in the shell's `<head>`.
`app.js` is a module, so it runs after the document is parsed: an Accent applied
only there paints the whole interface Signal blue first and repaints it a frame
later, which is the one moment a chosen colour is visibly not in force. A small
inline script makes the same assignment before first paint. It cannot check the
name — the swatches are not parsed yet — so it bounds the shape and hands the
repair to CSS, writing `var(--accent-NAME, var(--accent-signal))` so that an
unrecognised token falls through to the default rather than resolving to nothing
and taking the highlight out of the interface entirely. `loadAccent` then checks
the name against the swatches properly and arrives at the same place by its own
route.

`--accent-glow` is not set in the head. A swatch's group is markup that has not
been parsed at that point, and the module settles it on the same tick it
confirms the name; a glow arriving a frame late is not the flash this prevents.

Only `--accent` moves. Surfaces, ink and lines are untouched, the interface
stays dark, and `<meta name="theme-color">` keeps the paper colour. This is not
a theme system and the vocabulary in [`CONTEXT.md`](../../CONTEXT.md) rules the
word out: a theme promises coordinated change across surfaces and text, and the
first thing anyone would ask a theme for is a light mode, which none of the
`color-mix(in oklab, var(--accent), var(--card) …)` expressions in the sliders
and step grids would survive.

## The set is fixed

`--accent` is read in both directions. Four rules colour text with it, and six
paint it as a background beneath a glyph hardcoded to the paper colour. Contrast
is symmetric, so the two uses reduce to one demand: every swatch must clear
4.5:1 against `--soft`, the lightest surface. A dark or deeply saturated colour —
a navy, a burgundy, a forest green — fails that in both directions at once, and
what it takes down is the tick labels and the selected Preset card together.
That is why there are no deep or dusty hues in the set; Cherry is the tightest
at 5.1:1 on the card.

A colour input would move that decision to a place nothing can check.
`test/accessibility.test.js` reads the stylesheet and holds every `--accent-*`
token to the ratio; with a free picker it would go on passing while the running
interface was illegible, which is worse than not checking at all. That test is
the reason the set is a set, and a thirteenth swatch is added by adding a token
and a control and letting it run.

The set was first drawn by holding OKLCH lightness 0.72 and chroma 0.12 and
rotating hue only, which is where this palette already sat — the original accent
is exactly OKLCH(0.72 0.12 264). That is now how the six house swatches were
found rather than a rule the set obeys: Butter, Laser and Acid are all lighter
and Acid is far more saturated than the formula allows, and cutting them to
preserve it would have been withholding four usable colours to keep a
description of six. Signal is still the untouched original, so an install that
never opens the panel is unchanged.

## Grouping, and the glow

Each swatch names a group — `house`, `trend` or `neon` — in the markup beside
its name. It draws no headings and no sections; it is the order the row is in,
and it carries the one property of an Accent that is not colour.

An Accent in the `neon` group turns the interface's existing glows up and lights
two that are dark otherwise. `app.js` writes `--accent-glow` beside `--accent`
as `1` or `0`, and every glow in the stylesheet is a single declaration whose
strength is a `calc()` multiplying by it — `calc(40% + var(--accent-glow) *
28%)` and so on — rather than a second copy of the shadow under a selector. The
glows are static, so `prefers-reduced-motion` has nothing to do about them, and
nothing here animates.

This is deliberately not a second setting. A glow toggle would be a preference
about a preference, and the first question it raises — what a glow means on a
colour chosen for not glowing — has no answer worth a control.

## It is not part of the Configuration

This is the mirror of [ADR-0011](0011-store-the-display-mode-in-the-configuration.md).
Display mode is in the Configuration because it is a property of a rhythm layer
and tells two Configurations apart. The Accent tells you nothing about the
music, so the same reasoning puts it outside: a Preset holding a colour would
make two identical setups read as different ones, recalling a Preset would
repaint the interface, and `sameConfiguration` would light the `+ Save` chip
because the interface thought the music had moved.

## Consequences

- Three storage keys rather than two, and the Accent's is named in two places:
  once in `app.js` and once in the shell's head script, which cannot import it.
  `e2e/polynome.spec.js` loads the page with `app.js` blocked and reads the
  colour off the header, so a key that drifted leaves the shell painting the
  default and the check fails.
- A stored name naming no swatch is repaired to the default on read, as every
  other stored value here is; nothing is written back, so the repair simply
  happens again on the next load. It is now repaired twice by two mechanisms —
  the head script's `var()` fallback and `loadAccent`'s membership check — which
  is one more than strictly needed, and the cost of applying a colour before the
  list of colours exists.
- The Accent does not follow a Preset, a shared setup, or a second tab. Two open
  tabs disagree until one reloads, which is cosmetic and self-correcting —
  unlike the Preset origin, which is a live claim about storage and has a
  `storage` listener for that reason.
- Amber, Blush, Cherry and Magenta all sit within reach of `--danger`. On those,
  the armed delete stops being the only warm thing on screen and leans on its
  glyph and its position instead. The alternative was a cool-only set, which
  withholds a third of the hues to protect one button.
- The swatch row is static markup and `app.js` reads the names, the groups and
  the stated contrast off it, so the shell is the one list of what is on offer.
  `test/accessibility.test.js` holds the stylesheet to the same set in both
  directions: a swatch with no token would render unpainted and escape the
  contrast check, and a token with no swatch would be a colour nobody can pick.
  It also recomputes each swatch's stated ratio and the heading's count, which
  are the two numbers in the shell that nothing on screen would look wrong
  without.
- The panel shows the chosen colour's name, hex and ratio under the row. The
  ratio is quoted against `--card` rather than the `--soft` the floor above is
  measured on, because the card is the surface the Accent is read as text on and
  the worst of three is a number nobody can reproduce by looking. The marker
  never warns — every colour in the set passes — which is the point of it: it is
  a standing check for whoever adds the thirteenth.
- The panel takes the room from Help, Presets and Save, following the rule Help
  follows. It has no close control and no Escape handler, unlike Save, whose
  Escape exists to abandon a half-typed Preset name.
