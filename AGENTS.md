# Agent instructions

## Product intent

Keep this application exceptionally small and immediate. It is a metronome first, not a DAW or notation editor.

The core promise is:

> One shared clock, multiple independently repeating rhythms, with a separate level and stereo position for every rhythm.

## Non-negotiable behaviour

- All layers derive timing from one transport origin.
- Never use `setInterval()` or UI animation timing to decide the actual audio timestamp.
- Audio events must be scheduled against `AudioContext.currentTime`.
- Derive every event time from `transport origin + absolute index × interval`; do not accumulate intervals repeatedly.
- Per-layer pan and gain must not affect rhythm timing.
- Preserve keyboard and screen-reader usability.
- Preserve a useful mobile layout.
- Avoid accounts, tracking, and backend services.

## Architecture

- `configuration.ts`: browser-independent editable Configuration, including Sequence transitions, Presets, edit availability, and transport consequences.
- `grid.ts`: a rhythm layer's meter-relative grid — the canonical pattern, repair, and the Grid controls a Display mode lays out over it. It imports `model.ts` and nothing else, so `configuration.ts` and `app.ts` both read it, and it must remain browser- and DOM-independent.
- `model.ts`: pure musical-time and value maths. It must remain browser- and DOM-independent.
- `metronome.ts`: Web Audio nodes, transport, look-ahead scheduler, and the routing from an edit's transport consequence to the narrowest engine method that satisfies it.
- `persistence.ts`: deferred writes and storage-key retirement, both free of any host environment so they can be driven by tests. Retirement discards an old key; it never carries its value into the new one, which is the migration the rule below rules out.
- `share.ts`: browser-native gzip and URL-fragment encoding for a shared Configuration, including the fragment grammar and the bounded decode boundary. [ADR-0021](docs/adr/0021-share-configurations-in-client-only-url-fragments.md) records why links carry the storage shape without identifiers and never reach a backend.
- `app.ts`: DOM interaction, transient interface state, and visual playhead. It owns the storage key names and wires `localStorage` to `persistence.ts`.
- `styles.css`: responsive visual design.
- `server.ts`: the development server. It serves the repository directory, and runs esbuild's `transform` over every `.ts` file on the way out so the browser can load modules straight from source with no bundle step. [ADR-0018](docs/adr/0018-strip-types-in-the-development-server.md) records that decision, including how a file that does not parse is reported and why it must stay distinguishable from one that is not there. The bind is `127.0.0.1` unless `--host=` names something wider, because the directory being served is the working tree and a wider bind hands `.git` and every uncommitted change to whatever is on the network; `npm start -- --host=0.0.0.0` is the explicit opt-in, and it says on startup what it has exposed. [ADR-0023](docs/adr/0023-take-the-development-server-bind-address-from-a-flag.md) records why that address is an argument and not an environment variable: `HOST` is a name other tooling exports, so reading it let a shell set up for something else widen the bind with nobody deciding anything. `PORT` stays in the environment, because a different port is still only this machine. `npm run dev` adds live reload, where a stylesheet swaps in place and everything else reloads the page.
- `test/`: Node built-in tests for pure timing and state behaviour.
- `biome.jsonc`: lint and formatter configuration. `.jsonc` rather than `.json` because strict JSON cannot hold the paragraph explaining the one disabled rule, and a rule turned off without a reason is one nobody can safely turn back on.
- `tsconfig.json`, `types/`: the TypeScript configuration and the ambient declarations for browser APIs its DOM library omits. `tsc` runs with `noEmit` and is a checker only; `erasableSyntaxOnly` refuses `enum`, `namespace` and parameter properties, which are the constructs a stripper cannot erase and a real compiler would be needed for. An import specifier names the file that exists — `./model.ts`, not `./model.js` — because a stripper resolves paths rather than rewriting them, and Node will not map a `.js` specifier onto a `.ts` file.

### Rendering

`#cycles` and `#preset-list` are rendered by Preact through `htm` tagged templates, per ADR-0009. Everything else in `app.ts` still writes to the DOM directly, and three things do so deliberately inside a rendered region: the visual playhead toggles classes on live nodes every animation frame, `layoutSteps` measures what the renderer just produced and writes custom properties back onto it, and a level or balance drag writes its own readout rather than re-rendering the grid under the pointer. None belongs in a component.

The first two are safe because reconciliation restores what they write, or leaves it alone. The third is not, and it is the reason `writeReadout` changes a Text node's data instead of assigning `textContent`: assigning replaces the node, and the node it replaces is one Preact created and still holds, so every later render of that readout is written into a node no longer in the document. Anything that writes text into a rendered region has the same constraint. The e2e suite asserts the identity of the node both readouts keep.

Interface state stays in module scope. Preact is here to reconcile, not to own state, so no component holds any — `openRhythms`, `presetsOpen` and the rest are read as props from the render functions that mount each region.

