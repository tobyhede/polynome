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

- `configuration.js`: browser-independent editable Configuration, including Sequence transitions, Presets, edit availability, and transport consequences.
- `model.js`: pure musical-time and value maths. It must remain browser- and DOM-independent.
- `metronome.js`: Web Audio nodes, transport, look-ahead scheduler, and the routing from an edit's transport consequence to the narrowest engine method that satisfies it.
- `persistence.js`: deferred writes and storage-key retirement, both free of any host environment so they can be driven by tests. Retirement discards an old key; it never carries its value into the new one, which is the migration the rule below rules out.
- `app.js`: DOM interaction, transient interface state, and visual playhead. It owns the storage key names and wires `localStorage` to `persistence.js`.
- `styles.css`: responsive visual design.
- `test/`: Node built-in tests for pure timing and state behaviour.
- `biome.jsonc`: lint and formatter configuration. `.jsonc` rather than `.json` because strict JSON cannot hold the paragraph explaining the one disabled rule, and a rule turned off without a reason is one nobody can safely turn back on.
- `jsconfig.json`, `types/`: TypeScript's `checkJs` configuration and the ambient declarations for browser APIs its DOM library omits.

### Rendering

`#cycles` and `#preset-list` are rendered by Preact through `htm` tagged templates, per ADR-0009. Everything else in `app.js` still writes to the DOM directly, and three things do so deliberately inside a rendered region: the visual playhead toggles classes on live nodes every animation frame, `layoutSteps` measures what the renderer just produced and writes custom properties back onto it, and a level or balance drag writes its own readout rather than re-rendering the grid under the pointer. None belongs in a component.

The first two are safe because reconciliation restores what they write, or leaves it alone. The third is not, and it is the reason `writeReadout` changes a Text node's data instead of assigning `textContent`: assigning replaces the node, and the node it replaces is one Preact created and still holds, so every later render of that readout is written into a node no longer in the document. Anything that writes text into a rendered region has the same constraint. The e2e suite asserts the identity of the node both readouts keep.

Interface state stays in module scope. Preact is here to reconcile, not to own state, so no component holds any — `openRhythms`, `presetsOpen` and the rest are read as props from the render functions that mount each region.

`render` is Preact's. The application's own whole-interface render is `renderInterface`, and the per-region ones are `renderPanels`, `renderTransport`, `renderPresetPanel`, `renderCycles` and `renderFooter`.

### The Preset origin

`presetOrigin` records which Preset the current Configuration came from and the snapshot it held at that moment. Two things read it: what the save field opens on, and whether there is anything to save at all, which is what makes the `+ Save` chip live. `sameConfiguration` answers the second against the one remembered snapshot rather than against every stored Preset, because it is asked on every render, including every pointer move of a tempo drag.

It is a claim about what storage holds, so it stops being true when storage moves: deleting a Preset — here or in another tab — leaves it naming something no Preset carries any more, and a stale origin reads as nothing to save, which is exactly backwards. Every write to the stored Presets that this tab did not itself make goes through `adoptSavedPresets`, which reconciles the origin, redraws the list and repaints the header together. Saving is the one write that does not, because it knows the origin it just created. Add a fourth route to changing `savedPresets` and it goes through `adoptSavedPresets` too.

Do not reintroduce `innerHTML` in either rendered region. Rebuilding markup destroys focus, which is what made `focusSelector`, `renderPresetSelection` and three `requestAnimationFrame` focus deferrals necessary; the e2e suite asserts those regions are not rebuilt and that focus survives a Preset being deleted from another tab.

`model.js` holds the shared musical vocabulary (`STEP`, `METER_COUNT_LIMIT`, `METER_UNITS`, `SUBDIVISION_LIMIT`). `configuration.js` imports it rather than restating the literals, so a bound or a name is only ever changed in one place.

Both Meter components are selects. Numerators range from 1 through 16 and denominators are the conventional written units `1`, `2`, `4`, and `8`; `4/4` is the default. BPM sets the shared primary-beat rate: a Meter lasts `numerator × 60 / BPM` seconds, regardless of denominator, and Subdivision alone divides each beat into Pattern positions.

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
- **esbuild** — the two browser distribution targets. It discovers and bundles the module graph without hand-written module lists or JavaScript rewriting.
- **Biome** — lint and formatting. Two packages and one binary, with no plugin ecosystem to accrete. Bare ESLint is sixty-nine packages before the first plugin, which is the comparison that decided this.
- **TypeScript** — `checkJs` only. No file changes language and nothing compiles; `tsc` runs with `noEmit`.
- **@types/node** — types only. Without it no file importing a `node:` builtin can be checked at all.
- **@axe-core/playwright** — accessibility assertions against the rendered tree, which is the half `test/accessibility.test.js` cannot reach from Node.

