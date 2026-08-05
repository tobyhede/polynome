# Sequence complete cycle spans

Polynome will compose rhythm layers into cycles and play an ordered sequence of those cycles. Rhythm layers within a cycle remain simultaneous on one shared transport; cycles advance sequentially only after every contained rhythm returns to its downbeat, preserving complete musical spans without truncation.

The repetition range, cycle activity rule, generated summary, and control presentation below are superseded by ADR-0003. The complete cycle-span and shared-transport decisions remain in force.

The Preset catalogue below was superseded first by
[ADR-0010](0010-seed-example-presets-into-storage.md), and its current examples
are recorded in [ADR-0015](0015-refine-defaults-and-sliders.md).

## Consequences

- The state hierarchy is `Sequence → Cycle → Rhythm layer`. A sequence and each cycle are non-empty, every rhythm belongs to exactly one cycle, and at most 12 rhythms exist across the sequence.
- One cycle span is the shortest shared duration in which all contained meters return to their downbeats. Subdivision changes pulse density but never meter or cycle-span duration.
- An active cycle repeats its complete cycle span for its configured number of cycle repetitions before the sequence advances to the next active cycle. A cycle with zero repetitions is inactive and is skipped entirely. The ordered active cycles then loop from the first active cycle until stopped.
- Tempo is global. Every event and cycle boundary derives from one transport origin; cycles do not have independent clocks or tempos.
- Starting playback begins at the first active cycle and first repetition. Stopping resets that position. Timing-structure edits restart from the sequence beginning, while step-level, sound, and mix edits do not.
- The generated sequence summary and original always-expanded controls are superseded by ADR-0003.
- Rhythm labels derive from their time signatures. Custom rhythm and cycle names, cycle-level mix controls, cycle reordering, and a displayed calculated span remain out of scope.
- “Add rhythm” belongs inside a cycle. “Add cycle” appends `1(4/4)` with centred pan. Users cannot remove the final rhythm from a cycle or the final cycle from the sequence.
- Presets replace the complete sequence. `4/4` creates `1(4/4)`; `4/4 + 3/4` creates `1(4/4 + 3/4)`, with all preset rhythms centred initially. The two names are superseded by ADR-0010, which stopped them being a catalogue at all, and the examples seeded in their place are `4/4 8ths` and `4/4 Triplets` since [PR #22](https://github.com/tobyhede/polynome/pull/22). That applying a Preset replaces the complete Sequence, and that a seeded example's rhythms are centred, both still hold.
- Persistence takes a clean break. Existing flat rhythm state is discarded rather than migrated.