`render` is Preact's. The application's own whole-interface render is `renderInterface`, and the per-region ones are `renderPanels`, `renderTransport`, `renderPresetPanel`, `renderCycles` and `renderFooter`.

### The Preset origin

`presetOrigin` records which Preset the current Configuration came from and the snapshot it held at that moment. Two things read it: what the save field opens on, and whether there is anything to save at all, which is what makes the `+ Save` chip live. `sameConfiguration` answers the second against the one remembered snapshot rather than against every stored Preset, because it is asked on every render, including every pointer move of a tempo drag.

It is a claim about what storage holds, so it stops being true when storage moves: deleting a Preset — here or in another tab — leaves it naming something no Preset carries any more, and a stale origin reads as nothing to save, which is exactly backwards. Every write to the stored Presets that this tab did not itself make goes through `adoptSavedPresets`, which reconciles the origin, redraws the list and repaints the header together. Saving is the one write that does not, because it knows the origin it just created. Add a fourth route to changing `savedPresets` and it goes through `adoptSavedPresets` too.

Do not reintroduce `innerHTML` in either rendered region. Rebuilding markup destroys focus, which is what made `focusSelector`, `renderPresetSelection` and three `requestAnimationFrame` focus deferrals necessary; the e2e suite asserts those regions are not rebuilt and that focus survives a Preset being deleted from another tab.

`model.ts` holds the shared musical vocabulary (`STEP`, `METER_COUNT_LIMIT`, `METER_UNITS`, `SUBDIVISION_LIMIT`) and the increments its stepped controls move in (`TEMPO_STEP`, `MIX_STEP`). `configuration.ts` imports it rather than restating the literals, so a bound or a name is only ever changed in one place. A step belongs there for the same reason a bound does, and for one more: it decides which values a control can hold at all, so every default is held against it — see [ADR-0014](docs/adr/0014-snap-only-the-balance-and-hold-defaults-to-the-step.md).

Both Meter components are selects. Numerators range from 1 through 16 and denominators are the conventional written units `1`, `2`, `4`, and `8`; `4/4` is the default, at 120 BPM. BPM sets the shared primary-beat rate: a Meter lasts `numerator × 60 / BPM` seconds, regardless of denominator, and Subdivision alone divides each signature unit into Pattern positions.

An edit's consequence names the narrowest engine response that satisfies it. `restart-transport-run` begins a new run; `update-step-voices` and `update-mix` patch a run in progress; `update-configuration` records a change the engine must hold but nothing audible depends on, which is what a denominator edit is; `none` reports an edit that changed nothing.

### Configuration edit failure modes

`changeConfiguration` separates programmer error from user input, and the two are reported differently on purpose:

- **Programmer error throws.** An unknown edit type, or a known type whose payload is structurally malformed (a missing or wrong-typed field), throws a `TypeError`. These cannot come from the interface without a bug, so they must fail loudly rather than be swallowed.
- **Domain-invalid input returns.** A well-formed edit carrying a value the domain rejects — out of range, not in the offered choices, or refused by a Sequence policy — returns `{consequence: "none", reason}`. These are ordinary user input and the reason is what the interface reports.

Every outcome, including both no-ops above, returns a freshly repaired Configuration. The caller's own object never comes back, so a no-op still yields a new value that is equal but not identical — repair runs before dispatch, and nothing downstream depends on identity. Identifiers are re-generated unless they match the shape this module issues, because they are read from storage and written into the interface.

## Dependencies

Every dependency has to earn its place. Two are runtime, and the rest reach no user:

- **Preact** — the renderer, adopted in ADR-0009 on measured grounds and only as a reconciler.
- **htm** — how Preact is written without a development build.
- **Playwright** — browser interaction tests, and nothing else.
- **esbuild** — three jobs. It bundles the module graph for the two browser distribution targets, without hand-written module lists or JavaScript rewriting. It strips TypeScript annotations in `server.ts` so the browser can load modules straight from source, per [ADR-0018](docs/adr/0018-strip-types-in-the-development-server.md). And it is the parser `test/syntax.test.ts` runs over every tracked file, because `node --check` says nothing about a `.ts` one. The three share a version and a failure mode, which is one more reason the pin below is exact.
- **Biome** — lint and formatting. Two packages and one binary, with no plugin ecosystem to accrete. Bare ESLint is sixty-nine packages before the first plugin, which is the comparison that decided this.
- **TypeScript** — the checker, and nothing else. Every source, test, script and spec file is `.ts`, and nothing compiles: `tsc` runs with `noEmit`, Node strips annotations natively to run `test/`, and esbuild strips them for the browser and for both distributions.
- **@types/node** — types only. Without it no file importing a `node:` builtin can be checked at all.
- **@axe-core/playwright** — accessibility assertions against the rendered tree, which is the half `test/accessibility.test.ts` cannot reach from Node.