Fewer is still the default. Prefer browser and Node standard APIs, and do not introduce a framework, plugin ecosystem, development server, or general task runner without a concrete requirement. Preact was added on a measurement, not a preference, and the next one needs an argument of the same kind.

A runtime dependency is pinned to an exact version, because its code is copied into both distributions and a range lets two builds of one commit ship different bytes. esbuild is pinned for the same reason from the other side, deciding those bytes rather than supplying them; the rest float, because nothing they do reaches a user. `test/dependencies.test.js` holds the runtime half of that rule.

Bare specifiers are resolved in development by the import map in `index.html`, which points at the installed packages and names every specifier the source uses, including the ones a package imports internally. Both distributions strip the map, because esbuild resolves those modules into the bundle and `node_modules/` ships with neither artifact.

Worth knowing before reaching for more analysis: when Biome, TypeScript and axe were first run against this codebase they found, between them, zero defects. Every finding was either correct code the rule did not fit or a type the checker did not know. They are here to catch what arrives next, not because something was wrong — so weigh a new tool by the regressions it would catch, and do not expect a haul.

## Verification

Install development dependencies and the managed browser once with `npm install` and `npx playwright install chromium`.

Then run:

```bash
npm run check
```

`npm test` is the fast loop. `npm run check` is what CI runs, and adds, in order: `npm run lint` (Biome), `npm run types` (TypeScript), the coverage thresholds, the browser tests, and the site build. `npm run format` writes the fixes Biome can apply itself.

Two ratchets guard against drift, and both are set where the code already stands rather than where it might ideally be. Raise either when the real figure rises; do not lower one to make a change fit.

Coverage is enforced at 95% lines, 87% branches, and 94% functions, measured over the source modules only — `test/` and `e2e/` are excluded because coverage of a test file measures nothing.

TypeScript runs with `noImplicitAny` and `strictNullChecks` off. That is the ratchet, not the destination: together those two account for roughly 440 further errors, almost all of them demanding an annotation on a parameter whose type is obvious one line away. Turning either on is a project rather than a flag. `types/globals.d.ts` declares the two Safari APIs the DOM library omits, both optional on purpose — typed as always present, the guards around them would read as dead code.

`test/syntax.test.js` parses every JavaScript file git tracks. It replaced a hand-written list of `node --check` calls that named seven files and silently omitted `server.mjs`, `playwright.config.js`, and three build scripts. Nothing needs adding when a new source file appears — committing it is what enrols it.

Any change to Configuration transitions, signatures, pulse generation, or step semantics must include or update tests in `test/configuration.test.js`. Timing-maths changes must include or update tests in `test/model.test.js`. Audio context lifecycle and scheduler behaviour is tested in `test/metronome-audio.test.js`.

Browser interaction changes must update `e2e/` when the behavior is observable there. Click voicing is asserted against the exported `SOUND_PROFILES` and `CLICK_ENVELOPE` values, so retuning a sound must never require editing frame numbers in `e2e/audio-graph.spec.js`.

`e2e/accessibility.spec.js` scans six states with axe. Every scan emulates reduced motion, and a new scan must do the same: catching a panel part way through its 140ms `drawer-in` fade makes axe measure half-transparent text and report a serious contrast violation against markup that is correct the moment it settles. The reduced-motion block in `styles.css` changes only timing properties, so what axe measures is what everyone sees, arriving immediately. Do not substitute a timeout — it is a number that is too short on a loaded runner and wasted everywhere else. A state worth adding a control to is a state worth adding a scan for.

Workflows are linted by actionlint, in CI only, since the binary does not come from npm and a check that silently skips when its tool is missing is worse than one that runs where the tool is guaranteed. To run it locally, install actionlint and run it from the repository root. It covers what `test/workflow.test.js` cannot — the schema GitHub actually enforces — and runs shellcheck over every `run:` block, so a multi-line one needs `set -euo pipefail` and quoted expansions.

Also manually verify the audio-specific behavior Playwright cannot assess:

1. Presets `4/4` and `4/4 + 3/4` sound as configured.
2. Headphone separation at hard left and hard right through physical output.
3. Primary, secondary, and tertiary Step voices are perceptually distinguishable at equal gain, and `off` is silent. Check this on a `low` layer, not the default `high`: `low` is the worst case, because its voices land lowest and the ear is least sensitive there.
4. Numerator and Subdivision edits restart cleanly while playing; denominator edits preserve the Transport run.

## Product boundaries

Good next additions:

- shareable URL state
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
