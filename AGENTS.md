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
- `persistence.js`: deferred writes and storage-key migration, both free of any host environment so they can be driven by tests.
- `app.js`: DOM interaction, transient interface state, and visual playhead. It owns the storage key names and wires `localStorage` to `persistence.js`.
- `styles.css`: responsive visual design.
- `test/`: Node built-in tests for pure timing and state behaviour.

`model.js` holds the shared musical vocabulary (`STEP`, `NOTE_UNITS`, `METER_COUNT_LIMIT`). `configuration.js` imports it rather than restating the literals, so a bound or a name is only ever changed in one place.

### Configuration edit failure modes

`changeConfiguration` separates programmer error from user input, and the two are reported differently on purpose:

- **Programmer error throws.** An unknown edit type, or a known type whose payload is structurally malformed (a missing or wrong-typed field), throws a `TypeError`. These cannot come from the interface without a bug, so they must fail loudly rather than be swallowed.
- **Domain-invalid input returns.** A well-formed edit carrying a value the domain rejects — out of range, not in the offered choices, or refused by a Sequence policy — returns `{consequence: "none", reason}`. These are ordinary user input and the reason is what the interface reports.

Every outcome, including both no-ops above, returns a freshly repaired Configuration. The caller's own object never comes back, so a no-op still yields a new value that is equal but not identical — repair runs before dispatch, and nothing downstream depends on identity. Identifiers are re-generated unless they match the shape this module issues, because they are read from storage and written into the interface.

## Dependencies

The project intentionally has zero runtime or development dependencies. Prefer browser and Node standard APIs. Do not introduce a framework or bundler unless a concrete requirement justifies the cost.

## Verification

Run:

```bash
npm run check
```

Any change to Configuration transitions, signatures, pulse generation, or step semantics must include or update tests in `test/configuration.test.js`. Timing-maths changes must include or update tests in `test/model.test.js`.

For browser changes, manually verify:

1. Play and stop from the button and Space key.
2. Presets `4/4` and `4/4 + 3/4`.
3. Headphone separation at hard left and hard right.
4. Full, half, quarter, and off step-level cycling.
5. Signature and pulse edits while playing.
6. Mobile layout around 375 px width.

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
- user accounts
- cloud sync
- effects chains
- recording
- tempo automation

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
