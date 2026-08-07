# Set a redline the artifact ratchet cannot raise

Polynome adds a second, fixed number beside the artifact budgets: a **redline** of 60 KB gzipped on `site/app-local.js`, which is not raised by the change that breaches it. A change that crosses it finds bytes or does not land. The budgets in `test/artifact-size.test.ts` stay exactly what [ADR-0019](0019-assert-performance-as-counted-work.md) made them — a drift record, raised deliberately, re-taken on `main` — because the two numbers do different jobs and only one of them has ever said no.

## Why the ratchet is not a limit

The budget has never denied a change, and was not built to. Its record: 194,762 bytes before Preact, 211,773 after, which [ADR-0009](0009-adopt-preact-as-the-renderer.md) measured and named as a cost worth weighing; then 274,000, 282,000, 285,000, 286,000. Each step was approved by the act of typing a larger number, and every one of them was legitimate.

That is the ratchet working. It makes growth deliberate and it produces the accounting — the current budget carries a comment explaining that 317 of its bytes are three SHA-256 digests and their directives, which is precisely the sentence that would not exist without it. What it cannot do is refuse. A number that yields whenever it is tested records history; it does not constrain the future, and the 47% climb above is what that distinction looks like over a year.

A redline is the other half: a number whose breach is answered by finding bytes rather than by moving the number. It is only worth having if there is somewhere to find them, which is why the reserve below is named as part of the decision rather than left to whoever hits the wall first.

## Why the script, gzipped

Where the bytes are, measured on the current build — the single file's total, and the parts it inlines:

| | raw | gzip |
| --- | --- | --- |
| `site/app-local.js` | 166,183 | 40,745 |
| two woff2 faces, base64 | 65,259 | ~49,000 |
| `site/styles-local.css` | 29,932 | 5,996 |
| markup, CSP, the rest | ~23,465 | ~5,400 |
| `dist/polynome.html` | 284,839 | 101,149 |

Gzipped, the fonts are about half of it, and they do not move when the source does: woff2 is already compressed, so all gzip recovers is the 33% inflation base64 added on the way in. A limit on the total therefore mostly polices a font decision taken once, and leaves script growth to hide behind it. The script is the only figure that tracks what writing code does.

Which artifact a limit is *about* matters as much as which figure it names. `dist/polynome.html` is opened over `file://` with no server and no network — [ADR-0009](0009-adopt-preact-as-the-renderer.md) rejected CDN-hosted modules on exactly that ground, and [ADR-0022](0022-compute-the-content-security-policy-at-build-time.md) calls it a file with nothing in front of it — so nobody waits for it on a connection. Its bytes cost parse, compile and memory; they do not cost time on a wire, and an argument about transfer would be an argument about a situation that does not arise. The site distribution is the one somebody downloads, and there the same content arrives as separate requests: `site/app-local.js`, `site/styles-local.css`, the markup, and the two faces as files rather than as base64.

Compressed bytes are the wrong unit for the drift ratchet and the right one for a redline. ADR-0019 gives the reason for the first — Node's zlib and the system `gzip` disagree by tens of bytes on identical input, and roughly 65 KB of the single-file total compresses to nothing — and the reason for the second is that raw bytes are what a change writes while compressed bytes are what someone waits for. Both budgets keep their raw figures; the redline is stated in gzip, at the level ADR-0019 already names.

## Where 60 KB comes from

The target is a first visit to the site distribution, which is the only thing anybody waits for: under about 100 KB across every request that visit makes, which on a 400 Kbps connection is roughly two seconds to have all of Polynome, and is the most concrete reading available of "exceptionally small and immediate."

A first visit is at that line already: 40,745 for the script, 5,996 for the stylesheet, 48,944 for the two faces, plus the markup — about 98 KB. So the room the script is allowed to grow into does not exist yet; it has to be made, and subsetting the faces is what makes it. That is why the subset is a precondition for this number rather than housekeeping beside it, and the arithmetic is the whole argument: a subset recovering 30 KB puts a first visit near 68 KB, a script grown to the redline puts it near 87 KB, and without the subset the same script puts it near 117 KB. The faces are cached after that first visit and the script is not, so what the subset buys is the first impression specifically — which is the visit the promise is about.

Sixty is then the script's share of that target: 40,745 today, about 50% headroom, enough for tap tempo, solo controls and custom preset saving, and past it Polynome is carrying more code than one shared clock with independently repeating rhythms justifies. The figure is derived once, here, by hand, from a transfer target. Nothing measures a duration and nothing may: ADR-0019 forbids asserting elapsed time, and the test still asserts bytes.

## The reserve

The two faces are 48,944 bytes of woff2 between them — `jetbrains-mono-latin` at 31,432 and `major-mono-display-latin` at 17,512 — each carrying full Latin. The interface renders digits, a small set of control glyphs, and a display face used for very little. A subset built from the characters actually rendered should be a fraction of that, and because woff2 does not gzip, every byte removed is a byte off the wire. On the site those faces are two requests of a first visit; in the single file they are 65,259 base64 bytes of something never transferred at all. The subset improves both figures, and only one of them is what the target is about.

The body face is the harder half, and not for size reasons: it renders Preset names, which the user types. A glyph set derived from the interface's own strings would show tofu the moment somebody names a preset in their own language, so that face keeps a deliberate floor while the display face — which renders nothing but fixed interface text — can be cut to exactly what it draws.

That reserve is spent before anyone argues for moving the redline. A redline with no known way to comply is a wall, and a wall gets demolished by the first feature anybody actually wants.

## What ends the single-file distribution regardless

Two entries on the good-next-additions list in `AGENTS.md` end this artifact by their nature, at whatever size it has reached:

**Optional sampled clicks.** Audio is already compressed, so gzip recovers only the base64 inflation and nothing beneath it. A sample set with velocity layers or decay tails is hundreds of kilobytes that shrink by nothing: on the site a first visit no subset can rescue, and in the single file every sample carried whether or not it is ever sounded.

**Installable PWA metadata.** A service worker cannot be inlined. It needs its own URL and its own scope, so it is a thing the site distribution can have and the single file cannot, at any size.

Neither is a redline breach; both are the rethink itself. What they end is the property that the two distributions carry the same application — the point at which what `dist/polynome.html` contains becomes a decision somebody makes rather than everything there is. Reaching either supersedes this record rather than testing it.

## Consequences

- `test/artifact-size.test.ts` carries the redline as its own constant, separate from `BUDGETS`, failing with its own message: find the bytes, or change the decision in this file. A budget breach says raise me deliberately; a redline breach says you may not.
- The redline moves only through an amendment here, and never in the same change as the code that breached it. Raising it alongside the feature that needed it raised is the exact motion this decision exists to prevent.
- Nothing about the budgets changes. They stay raw, stay taken against `main`, and stay re-taken there whenever one is raised, per ADR-0019.
- The single-file total keeps a budget and gets no redline. The number that tracks source growth is the script, the number that tracks the font is a decision rather than a drift, and the artifact itself is never transferred, so a transfer limit on it would be a limit on nothing.
- Font subsetting is the named reserve and is tracked as its own issue. Until it lands, the script's headroom against the redline overstates a first visit's headroom against the target — the redline is reachable on paper and not in the artifact.
- No dependency is added, for the reasons ADR-0019 already gave when it rejected `size-limit` and Lighthouse CI. A gzip length is one call to `node:zlib`.