Fewer is still the default. Prefer browser and Node standard APIs, and do not introduce a framework, plugin ecosystem, development server, or general task runner without a concrete requirement. Preact was added on a measurement, not a preference, and the next one needs an argument of the same kind.

A runtime dependency is pinned to an exact version, because its code is copied into both distributions and a range lets two builds of one commit ship different bytes. esbuild is pinned for the same reason from the other side, deciding those bytes rather than supplying them; the rest float, because nothing they do reaches a user. `test/dependencies.test.ts` holds the runtime half of that rule.

Bare specifiers are resolved in development by the import map in `index.html`, which points at the installed packages and names every specifier the source uses, including the ones a package imports internally. Both distributions strip the map, because esbuild resolves those modules into the bundle and `node_modules/` ships with neither artifact.

Worth knowing before reaching for more analysis: when Biome, TypeScript and axe were first run against this codebase they found, between them, zero defects. Every finding was either correct code the rule did not fit or a type the checker did not know. They are here to catch what arrives next, not because something was wrong — so weigh a new tool by the regressions it would catch, and do not expect a haul.

## Verification

Install development dependencies and the managed browser once with `npm install` and `npx playwright install chromium`.

Then run:

```bash
npm run check
```

`npm test` is the fast loop. `npm run check` is what CI runs, and adds, in order: `npm run lint` (Biome), `npm run types` (TypeScript), the coverage thresholds, the browser tests, and the site build. `npm run format` writes the fixes Biome can apply itself.

The browser tests choose and print a random ephemeral-range port for each run, and do not attach to a server already on it, so concurrent checkouts ordinarily need no coordination. Set `POLYNOME_TEST_PORT=4591` only when a reproducible fixed port is useful. Read the exit code rather than the last lines of output, and do not pipe: the browser reporter is long enough to invite `| tail`, and the status of `a | b` is `b`'s, so a red suite reads as a green one. Redirect to a file and echo `$?`, or set `pipefail` first.

Three ratchets guard against drift, and all are set where the code already stands rather than where it might ideally be. Raise one when the real figure rises; do not lower one to make a change fit.

Coverage is enforced at 95% lines, 87% branches, and 94% functions, measured over the source modules only — `test/` and `e2e/` are excluded because coverage of a test file measures nothing.

TypeScript runs with `noImplicitAny` and `strictNullChecks` off. That is the ratchet, not the destination: together those two account for roughly 610 further errors, almost all of them demanding an annotation on a parameter whose type is obvious one line away. Turning either on is a project rather than a flag. `types/globals.d.ts` declares the two Safari APIs the DOM library omits, both optional on purpose — typed as always present, the guards around them would read as dead code.

`tsconfig.json` covers the source tree, `scripts/`, `test/` and `e2e/`, which between them hold every `.ts` file git tracks, so nothing in the repository is outside the checker. Bringing the last two in reported 170 errors, and this branch fixed them rather than leaving them as a third ratchet: most were the hand-written Web Audio fakes, which assign every property in a constructor and declared no fields, so every property a test read off one was one the checker had never been told about. They carry real types now, written as `declare` so that nothing added for the checker can reach runtime. `e2e/` reaches the application the way a browser does, through the development server, which is why a `page.evaluate` body imports `/model.ts` — a URL resolved against the served root, not a path resolved against the file doing the importing. The checker has no server, so the `paths` mapping in `tsconfig.json` (`"/*": ["./*"]`) tells it what the server already knows; that mapping, and not ordinary module resolution, is what makes such an import resolve, which is worth knowing before writing another one. With that gap closed the ratchet above is the only one left, so the next move is the two flags rather than more of the tree.

Performance is held as counted work, never as elapsed time — see [ADR-0019](docs/adr/0019-assert-performance-as-counted-work.md) and the measurements behind it in [Performance optimisation and regression testing](docs/research/performance-optimisation-and-regression-testing.md). `test/audio-work.test.ts` holds nodes allocated and AudioParam calls issued per second, `test/transport-work.test.ts` holds planned-event counts and the invariants that say which behaviour moved when one changes, `test/artifact-size.test.ts` holds what a browser downloads, and `e2e/performance.spec.ts` holds the per-frame selector cost, the read-before-write ordering `layoutSteps` depends on, and a long-task boolean. Nothing in any of them asserts a duration, and nothing should: a scheduler tick measures under 0.02 ms against a 25 ms interval, which no threshold on a shared runner can resolve. Artifact budgets are taken against `main`, because a figure measured on a branch reads as a regression the moment another merges.

