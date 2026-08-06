# Advance every Grid control through one edit

A listener presses a control and its Step voice advances. That is one gesture,
and it is now one edit: `advance-control-voice`, carrying the index of the
control that was pressed. How many pattern positions that control runs across is
read from the layer's `displayMode`, which [ADR-0011](0011-store-the-display-mode-in-the-configuration.md)
put in the Configuration. This replaces `advance-beat-voice` and
`advance-step-voice`, which were the same operation written twice.

They were never decided to be two. `advance-step-voice` arrived with Step voices
themselves; `advance-beat-voice` arrived with display modes and was built beside
it rather than through it. Each then named its target in its own mode's terms —
`beat: 3` against `position: 7` — and two payloads made two operations out of
one. The bodies say otherwise: a Beat-control edit writes the advanced voice at the
run's first position and `tertiary` across the rest, and a position edit is that
with a run of one, where the rest is empty and the `off` exception cannot arise.

So the domain concept is not a Beat control and a step control. It is a **Grid
control**: a contiguous run of pattern positions whose Step voice advances
together. A Display mode decides the run length and nothing else, which is why
that is the only thing this codebase now branches on when it asks what a
control is.

The edit carries the control index rather than the positions because the rule
about what a press means belongs to the domain. An interface that sent positions
could describe a control the layer does not offer; an interface that sends an
index can only name one the layer already has, and the bound it is refused at is
the count of controls that Display mode offers.

## Consequences

- [`grid.ts`](../../grid.ts) holds a rhythm layer's meter-relative grid: the
  canonical pattern, repair, the runs a Display mode lays out, and the inverse
  the visual playhead needs. It imports [`model.ts`](../../model.ts) and
  nothing else, so both [`configuration.ts`](../../configuration.ts) and
  [`app.ts`](../../app.ts) read it. The nine places that stated the
  signature-unit-to-position relation independently — six in `app.js`, one of
  them by writing a DOM attribute and reading it back — become one.
- `canonicalSteps` and `resizeSteps` move there as `canonicalPattern` and
  `repairPattern`. This amends [ADR-0012](0012-reset-the-pattern-on-a-meter-or-subdivision-edit.md),
  which names both by function and file. What that decision asserts is unchanged:
  the canonical pattern is still one function, the edits and repair still both go
  through it, and it still takes the meter count and the subdivision rather than a
  length. Only its address moves.
- An edit stops being self-describing. `{type: "advance-beat-voice", beat: 3}`
  could be read on its own; `{type: "advance-control-voice", control: 3}` needs
  the layer to say whether that is a signature unit or a pattern position. That
  is cheap here because edits are transient — [`persistence.ts`](../../persistence.ts)
  writes the Configuration and never the edits, and nothing logs or replays them
  — but it is a real loss of legibility at the one interface a reader is most
  likely to be looking at when something is wrong.
- The two reason codes `beat-not-found` and `pattern-position-not-found` become
  `control-not-found`. The bound each expressed is preserved rather than widened:
  in Beat Mode a control past the end of the Meter is still refused, which is what
  stops it rewriting the pulses of a signature unit inside the Meter.
- The interface emits one `data-action`, `control`, and one `data-control`
  attribute in place of `beat`/`step` and their two indices. `GridControl` takes
  no mode; what a control is called is composed in `app.ts`, because
  `grid.ts` is read by `configuration.ts` and has no business holding a string
  neither of them will ever show.
- `data-steps-per-beat` becomes `data-controls-per-signature-unit`, and
  `data-beats` becomes `data-signature-units`; both are sourced from
  `controlCounts`. `layoutSteps` still reads them off the grid the renderer just
  produced rather than off the Configuration, which is the discipline recorded
  in [`AGENTS.md`](../../AGENTS.md); what changes is that the DOM carries the
  counts instead of restating them.
- `styles.css` keeps `data-display-mode`, which it reads to give a Beat Mode
  control its current-step pulse. The animation restart in `updateActiveSteps`
  keeps naming the mode for the same reason: what it depends on is that a control
  spans more than one position, but a stylesheet cannot ask a function, and
  making only the JavaScript precise would split one rule across two
  vocabularies.
- [`CONTEXT.md`](../../CONTEXT.md) gains **Grid control** and the mechanism moves
  into it. **Beat Mode** and **Subdivision Mode** shrink to naming their run
  lengths, and **Beat control** stays as the entry recording that the interface
  says "beat" to a listener.
- Grid and pattern behaviour is tested in `test/grid.test.js`, which drives the
  module directly with hand-written rhythm layers rather than through
  `createConfiguration` — this module sits beneath the one that repairs and has
  to be testable without it.
