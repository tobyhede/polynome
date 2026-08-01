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

- `model.js`: pure domain functions and timing maths. It must remain browser- and DOM-independent.
- `metronome.js`: Web Audio nodes, transport, and look-ahead scheduler.
- `app.js`: UI state, event handling, local persistence, and visual playhead.
- `styles.css`: responsive visual design.
- `test/`: Node built-in tests for pure timing and state behaviour.

## Dependencies

The project intentionally has zero runtime or development dependencies. Prefer browser and Node standard APIs. Do not introduce a framework or bundler unless a concrete requirement justifies the cost.

## Verification

Run:

```bash
npm run check
```

Any change to timing, signatures, pulse generation, or step semantics must include or update tests in `test/model.test.js`.

For browser changes, manually verify:

1. Play and stop from the button and Space key.
2. Presets `4/4` and `4/4 + 3/4`.
3. Headphone separation at hard left and hard right.
4. Accent, hit, and rest cycling.
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