`test/syntax.test.ts` parses every `.ts` file git tracks, through esbuild rather than `node --check`. It replaced a hand-written list of `node --check` calls that named seven files and silently omitted the server, the Playwright configuration and three build scripts; nothing needs adding when a new source file appears, because committing it is what enrols it. The parser changed with the language: `node --check` exits zero on a `.ts` file whatever is inside it, since Node strips annotations without parsing what it strips, so keeping it would have left a check that reports itself as having run and cannot fail. esbuild is the parser both distributions and the development server already go through, so a file that fails here is one `npm run bundle` would have refused anyway. It is a syntax check and nothing more — `npm run types` is what checks the types.

Any change to Configuration transitions, signatures, pulse generation, or step semantics must include or update tests in `test/configuration.test.ts`. Grid controls, the canonical pattern, and pattern repair are tested in `test/grid.test.ts`, which drives the module directly rather than through `createConfiguration` — it sits beneath the module that repairs and has to be testable without it. Timing-maths changes must include or update tests in `test/model.test.ts`. Audio context lifecycle and scheduler behaviour is tested in `test/metronome-audio.test.ts`.

Browser interaction changes must update `e2e/` when the behavior is observable there. Click voicing is asserted against the exported `SOUND_PROFILES` and `CLICK_ENVELOPE` values, so retuning a sound must never require editing frame numbers in `e2e/audio-graph.spec.ts`.

`e2e/accessibility.spec.ts` scans 15 states with axe. Every scan emulates reduced motion, and a new scan must do the same: catching a panel part way through its 140ms `drawer-in` fade makes axe measure half-transparent text and report a serious contrast violation against markup that is correct the moment it settles. The reduced-motion block in `styles.css` changes only timing properties, so what axe measures is what everyone sees, arriving immediately. An animation that fills forwards is the case where that stops holding on its own: clamping its duration settles the element on the final frame at once, so a duration override becomes a visual-state override. The block therefore drops the beat pulse outright rather than clamping it, and that is the only rule in it that is not a duration. Do not substitute a timeout — it is a number that is too short on a loaded runner and wasted everywhere else. A state worth adding a control to is a state worth adding a scan for.

Workflows are linted by actionlint, in CI only, since the binary does not come from npm and a check that silently skips when its tool is missing is worse than one that runs where the tool is guaranteed. To run it locally, install actionlint and run it from the repository root. It covers what `test/workflow.test.ts` cannot — the schema GitHub actually enforces — and runs shellcheck over every `run:` block, so a multi-line one needs `set -euo pipefail` and quoted expansions.

Also manually verify the audio-specific behavior Playwright cannot assess:

1. Presets `4/4 8ths` and `4/4 Triplets` each sound as one 4/4 Beat Mode rhythm at 120 BPM, with Subdivision two and three respectively. Seeding writes them on a first run, so a profile they have been renamed or deleted in needs its preset key cleared before this check has anything to listen to.
2. Headphone separation at hard left and hard right through physical output.
3. Primary, secondary, and tertiary Step voices are perceptually distinguishable at equal gain, and `off` is silent. Check this on a `low` layer, not the default `high`: `low` is the worst case, because its voices land lowest and the ear is least sensitive there.
4. Numerator and Subdivision edits restart cleanly while playing; denominator edits preserve the Transport run.

## Product boundaries

Good next additions:

- tap tempo
- solo controls
- optional sampled clicks
- custom preset saving
- installable PWA metadata

Require explicit product justification before adding:

- musical notation
- MIDI sequencing

### Do not build migrations

Polynome has never been released. There is no stored data anywhere but a
developer's own browser, and that is disposable. When a stored shape changes,
retire it: drop the key, or let repair replace the unrecognised value with a
default. Do not write a migration, a schema version, an upgrade path, or a
compatibility shim, and do not add a test for one.

Migration is a feature, and like any other it is built when it is asked for by
name. "Existing saved patterns are preserved" is not a requirement anyone here
has stated; it is a reflex, and it has cost real time more than once. The tell
is prose in a decision record justifying why some old value must survive — if
nobody can name the release that produced it, delete the code and the paragraph
together.

When the first release happens, this section is what changes, and the migration
policy is decided then with real data in view.
- user accounts
- cloud sync
- effects chains
- recording
- tempo automation

## Decision records

Decisions live in `docs/adr/`, numbered `NNNN-kebab-title.md`.

A number is claimed when the branch merges, not when the file is written. Three branches open at once will each read `0004` as the highest and each write `0005`, which is exactly how this repository ended up with three of them: the number a branch picks is only a proposal, and it is stale the moment another branch merges. Before merging, renumber to one above the highest on `main` and update the references.

Cite a decision as `ADR-NNNN`. Number alone, in prose, is the one form that goes wrong silently when a collision is resolved: it survives the rename and points at whatever now holds the number. Prefer a Markdown link carrying the path when the reference crosses out of `docs/adr/`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
