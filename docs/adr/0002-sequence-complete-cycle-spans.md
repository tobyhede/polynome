# Sequence complete cycle spans

Polynome will compose rhythm layers into cycles and play an ordered sequence of those cycles. Rhythm layers within a cycle remain simultaneous on one shared transport; cycles advance sequentially only after every contained rhythm returns to its downbeat, preserving complete musical spans without truncation.

## Consequences

- The state hierarchy is `Sequence → Cycle → Rhythm layer`. A sequence and each cycle are non-empty, every rhythm belongs to exactly one cycle, and at most 12 rhythms exist across the sequence.
- One cycle span is the shortest shared duration in which all contained meters return to their downbeats. Subdivision changes pulse density but never meter or cycle-span duration.
- A cycle repeats its complete span 1–32 times before the next cycle starts. The ordered cycle list then loops until stopped.
- Tempo is global. Every event and cycle boundary derives from one transport origin; cycles do not have independent clocks or tempos.
- Starting playback begins at the first cycle and first repetition. Stopping resets that position. Timing-structure edits restart from the sequence beginning, while sound and mix edits do not.
- The generated, read-only sequence summary uses `N(...)` for cycle repetitions, `+` for simultaneous rhythms, and `,` for sequential cycles: `4(4/4 + 3/4), 3(4/4)`.
- The UI groups the existing rhythm interface inside always-expanded cycle containers. Cycle headers use automatic ordinal labels, a `Repeats` input, and smaller display-only repetition circles; only the active repetition is highlighted.
- Rhythm labels derive from their time signatures. Custom rhythm and cycle names, cycle-level mix controls, cycle reordering, and a displayed calculated span remain out of scope.
- “Add rhythm” belongs inside a cycle. “Add cycle” appends `1(4/4)` with centred pan. Users cannot remove the final rhythm from a cycle or the final cycle from the sequence.
- Presets replace the complete sequence. `4/4` creates `1(4/4)`; `4/4 + 3/4` creates `1(4/4 + 3/4)`, with all preset rhythms centred initially.
- Persistence takes a clean break. Existing flat rhythm state is discarded rather than migrated.
