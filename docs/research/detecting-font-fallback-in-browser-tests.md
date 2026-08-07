# Detecting font fallback in a browser test

> **Scope:** how a Playwright/Chromium test can tell that a string was rendered by a specific subsetted `@font-face` rather than falling through to the fallback stack, and which of the candidate mechanisms is fit to be the guard [issue #43](https://github.com/tobyhede/polynome/issues/43) asks for. External claims cite the CSS Font Loading Module Level 3, CSS Fonts Module Level 4, the WHATWG HTML standard, the Chrome DevTools Protocol reference and its machine-readable `browser_protocol.json`, the Playwright API documentation, and Blink source on `chromium.googlesource.com`. Font files are read from their canonical sources: [JetBrains Mono's own GitHub releases](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304) and [`google/fonts`](https://github.com/google/fonts/tree/main/ofl/majormonodisplay) for Major Mono Display, with Google Fonts' `css2` slices used only for comparison against what the repository committed. Everything attributed to this repository was measured against the `issue-43-subset-embedded-fonts` worktree at `b1aa5dd` on an Apple M2 under macOS 25.4, driving the Chromium bundled with Playwright 1.62.1 against the repository's own development server; the method and its limits are recorded at the end, and everything that could not be settled is listed there too.

## Conclusion

**Use CDP `CSS.getPlatformFontsForNode`, reached through `browserContext.newCDPSession(page)`.** It is the only mechanism examined that answers the actual question — *which font did Chromium shape this node's text with* — rather than a proxy for it. It reports one entry per font actually used, with a glyph count, so a node whose text fell back partway shows two entries and says how many glyphs each face contributed. It needs no npm dependency: Playwright already exposes raw CDP, and the suite is already Chromium-only.

**`document.fonts.check()` cannot answer this question and never could.** The specification's own summary of the method is that it *"will determine whether you can 'safely' render some provided text with a particular font list, such that it won't cause a 'font swap' later"* ([§3.3](https://drafts.csswg.org/css-font-loading/#font-face-set-check)) — a statement about load state, not about glyph coverage. The only per-character filtering in the matching algorithm is on the **declared** `unicode-range` descriptor: *"For each font face in matched font faces, if its defined unicode-range does not include the codepoint of at least one character in text, remove it from the list"* ([find the matching font faces](https://drafts.csswg.org/css-font-loading/#find-the-matching-font-faces)). Blink implements exactly that and nothing more. Measured against a JetBrains Mono subset built with `Q` deliberately removed, `document.fonts.check('16px "JetBrains Mono"', "Q")` returned **`true`** while the page rendered that `Q` in Menlo.

**The width-comparison technique fails on this repository's own fallback stack, measured.** `--body-font` is `"JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", monospace`: every entry is monospaced at the same advance, so a fallback moves nothing. Rendering `"Quaver Quintuplet"` at 16px through the Q-less subset measured **163.20298767089844 px**, against **163.2265625 px** for the same string pinned to the fallback stack — a difference of **0.0236 px across seventeen characters, two of which fell back**. For the single character `→`, which neither committed face contains, the web-font stack and the fallback stack measured **9.6328125 px each — bit-identical**. There is no threshold that separates those and does not fire on rounding.

**Two findings about the current tree matter more than any of the mechanisms.** First, the faces already do not cover everything the interface renders: `fonts/jetbrains-mono-latin.woff2` (394 glyphs, 229 cmap entries) and `fonts/major-mono-display-latin.woff2` (280 glyphs, 227 cmap entries) **both lack U+2192 →, U+25A0 ■, U+25B6 ▶ and U+25BC ▼**, all four of which appear in the source. A live sweep of every text-bearing element in the default interface, presets panel open, found exactly one falling back today: `#play-icon`, the `▶`, rendered in Menlo. **A guard written as "nothing anywhere falls back" fails on `main` before this issue changes a byte** — but only until issue #43 lands, because all four are present in the upstream faces that render them and cost roughly 110–170 bytes to carry (§7). Second, both faces do cover all 95 printable ASCII characters, so the floor the issue sets is real and testable — a scratch element carrying all 95 in `--body-font` reported one entry, `JetBrains Mono`, `isCustomFont: true`, `glyphCount: 95`.

**The mechanism has three traps, all measured, all silent.** `getPlatformFontsForNode` descends **two element levels** and no further; it reports nothing for a node with no layout object; and both cases return an **empty `fonts` array**, which reads exactly like "no fallback" to a naive assertion. `.preset-notation`, whose text sits further down than that, returns `[]`. So does anything inside a `hidden` section. The guard must treat an empty array as a failure, not a pass.

---

## 1. `document.fonts.check()` — what it actually answers

### The normative algorithm

`check()` is three steps, and the interesting work is delegated:

> When the `check(font, text)` method is called, execute these steps:
>
> 1. Let font face set be the `FontFaceSet` object this method was called on.
> 2. Find the matching font faces from font face set using the `font` and `text` arguments passed to the function, and including system fonts, and let font face list be the returned list of font faces, and found faces be the returned found faces flag. If a syntax error was returned, throw a SyntaxError exception and terminate these steps.
> 3. If font face list is empty, or all fonts in the font face list either have a `status` attribute of `"loaded"` or are system fonts, return `true`. Otherwise, return `false`.
>
> — [CSS Font Loading 3 §3.3](https://drafts.csswg.org/css-font-loading/#font-face-set-check)

Glyph coverage appears nowhere. The only place `text` is consulted at all is one step of [find the matching font faces](https://drafts.csswg.org/css-font-loading/#find-the-matching-font-faces):

> For each font face in matched font faces, if its **defined unicode-range** does not include the codepoint of at least one character in text, remove it from the list.

"Defined unicode-range" is the descriptor as authored, not the font's character map. The spec makes the distinction explicit twice more. In the same section it flags the consequence as non-obvious:

> If the specified fonts exist, but all possible faces are ruled out due to their unicode-range not covering the provided text, the method returns `true`, as the text will be rendered in the UA's fallback font instead, and won't trigger any font loads.

And CSS Fonts 4, defining the first available font, adds the note that settles the intent of the whole family of APIs: the first available font is *"the first font for which the character U+0020 (space) is not excluded by a `unicode-range`"*, followed by — *"Note: it does not matter whether that font actually has a glyph for the space character"* ([§5.2](https://drafts.csswg.org/css-fonts-4/#first-available-font)).

So the answer to the crux, from the specification alone: **if a face is loaded but lacks the glyph for X, `check("16px 'Family'", "X")` returns `true`.**

### What Chromium implements

`FontFaceSet::check` in [`third_party/blink/renderer/core/css/font_face_set.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/css/font_face_set.cc) walks the codepoints of `text` and, per family, asks `CSSSegmentedFontFace::CheckFont(c)`. That function is four lines and decides everything:

```cpp
bool CSSSegmentedFontFace::CheckFont(UChar32 c) const {
  return !font_faces_->ForEachUntilTrue(
      [&c](const Member<FontFace>& font_face) -> bool {
        return font_face->LoadStatus() != FontFace::kLoaded &&
               font_face->CssFontFace()->Ranges()->Contains(c);
      });
}
```

— [`css_segmented_font_face.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/css/css_segmented_font_face.cc)

It returns `false` only when a face is **not loaded** *and* its ranges contain the character. A loaded face returns `true` whatever its cmap holds, because the cmap is never consulted. `Ranges()` is built by `BuildUnicodeRangeVector` from the parsed `AtRuleDescriptorID::UnicodeRange` value ([`font_face.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/css/font_face.cc)) — the declared descriptor, never the font file. With no `unicode-range` declared the vector is empty, and `UnicodeRangeSet::Contains` short-circuits on `IsEntireRange()`, which is `ranges_.empty()` ([`unicode_range_set.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/fonts/unicode_range_set.cc)).

Blink also carries a deviation from the spec text that is worth knowing before trusting `check()` for anything: the loop skips any family for which `font_selector->IsPlatformFamilyMatchAvailable(...)` is true, so a family name that also names a locally installed font is never examined at all. That is the behaviour Brave's fingerprinting work identified. **I could not find a Chromium bug that states either behaviour in prose; the source above is the primary record, and it is unambiguous.**

### Measured

Against a subset of `jetbrains-mono-latin.woff2` built with `pyftsubset --unicodes="U+0020-0050,U+0052-007E"` — printable ASCII with `Q` (U+0051) removed — served under the repository's own `@font-face` declaration:

| Call | Result | What the page actually did |
|---|---|---|
| `document.fonts.check('16px "JetBrains Mono"')` | `true` | — |
| `document.fonts.check('16px "JetBrains Mono"', "P")` | `true` | shaped in JetBrains Mono |
| `document.fonts.check('16px "JetBrains Mono"', "Q")` | **`true`** | **shaped in Menlo** |
| `document.fonts.check('16px "JetBrains Mono"', "→")` | `true` | shaped in Menlo (unsubsetted face) |
| `document.fonts.check('16px "JetBrains Mono"', "П")` | `true` | shaped in Menlo (unsubsetted face) |

`document.fonts.status` was `"loaded"` and the sole `FontFace` reported `unicodeRange: "U+0-10FFFF"` throughout. **`check()` is a load-state probe wearing a glyph-coverage costume, and it would pass a subset that dropped every character the interface renders.**

---

## 2. CDP `CSS.getPlatformFontsForNode`

### Shape and stability

From [`json/browser_protocol.json`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json), which is the machine-readable source the reference site is generated from:

```json
{"name": "getPlatformFontsForNode",
 "description": "Requests information about platform fonts which we used to render child TextNodes in the given node.",
 "parameters": [{"name": "nodeId", "$ref": "DOM.NodeId"}],
 "returns": [{"name": "fonts", "description": "Usage statistics for every employed platform font.",
              "type": "array", "items": {"$ref": "PlatformFontUsage"}}]}
```

`PlatformFontUsage` is *"Information about amount of glyphs that were rendered with given font"* with four properties, **none of them optional**: `familyName` (*"Font's family name reported by platform"*), `postScriptName` (*"Font's PostScript name reported by platform"*), `isCustomFont` (*"Indicates if the font was downloaded or resolved locally"*) and `glyphCount` (*"Amount of glyphs that were rendered with this font"*) ([CDP reference, CSS domain](https://chromedevtools.github.io/devtools-protocol/tot/CSS/#method-getPlatformFontsForNode)).

**Stability.** The `CSS` domain carries `"experimental": true` at the domain level, and declares `"dependencies": ["DOM", "Page"]`. The command itself is not separately marked experimental, but that is immaterial: the domain is. Corroborating that, `https://chromedevtools.github.io/devtools-protocol/1-3/CSS` **404s** — the CSS domain does not appear in the pinned 1.3 protocol at all, only under `tot`. So the shape above is tip-of-tree and versioned with Chromium, not with a stable protocol revision. In practice Playwright pins the Chromium it downloads, so a test written against it moves when Playwright moves; that is the versioning risk and it is the same risk the suite already runs on every other browser-behaviour assertion.

### What "platform font" means here

It means the font Blink's shaper actually used, read back off the shaping result. `InspectorCSSAgent::getPlatformFontsForNode` walks the node's layout subtree, and for each text layout object walks its `InlineCursor`, calls `ShapeResultView::GetRunFontData` and accumulates per-run glyph counts ([`inspector_css_agent.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/inspector/inspector_css_agent.cc)). `GetRunFontData` is a plain loop over `runs_` pushing `{run->font_data_, run->glyph_data_.size()}` ([`shape_result.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/fonts/shaping/shape_result.cc)) — no debug guard, so it is available in release builds.

A run boundary is exactly where the shaper changed font, which is exactly where fallback happened. So **yes, it reports actual per-node fallback, and yes, it shows two entries when some glyphs in a node fell back.** Measured on a `<p>A → B</p>` under the unsubsetted committed face:

```
[{"familyName":"Menlo","postScriptName":"Menlo-Regular","isCustomFont":false,"glyphCount":1},
 {"familyName":"JetBrains Mono","postScriptName":"JetBrainsMono-Regular","isCustomFont":true,"glyphCount":4}]
```

One glyph in Menlo — the arrow — and four in the web font.

### What it cannot see: tofu

`getPlatformFontsForNode` detects **fallback**, not **tofu**, and the two are different events. When no font in the family list and no system font covers a codepoint, `FontFallbackIterator` does not give up: it reaches `kFirstCandidateForNotdefGlyph` and returns `first_candidate_`, with the comment *"Save first candidate to be returned if all other fonts fail, and we need it to render the .notdef glyph"* ([`font_fallback_iterator.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/fonts/font_fallback_iterator.cc)). The `.notdef` box is drawn *by the web font itself*, so the run's font data is the web font and CDP reports it as a normal, successful use.

Measured: a node containing U+E000/U+E001 (Private Use Area) and one containing U+2FE0/U+2FE1 (unassigned) both reported `JetBrains Mono, isCustomFont: true` with a glyph count equal to the character count, while displaying boxes. CSS Fonts 4 sanctions part of this — for a PUA codepoint, *"user agents must display some form of missing glyph symbol for that character rather than attempting installed font fallback"* ([§5.4](https://drafts.csswg.org/css-fonts-4/#char-handling-issues)) — and permits the rest: *"If a particular character cannot be displayed using any font, the user agent should indicate by some means that a character is not being displayed, displaying either a symbolic representation of the missing glyph (e.g. using a Last Resort Font) or using the missing character glyph from a default font"* ([§5.2](https://drafts.csswg.org/css-fonts-4/#font-style-matching)).

For issue #43 this is a limitation without teeth. The failure mode being guarded against is a printable-ASCII character dropped from a subset, and the fallback stack — `ui-monospace, "SFMono-Regular", "Menlo", monospace` for the body face, `monospace` for the display face — covers ASCII on every platform that runs the suite. **Tofu is unreachable for the characters this issue puts at risk. I found no CDP command, and no web API, that reports glyph IDs or a `.notdef` count; if one is needed later, pixel comparison (§6) is the only route.**

### Reaching it from Playwright

`await browserContext.newCDPSession(page)` returns a `CDPSession`, and the documentation states flatly that *"CDP sessions are only supported on Chromium-based browsers"*; the argument *"is named `page`, but it can be a `Page` or `Frame` type"* ([BrowserContext](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)). `CDPSession.send()` takes a *"Protocol method name"* and optional parameters and resolves with the response object; `detach()` *"Detaches the CDPSession from the target"* ([CDPSession](https://playwright.dev/docs/api/class-cdpsession)). `playwright.config.ts` declares one project, `chromium`, so the Chromium-only restriction costs nothing here.

The call order is not optional and the failure is explicit. `InspectorCSSAgent::enable` begins:

```cpp
if (!dom_agent_->Enabled()) {
  prp_callback->sendFailure(protocol::Response::ServerError(
      "DOM agent needs to be enabled first."));
  return;
}
```

Measured, `CSS.enable` without a prior `DOM.enable` rejects with exactly `Protocol error (CSS.enable): DOM agent needs to be enabled first.` A `nodeId` then has to be minted: `getPlatformFontsForNode` resolves it through `InspectorDOMAgent::AssertNode`, which only knows nodes the DOM agent has already pushed, and `DOM.getDocument` is what pushes them — *"Returns the root DOM node (and optionally the subtree) to the caller. Implicitly enables the DOM domain events for the current target"* ([DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getDocument)). `DOM.querySelector` then *"Executes `querySelector` on a given node"* and returns a `nodeId`. So:

```
DOM.enable → CSS.enable → DOM.getDocument → DOM.querySelector → CSS.getPlatformFontsForNode
```

`DOM.requestNode` (objectId → nodeId) would be the alternative for reaching a node Playwright already holds, but Playwright does not expose a handle's `objectId` as public API, so `DOM.querySelector` is the supported route. Re-calling `DOM.getDocument` before each query is safe and is what keeps the helper correct across a Preact re-render; measured across repeated calls in one session with no error.

### The three traps

All three were measured, all three are silent, and all three produce an empty `fonts` array.

**Depth.** `CollectPlatformFontsForLayoutObject` is called with `descendants_depth = 2` and the comment *"Iterate upto two layers deep"*; each non-anonymous, non-text layout object decrements it, and at zero the walk returns. Measured on `#d0 > #d1 > #d2 > #d3 > span#d4 > "Quaver"`:

| Node queried | Result |
|---|---|
| `body`, `#d0`, `#d1`, `#d2` | `[]` |
| `#d3` | two entries — Menlo 1, JetBrains Mono 5 |
| `#d4` | two entries — Menlo 1, JetBrains Mono 5 |

In the real interface this bites immediately: `.preset-notation` returns `[]`, because its text lives inside `.preset-cycle > .preset-rhythm > span`.

**Layout.** A node with no layout object reports nothing. Every `.panel-heading h2` in the four `hidden` sections of `index.html` returned `[]`; a probe span with `display: none` returned `[]`; a probe span with `visibility: hidden` reported normally, so off-screen positioning and `visibility` are both safe and `display: none` is not.

**`postScriptName` is not stable across weights.** The body face is variable, and Chromium names the instance: the same family reported `JetBrainsMono-Regular` at 400, `JetBrainsMonoRoman-Bold` at 600–700 and `JetBrainsMonoRoman-ExtraBold` on `.preset-button strong`. **Assert on `familyName` and `isCustomFont`; never on `postScriptName`.** Note also that the returned array is built by iterating a `HashMap`, so its order is not specified — search it, do not index it.

---

## 3. The width-comparison technique

Render the string in the face under test, render a control pinned to the fallback stack, compare advance widths. It is the technique issue #43 names as "the usual approach", and on this repository it does not work.

**It is defeated by metric compatibility, and every entry in this repository's stacks is metric-compatible for the purpose.** `--body-font` is `"JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", monospace` and `--display-font` is `"Major Mono Display", monospace`. Every one of those is monospaced, and at a given `font-size` a monospaced face's advance is one number. Measured at 16px:

| String | Web-font stack | Fallback stack | Difference |
|---|---:|---:|---:|
| `→` (in neither face) | 9.6328125 | 9.6328125 | **0.0000** |
| `A` | 9.599990844726562 | 9.6015625 | 0.0016 |
| `A → B` | 48.03277587890625 | 48.0390625 | 0.0063 |
| `Polynome 4/4` | 115.19989013671875 | 115.21875 | 0.0189 |
| `Quaver Quintuplet`, Q-less subset | 163.20298767089844 | 163.2265625 | 0.0236 |

The last row is the case the guard exists for: two of seventeen characters fell back to a different family, and the string got **0.0236 px wider**. The `→` row is worse than useless — a character neither committed face contains measures bit-identically either way, so a width test on the play icon would report "no fallback" about a fallback that is happening right now on `main`.

**Per-glyph fallback inside one string frequently changes the measured width by nothing at all.** That is the general answer to the question, and the table is the local proof.

**`font-display: swap` timing is a second, independent problem, and `document.fonts.ready` mostly solves it.** Both faces declare `swap`, which *"Gives the font face an extremely small block period (100ms or less is recommended in most cases) and an infinite swap period"*, and during the swap period *"if the font face is not loaded, any element attempting to use it must instead render with a fallback font face"* ([CSS Fonts 4 §4.9](https://drafts.csswg.org/css-fonts-4/#font-display-desc), [§3.2](https://drafts.csswg.org/css-fonts-4/#font-display-timeline)). A measurement taken inside that window measures the fallback. The `ready` promise is the specified gate and its definition is stronger than the name suggests:

> Note that the user agent may need to iterate over multiple font loads before the ready promise is fulfilled. This can occur with font fallback situations, where one font in the fontlist is loaded but doesn't contain a particular glyph and other fonts in the fontlist need to be loaded. **The ready promise is only fulfilled after layout operations complete and no additional font loads are necessary.**
>
> — [CSS Font Loading 3 §3.4](https://drafts.csswg.org/css-font-loading/#font-face-set-ready)

Blink honours that: `FontFaceSetDocument::DidLayout` is what schedules resolution, and `FireDoneEventIfPossible` calls `document->UpdateStyleAndLayout(...)` before firing, with the comment *"An invalidation may have occurred in the interim, so update style and layout synchronously here"* ([`font_face_set_document.cc`](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/css/font_face_set_document.cc)). It also declines to fire before `LoadEventFinished()`.

So `document.fonts.ready` is sufficient to guarantee the swap has happened *for the text that existed when it resolved* — measured, an `h1` under a 1.5 s-delayed font response reported `Courier` before `ready` and `Major Mono Display` after. It is not sufficient in general, and the spec says so plainly: *"a given ready promise is only fulfilled once, but further fonts may be loaded after it fulfills"* ([§3.4](https://drafts.csswg.org/css-font-loading/#font-face-set-ready)). Text appended after it resolves needs its own settle — the repository's existing `settleLayout` double-`requestAnimationFrame`, or a forced `getBoundingClientRect()`.

None of this rescues the technique. Even with perfect timing the signal is 0.02 px.

---

## 4. Canvas `measureText` with an explicit `font` string

**What it measures.** `measureText(text)` runs *"the text preparation algorithm"* and returns metrics of the resulting inline box; `width` is *"The width of that inline box, in CSS pixels. (The text's advance width.)"* ([HTML §4.12.5.1](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-measuretext)). The text preparation algorithm's central step is the one that matters here:

> Form a hypothetical infinitely-wide CSS line box containing a single inline box containing the text *text*, with the CSS content language set to *language*, and with its CSS properties set as follows: … `'font'` ← *font* … and with all other properties set to their initial values.
>
> — [text preparation algorithm](https://html.spec.whatwg.org/multipage/canvas.html#text-preparation-algorithm)

**So it participates in exactly the same fallback machinery as layout.** It is a CSS inline box; CSS Fonts 4's matching algorithm applies to it unchanged, including *"If no matching face exists or the matched face does not contain a glyph for the character to be rendered, the next family name is selected and the previous three steps repeated"* ([§5.2](https://drafts.csswg.org/css-fonts-4/#font-style-matching)).

**How the font is resolved.** The `font` attribute *"must be parsed as a CSS `<'font'>` value"*, and — decisively for a test — *"Font family names must be interpreted in the context of the font style source object when the font is to be used; any fonts embedded using `@font-face` or loaded using `FontFace` objects that are visible to the font style source object must therefore be available once they are loaded"*, with the corollary *"If a font is used before it is fully loaded, or if the font style source object does not have that font in scope at the time the font is to be used, then it must be treated as if it was an unknown font, falling back to another as described by the relevant CSS specifications"* ([HTML, the `font` attribute](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-font)). The font style source object of a `CanvasRenderingContext2D` *"is the `canvas` element given by the value of the context's `canvas` attribute"*, and font resolution for it is defined as: *"If object's font style source object is a `canvas` element, return the element's node document"* ([text styles](https://html.spec.whatwg.org/multipage/canvas.html#text-styles)). A detached `<canvas>` from `document.createElement("canvas")` still has the document as its node document, so the page's `@font-face` rules are in scope — which is why the existing test works without attaching anything.

**What this repository already does with it.** [`e2e/polynome.spec.ts`](../../e2e/polynome.spec.ts), in *"the BPM label closes on the number as the tempo enlarges it"*, reads `getComputedStyle(input)`, builds `context.font = \`${fontPx}px ${style.fontFamily}\`` and takes `fontBoundingBoxAscent`/`actualBoundingBoxAscent` to find where the ink of the number actually starts. Its comment already carries half of §3's argument:

> `measureText` answers against whatever face is loaded when it runs, and the display font is a web font served with `font-display: swap`. A reading taken before it arrives is of the fallback, whose ascent is about 3px shorter at this size — enough to measure the two tempos against two different faces, and to move a gap this small either way.

It awaits `document.fonts.ready` for exactly that reason. **That test is correct and should not be touched.**

**What can and cannot be distinguished with it.** It distinguishes *no web font at all* from *web font present*, when the two differ in a metric — the 3 px ascent difference that test relies on is a real signal, because Major Mono Display and the `monospace` fallback are not metric-compatible vertically. It does not distinguish *this face covered every character* from *this face covered most of them*, for the arithmetic reason in §3: the numbers it returns are the ones in that table. It is the width technique with a cleaner API, and it inherits the width technique's blindness.

One narrower use is real and worth naming: because the vertical metrics of the display face and its fallback *do* differ, `fontBoundingBoxAscent` is a serviceable check that the display face loaded **at all** — which is the regression a broken `src` or a corrupt subset would cause. It is a load check, not a coverage check, and the existing test already provides it as a side effect.

---

## 5. `unicode-range`

Issue #43 forbids changing the `@font-face` declarations, so this is background. The honest answer is that it would have helped a little and not nearly enough.

**It would not make missing glyphs detectable.** The descriptor is a hint about which codepoints a face *may* cover, and the spec is explicit that it is not a claim about the file:

> The associated font might not contain glyphs for the entire set of codepoints defined by the `unicode-range` descriptor. When the font is used, the **effective character map** is the intersection of the codepoints defined by `unicode-range` with the font's character map. This allows authors to define supported ranges in terms of broad ranges without worrying about the precise codepoint ranges supported by the underlying font.
>
> — [CSS Fonts 4 §4.5](https://drafts.csswg.org/css-fonts-4/#unicode-range-desc)

So a subset that dropped `Q` while declaring `U+0-7F` would still fall back for `Q`, silently, exactly as it does now. The matching algorithm confirms the ordering — *"If the font resource has not been loaded and the range of characters defined by the `unicode-range` descriptor value includes the character in question, load the font. After downloading, if the effective character map supports the character in question, select that font"* ([§5.2](https://drafts.csswg.org/css-fonts-4/#font-style-matching)).

**It would not fix `check()` either.** Declaring the range makes `check()` return `false` for an unloaded in-range character and `true` for an out-of-range one — *"if the specified fonts exist, but all possible faces are ruled out due to their unicode-range not covering the provided text, the method returns `true`"* ([§3.3](https://drafts.csswg.org/css-font-loading/#font-face-set-check)). Both branches return `true` once the face has loaded, which is the only state a test cares about.

**What it *would* have bought** is a declared, machine-readable statement of intent that a test could hold the font file to, and a second signal: `document.fonts.load(font, text)` resolves with the matched face list, filtered by declared range, so an out-of-range character would resolve to an empty array. With no `unicode-range` the list is never empty and that signal does not exist. It would also have made the fallback *deliberate* rather than incidental — a Cyrillic preset name would fall back because the declaration says so, not because the subsetter happened to drop it.

**Stated plainly: `unicode-range` would have been a better *declaration*, and not a better *guard*.** It documents the contract; it cannot verify that the file honours it. The guard in §7 verifies the file, and it works whether or not the descriptor is ever added. If the descriptor is added later — and there is a real argument for it, since a face is downloaded for characters it cannot render today — the guard needs no change.

---

## 6. What else could settle it

| Mechanism | What it gives | Verdict |
|---|---|---|
| **`CSS.getPlatformFontsForNode`** | The fonts actually used to shape a node, with per-font glyph counts | **Adopt.** §2. |
| `CSS.fontsUpdated` event | *"Fires whenever a web font is updated. A non-empty font parameter indicates a successfully loaded web font"* ([CDP](https://chromedevtools.github.io/devtools-protocol/tot/CSS/#event-fontsUpdated)), carrying a `FontFace` with `platformFontFamily` and `fontVariationAxes` | **Useful adjunct, not a guard.** It reports the face's declared descriptors and available variation axes — which is a direct way to check that the `wght` axis survived the subset, the thing issue #43 warns about. It says nothing about coverage. |
| `CSS.getComputedStyleForNode` / `getComputedStyle` | The *specified* `font-family` list | **No.** Neither CSS nor CDP exposes the *used* font through computed style; the list comes back as authored regardless of what shaped. |
| `CSS.setLocalFontsEnabled` | *"Enables/disables rendering of local CSS fonts (enabled by default)"* — experimental | **No.** It governs `local()` sources, not fallback. |
| `Page.captureScreenshot` / `expect(page).toHaveScreenshot()` | Pixels | **Reject as the guard; keep as the only route to tofu.** It is the one mechanism that would catch `.notdef` (§2), because a box looks like a box. But Playwright's own documentation says *"Browser rendering can vary based on the host OS, version, settings, hardware, power source (battery vs. power adapter), headless mode, and other factors"* and *"Screenshots differ between browsers and platforms due to different rendering, fonts and more"* ([visual comparisons](https://playwright.dev/docs/test-snapshots)). Committing font-rendering baselines to a repository whose CI runs Linux and whose developers run macOS is committing a flake, and [ADR-0019](../adr/0019-assert-performance-as-counted-work.md) already rejected assertions of that shape. |
| A Playwright-native affordance | — | **There is none.** Playwright has no API for the used font of an element; `newCDPSession` is the escape hatch it provides for exactly this. |
| `document.fonts.load(font, text)` | The matched face list, filtered by declared `unicode-range` | **Not applicable.** Requires `unicode-range` (§5). |
| Reading the woff2 cmap in `node --test` | Exact glyph coverage of the committed file | **Reject, narrowly.** It is the most direct possible answer and needs no browser — but parsing woff2 means Brotli plus the WOFF2 glyph-table transform, which is a font parser in the test suite, or a dependency `AGENTS.md` would not admit. The browser already has the parser. |

---

## 7. Recommendation for this repository

### The guard

One helper and three assertions, in a new `e2e/fonts.spec.ts`. The helper is the whole idea; the assertions are cheap once it exists.

```ts
import { expect, test } from "@playwright/test";

/**
 * The families Chromium actually shaped a node's text with, straight off the
 * shaping result. `document.fonts.check()` cannot answer this — it reports load
 * state and the declared `unicode-range`, never what the file's character map
 * holds — and a width comparison cannot either, because every face in both of
 * this repository's stacks is monospaced at the same advance, so a fallback
 * moves the measurement by hundredths of a pixel. See
 * `docs/research/detecting-font-fallback-in-browser-tests.md`.
 *
 * `DOM.enable` must precede `CSS.enable`, which fails outright without it, and
 * a `nodeId` only exists once `DOM.getDocument` has pushed the tree — so the
 * document is re-fetched per call, which is also what keeps this correct across
 * a Preact re-render.
 */
async function shapedBy(session, selector) {
  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
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
  // JetBrainsMonoRoman-ExtraBold depending on the weight asked for. The array
  // is built from a hash map, so its order is not specified either.
  return fonts.map((font) => ({
    family: font.familyName,
    embedded: font.isCustomFont,
    glyphs: font.glyphCount,
  }));
}

async function fontSession(page, context) {
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await page.evaluate(() => document.fonts.ready);
  return session;
}

/**
 * Text laid out in a named stack, off-screen. `visibility: hidden` still shapes
 * and still reports; `display: none` produces no layout object and reports an
 * empty array, so the probe is positioned away rather than hidden.
 */
async function probeFonts(page, session, text, stack) {
  await page.evaluate(
    ([text, stack]) => {
      const probe = document.createElement("span");
      probe.id = "font-probe";
      probe.textContent = text;
      probe.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font-family:${stack}`;
      document.body.append(probe);
      probe.getBoundingClientRect();
    },
    [text, stack],
  );
  // `document.fonts.ready` fulfils once and never again, so text appended after
  // it resolved needs its own settle before the shaping result exists.
  await page.evaluate(
    () => new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle))),
  );
  const shaped = await shapedBy(session, "#font-probe");
  await page.evaluate(() => document.getElementById("font-probe").remove());
  return shaped;
}

const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCodePoint(0x20 + i)).join("");

test("the body face carries every printable ASCII character", async ({ page, context }) => {
  const session = await fontSession(page, context);
  expect(await probeFonts(page, session, PRINTABLE_ASCII, "var(--body-font)")).toEqual([
    { family: "JetBrains Mono", embedded: true, glyphs: 95 },
  ]);
});

test("the display face carries every printable ASCII character", async ({ page, context }) => {
  const session = await fontSession(page, context);
  expect(await probeFonts(page, session, PRINTABLE_ASCII, "var(--display-font)")).toEqual([
    { family: "Major Mono Display", embedded: true, glyphs: 95 },
  ]);
});

/**
 * The control that proves the two tests above can fail. A Cyrillic preset name
 * falling back to the platform's monospace face is the intended outcome — the
 * floor is printable ASCII, and issue #43 says so — but it is also the only
 * evidence in this file that the detector detects anything. If `shapedBy` ever
 * started reporting the embedded face unconditionally, this is what would catch
 * it, and the tests above would go on passing silently.
 */
test("a name outside the subset falls back, and is seen to", async ({ page, context }) => {
  const session = await fontSession(page, context);
  const shaped = await probeFonts(page, session, "Привет", "var(--body-font)");
  expect(shaped).toHaveLength(1);
  expect(shaped[0].embedded, "a Cyrillic name was reported as embedded").toBe(false);
});
```

**This file was run.** Written verbatim into `e2e/` at `b1aa5dd` and executed with `npx playwright test`, all three pass — 475 ms, 256 ms and 281 ms — with the two probes reporting `JetBrains Mono` / `Major Mono Display`, `isCustomFont: true`, `glyphCount: 95`, and the Cyrillic probe reporting `Menlo`, `isCustomFont: false`, `glyphCount: 6`.

**It was also mutation-tested.** With a fourth test routing `**/jetbrains-mono-latin.woff2` to the `Q`-less subset through `page.route`, so the real application loads a real broken subset, the first assertion fails and the report reads:

```
[{"family":"Menlo","embedded":false,"glyphs":1},
 {"family":"JetBrains Mono","embedded":true,"glyphs":94}]
```

One missing glyph out of ninety-five, named, counted, and attributed to the face that rendered it. That is the whole argument for this mechanism over the other five in one line of output.

### A fourth assertion, and the reason it needs an exception list

A sweep — every element in the interface with a direct text child, asserted to shape entirely in an embedded face — is the assertion that would catch a subset dropping a character the interface renders in some state nobody thought to probe. It is worth having, and it **cannot be written as an unconditional rule**, because it fails on `main` today.

The full sweep, run against the default interface with the presets panel open, found exactly one offender:

```
[data-probe="64"]  ["Menlo"]  "▶"
```

That is `#play-icon`. Neither committed face contains U+25B6, and reading the cmaps directly confirms both are missing four codepoints the source uses:

| Codepoint | Character | In `jetbrains-mono-latin.woff2` | In `major-mono-display-latin.woff2` | Where it is used |
|---|---|---|---|---|
| U+2192 | → | no | no | `.preset-sequence-arrow`, help text, `configuration.ts` |
| U+25A0 | ■ | no | no | stop icon |
| U+25B6 | ▶ | no | no | `#play-icon` |
| U+25BC | ▼ | no | no | disclosure marker |

Every other non-ASCII character the source uses — `±` `·` `×` `ı` `–` `—` `…` `↑` `↓` `−` — is present in both. So the sweep needs an exception list, and it should be written as a list of *codepoints* with the elements named beside them, so that a subset which removed, say, `—` fails rather than being waved through by an element-shaped exception.

**The exception list should be empty by the time issue #43 lands, because all four are fixable inside it.** Subsetting only removes, so this turns on what the upstream faces carry and which stack renders each character. Both were checked.

| Codepoint | Rendered in | Upstream JetBrains Mono v2.304 | Upstream Major Mono Display v2.000 | Fixable in #43 |
|---|---|---|---|---|
| U+2192 → | **both** — `--body-font` in the help text and `.preset-sequence-arrow`, `--display-font` in `.envelope-tempo output` | present | **present** | yes, both faces |
| U+25A0 ■ | `--body-font` only (`#play-icon` while playing) | present | absent | yes |
| U+25B6 ▶ | `--body-font` only (`#play-icon`) | present | absent | yes |
| U+25BC ▼ | `--body-font` only (`.notation-select`) | present | absent | yes |

The one that could have gone wrong is `→`, because it is the only one of the four that reaches the display face — measured, `.envelope-tempo output` computes to `"Major Mono Display", monospace` and CDP reports `Major Mono Display*:8 | Menlo:1` for the string `120 → 140`. Major Mono Display carries U+2192 upstream, so that is covered too. The other three are body-face only, and JetBrains Mono carries all of them.

**The byte cost is noise.** Subsetting the upstream faces to printable ASCII and then to printable ASCII plus the four:

| Face | ASCII only | ASCII + the four | Cost |
|---|---:|---:|---:|
| JetBrains Mono v2.304, `wght` limited to 400–800 | 23,320 | 23,480 | **+160** |
| JetBrains Mono v2.304, full `wght` 100–800 | 30,276 | 30,372 | **+96** |
| Major Mono Display v2.000 (gains `→` only) | 4,688 | 4,700 | **+12** |

Roughly **110–170 bytes across both faces**, against a subsetting target measured in tens of kilobytes. Nothing about the reserve [ADR-0024](../adr/0024-set-a-redline-the-artifact-ratchet-cannot-raise.md) depends on is threatened by including them.

**The characters should stay characters rather than become SVG marks, and the reason is accessibility rather than bytes.** The repository does have the pattern — `NoteIcon` and `EnvelopeGlyph` are Preact SVG components, both `aria-hidden="true" focusable="false"` and coloured `currentColor` — and `▶`, `■` and `▼` are all `aria-hidden="true"` decorations inside buttons that carry their own `aria-label` (`"Play metronome"` / `"Stop metronome"`, and `"${label} subdivision"`), so converting those three would have no effect on what is announced. `→` is different in both of its sites: in the help text it is prose inside a read paragraph, and in `.envelope-tempo output` it is inside an `<output>` element that is not hidden and is announced as part of the reading. An SVG there would have to reintroduce a text equivalent for something that already is text. **`→` must stay a character; the other three could be SVG, but issue #43 says "Do not change the visual design", and swapping a font glyph for a hand-drawn one is exactly that.** Cover all four in the subsets, and treat SVG play/stop marks as a separate design question if anyone wants the shapes pinned rather than inherited.

### Where it goes, and what it costs

`e2e/fonts.spec.ts`, a new file, in the spirit of `test/dependencies.test.ts` holding one rule. No `package.json` change: `@playwright/test` already provides `newCDPSession`, and `playwright.config.ts` already declares Chromium as its only project. The glyph counts are exact integers, not durations, which is what [ADR-0019](../adr/0019-assert-performance-as-counted-work.md) asks of anything that gates CI — they are properties of the committed font files and cannot vary with the runner.

The one thing that can move them is Chromium. `CSS` is an experimental CDP domain with no 1.3 page, so a Playwright upgrade could in principle change the report's shape. The failure would be loud — an empty array or a missing property, not a wrong number — and the `not.toHaveLength(0)` assertion is what makes it loud.

### Why each alternative is worse, in one line each

- **`document.fonts.check()`** — answers about load state and declared `unicode-range`; returned `true` for a character the loaded face demonstrably lacked.
- **Width comparison** — 0.0236 px of signal across a seventeen-character string with two fallen-back characters, and exactly zero for a single fallen-back glyph.
- **Canvas `measureText`** — the same arithmetic as width comparison, through a cleaner API; good for "did the face load at all", which the existing BPM-label test already gets for free.
- **`unicode-range`** — a better declaration and not a guard; the effective character map is the intersection with the file, so the descriptor cannot verify the file.
- **Screenshot comparison** — the only route to tofu, and a per-platform baseline this repository would have to maintain against a documented list of things that change rendering.
- **Parsing the woff2 in `node --test`** — the most direct answer, and a font parser or a dependency.

---

## Method, and what it does not cover

Every figure attributed to this repository was taken against the `issue-43-subset-embedded-fonts` worktree at `b1aa5dd` on an Apple M2 under macOS 25.4, with throwaway scripts outside the repository. Browser figures were taken by driving the Playwright-bundled Chromium through the `playwright` library against two servers: a minimal static server in a scratch directory, for the probes that needed a modified `@font-face`, and the repository's own `node server.ts` for the interface sweep. The spec file in §7 was additionally run as a spec, under `npx playwright test` against `playwright.config.ts` as committed, from a checkout of the same commit that had `node_modules` installed; the file and its `test-results/` were deleted afterwards and both trees are unmodified. Font-file figures — glyph counts, cmap membership, `fvar` axes — were read with `fontTools` through `uvx --from "fonttools[woff]"`, which touches nothing in the tree; the `Q`-less subset used in §1 and §3 was produced with `pyftsubset --unicodes="U+0020-0050,U+0052-007E" --flavor=woff2` and lives only in the scratch directory. Nothing in the repository was modified.

### The variable axis, settled

The committed `jetbrains-mono-latin.woff2` declares an `fvar` `wght` axis of **400–800**, while the `@font-face` rule in `styles.css` declares `font-weight: 100 800`. That narrowing is an artefact of how the file was fetched, not of the upstream face:

- Upstream **JetBrains Mono v2.304** (`fonts/variable/JetBrainsMono[wght].ttf` from the project's own GitHub release, the latest as of this writing) has `wght` **100–800**, default 400.
- Google Fonts' current `latin` slice requested as `wght@100..800` also has **100–800** (40,480 bytes); requested as `wght@400..800` it has **400–800** (31,340 bytes) with identical coverage — 394 glyphs, 229 cmap entries, `Version 2.211` — which is the committed file to within 92 bytes. **The committed file is Google's `wght@400..800` latin slice.**

So re-subsetting from upstream *could* widen the axis back to what the CSS already claims. **It should not.** Measured, the widening costs **6,956 bytes** (23,320 against 30,276 for the same printable-ASCII subset), and nothing needs it: the only weights `styles.css` asks for are 400, 600, 620, 640, 700, 760 and 800, every one of them inside 400–800. The `100` in the descriptor is the descriptor's own lower bound and nothing else — a request below the axis minimum clamps, so it has never done anything. Issue #43 forbids changing the `@font-face` declarations, which is the right outcome here by accident: leave the descriptor, keep the axis at 400–800, and record that the descriptor overstates it.

One further byte finding fell out of the comparison and is not otherwise recorded. The committed `major-mono-display-latin.woff2` carries TrueType hinting — `fpgm` 3,605 bytes, `prep` 178, `cvt ` 74 — and a `glyf` of 28,514, where Google's current `latin` slice of the same `Version 2.000` has no hinting tables and a `glyf` of 13,447, for 10,168 bytes against 17,512. **About 7 KB of the display face is hinting and stale glyph data before a single glyph is removed**, and `pyftsubset --no-hinting` recovers it.

Finally, `CSS.fontsUpdated` carries `fontVariationAxes` with each axis's `tag`, `minValue`, `maxValue` and `defaultValue`, which is the direct way to assert the axis survived a subset — from the running browser, against the shipped file, with no font parser.

What this does not cover, stated so it is not mistaken for covered:

- **Only Chromium was driven**, which is the whole suite's scope, but it means every behavioural claim here is Blink's. Firefox and WebKit have no equivalent of `getPlatformFontsForNode` reachable from a test, and the recommendation would not survive a second browser project.
- **No Chromium bug was found that settles the `check()` question in prose.** The Blink source quoted in §1 is unambiguous and the specification agrees with it, but the search for a crbug or a WPT test that states it outright came up empty, and the reader should weigh the source and spec rather than an absent bug.
- **The `postScriptName` instancing observation is descriptive, not sourced.** Chromium reports `JetBrainsMonoRoman-ExtraBold` for a 700 weight of a 400–800 variable face; I did not find documentation of how that name is derived, and it should not be asserted on.
- **The tofu path was verified with PUA and unassigned codepoints only.** CSS Fonts 4 gives PUA its own rule, so the PUA observation is partly explained by the spec rather than by `FontFallbackIterator`; the unassigned-codepoint case is the one that supports the general claim, and it is one measurement on one platform.
- **The interface sweep covers the default state with the presets panel open**, plus a second pass with the envelope drawer and a rhythm's settings open and the transport running. That second pass is where `■`, `▼` and the display-face `→` were caught, each measured falling back to Menlo. The share flow, the Sequence editor and a multi-cycle preset's `.preset-sequence-arrow` were **not** reached; the arrow's stack is read off the cascade — nothing in the five `var(--display-font)` rules matches it, and its sibling `.preset-rhythm` measured as the body face — rather than measured directly.
- **No measurement was taken on a GitHub Actions runner.** Nothing recommended here is timing-dependent, so this should not matter, but the CDP round-trip cost per assertion was not measured on a loaded machine.
- **`Page.captureScreenshot` was not tried.** The argument against it is Playwright's own documentation plus ADR-0019, not an experiment.
