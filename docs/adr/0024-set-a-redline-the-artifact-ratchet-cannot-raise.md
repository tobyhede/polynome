# Set a redline the artifact ratchet cannot raise

Polynome adds a second, fixed number beside the artifact budgets: a **redline** of 60 KB gzipped on `site/app-local.js`, which is not raised by the change that breaches it. A change that crosses it finds bytes or does not land. The budgets in `test/artifact-size.test.ts` stay exactly what [ADR-0019](0019-assert-performance-as-counted-work.md) made them — a drift record, raised deliberately, re-taken on `main` — because the two numbers do different jobs and only one of them has ever said no.

## Why the ratchet is not a limit

The budget has never denied a change, and was not built to. Its record: 194,762 bytes before Preact, 211,773 after, which [ADR-0009](0009-adopt-preact-as-the-renderer.md) measured and named as a cost worth weighing; then 274,000, 282,000, 285,000, 286,000. Each step was approved by the act of typing a larger number, and every one of them was legitimate.

That is the ratchet working. It makes growth deliberate and it produces the accounting — the current budget carries a comment explaining that 317 of its bytes are three SHA-256 digests and their directives, which is precisely the sentence that would not exist without it. What it cannot do is refuse. A number that yields whenever it is tested records history; it does not constrain the future, and the 47% climb above is what that distinction looks like over a year.

A redline is the other half: a number whose breach is answered by finding bytes rather than by moving the number. It is only worth having if there is somewhere to find them, which is why the reserve below is named as part of the decision rather than left to whoever hits the wall first.

## Why the script, gzipped

The single-file distribution divides like this, measured on the current build:

| | raw | gzip |
| --- | --- | --- |
| `site/app-local.js` | 166,183 | 40,745 |
| two woff2 faces, base64 | 65,259 | ~49,000 |
| `site/styles-local.css` | 29,932 | 5,996 |
| markup, CSP, the rest | ~23,465 | ~5,400 |
| `dist/polynome.html` | 284,839 | 101,149 |

Gzipped, the fonts are about half of what a browser downloads, and they do not move when the source does: woff2 is already compressed, so all gzip recovers is the 33% inflation base64 added on the way in. A limit on the single-file total therefore mostly polices a font decision taken once, and leaves script growth to hide behind it. The script is the only figure that tracks what writing code does.

Compressed bytes are the wrong unit for the drift ratchet and the right one for a redline. ADR-0019 gives the reason for the first — Node's zlib and the system `gzip` disagree by tens of bytes on identical input, and roughly 65 KB of the single-file total compresses to nothing — and the reason for the second is that raw bytes are what a change writes while compressed bytes are what someone waits for. Both budgets keep their raw figures; the redline is stated in gzip, at the level ADR-0019 already names.

## Where 60 KB comes from

The promise is about the whole artifact: the single file should stay under about 100 KB gzipped, which on a 400 Kbps connection is roughly two seconds to have all of Polynome, and is the most concrete reading available of "exceptionally small and immediate."

Today the artifact is at 101,149. It is already at the target, not approaching it, and the room for the script to grow into does not exist yet — it has to be made. Subsetting the fonts is what makes it, which is why that work is a precondition for this number rather than housekeeping beside it.

Sixty is then the script's share of that target: 40,745 today, about 50% headroom, enough for tap tempo, solo controls and custom preset saving, and past it Polynome is carrying more code than one shared clock with independently repeating rhythms justifies. The figure is derived once, here, by hand, from a transfer target. Nothing measures a duration and nothing may: ADR-0019 forbids asserting elapsed time, and the test still asserts bytes.

## The reserve

The two faces are 48,944 bytes of woff2 between them — `jetbrains-mono-latin` at 31,432 and `major-mono-display-latin` at 17,512 — each carrying full Latin. The interface renders digits, a small set of control glyphs, and a display face used for very little. A subset built from the characters actually rendered should be a fraction of that, and because woff2 does not gzip, every byte removed is a byte off the download.

That reserve is spent before anyone argues for moving the redline. A redline with no known way to comply is a wall, and a wall gets demolished by the first feature anybody actually wants.

## What ends the single-file distribution regardless

Two entries on the good-next-additions list in `AGENTS.md` end this artifact by their nature, at whatever size it has reached:

**Optional sampled clicks.** Audio is already compressed. Every byte base64'd into the file is a byte downloaded, and gzip recovers only the base64 inflation, so a sample set with velocity layers or decay tails is hundreds of kilobytes that compress by nothing.

**Installable PWA metadata.** A service worker cannot be inlined. It needs its own URL and its own scope, and wanting install-and-offline rather than save-this-file is wanting a site.

Either one makes the site build primary and leaves `dist/polynome.html` as the variant that deliberately omits what does not fit. Neither is a redline breach; both are the rethink itself, and reaching one is the point at which this decision is superseded rather than enforced.

## Consequences

- `test/artifact-size.test.ts` carries the redline as its own constant, separate from `BUDGETS`, failing with its own message: find the bytes, or change the decision in this file. A budget breach says raise me deliberately; a redline breach says you may not.
- The redline moves only through an amendment here, and never in the same change as the code that breached it. Raising it alongside the feature that needed it raised is the exact motion this decision exists to prevent.
- Nothing about the budgets changes. They stay raw, stay taken against `main`, and stay re-taken there whenever one is raised, per ADR-0019.
- The single-file total keeps a budget and gets no redline, because the number that tracks source growth is the script and the number that tracks the font is a decision, not a drift.
- Font subsetting is the named reserve and is tracked as its own issue. Until it lands, the script's headroom against the redline overstates the artifact's headroom against the transfer target.
- No dependency is added, for the reasons ADR-0019 already gave when it rejected `size-limit` and Lighthouse CI. A gzip length is one call to `node:zlib`.
