# Timing mode: Polymeter and Polyrhythm

Records the decisions behind [ADR-0018](../adr/0018-give-each-cycle-a-timing-mode.md).

## Problem Statement

Polynome calls itself "a compact polyrhythm and polymeter metronome" and delivers half of that. Two Rhythm layers in a Cycle always share one Primary beat, so `4/4` against `3/4` is three bars against four on a common pulse. That is polymeter. There is no way to ask for the other relationship — four evenly spaced clicks against three evenly spaced clicks in one shared bar — which is what a musician means by "four against three".

The nearest reachable thing is two layers of the same Meter at different Subdivisions, which produces a true ratio but only inside a single Primary beat and only for ratios whose terms are both five or less. A listener practising three over two across a two-beat span, or five over four across a bar, cannot get there.

Polynome's first version could express these, by giving two layers the same Meter and different raw pattern lengths so that a step lasted the Meter's duration divided by the pattern length. The meter-relative grid replaced that arithmetic, correctly, and the ability went with it without ever being named.

## Solution

Each Cycle gains a Timing mode with two values, Polymeter and Polyrhythm, controlling how its Rhythm layers share time.

Polymeter is the current behaviour and the default. Every layer's Signature unit lasts `60 / BPM`, and the Cycle span is the least common multiple of the layers' Meter numerators.

Polyrhythm makes the Cycle span one Meter of the Cycle's **first** Rhythm layer. Every other layer fits its own numerator of Signature units into that same span, so the layers agree on every downbeat and disagree everywhere between. The first layer keeps the beat the listener set; the others divide the same bar.

The switch reinterprets the Configuration already present. No Meter, Subdivision, Step voice or Pattern position changes, so it is lossless and reversible, and every existing Preset gains a second reading.

## User Stories

1. As a drummer, I want a Cycle's layers to divide one shared bar, so that I can practise four against three rather than two bars drifting past each other.
2. As a drummer, I want to hear the same two layers as polymeter and as polyrhythm without re-authoring them, so that I can tell the two relationships apart by ear.
3. As a listener, I want the tempo I set to keep meaning what it meant, so that switching a Cycle's relationship does not silently change what BPM counts.
4. As a listener, I want one rhythm in a Polyrhythm Cycle to keep clicking at the tempo I set, so that I have something to count against.
5. As a listener, I want to know which rhythm carries the beat, so that I am not guessing why one layer sounds slower than the number I typed.
6. As a listener, I want my Step voices preserved when I change the mode, so that an accent pattern I built by hand is not thrown away by a switch I might undo.
7. As a listener, I want to switch the mode back and get exactly what I had, so that I can experiment without saving first.
8. As a musician, I want a rhythm's displayed Meter to describe what it actually plays, so that I am not reading `3/4` over a layer whose beat is not a quarter.
9. As a musician, I want a Polyrhythm layer labelled by its relationship to the first layer, so that `3:4` tells me the thing I care about.
10. As a musician, I want the denominator control to disappear when it has nothing left to decide, so that I am not choosing a value the app will ignore.
11. As a musician, I want my chosen denominator back when I return a Cycle to Polymeter, so that the control's disappearance costs me nothing.
12. As a new user, I want first-run examples that demonstrate the difference, so that I discover the feature by pressing play rather than by reading.
13. As a new user, I want a help entry explaining what each mode counts, so that I can find out what BPM means in each without experimenting.
14. As a screen-reader user, I want the mode segments announced as "Polymeter" and "Polyrhythm", so that a visually shortened label does not reach me as "Poly, meter".
15. As a screen-reader user, I want a Polyrhythm layer's Meter and Subdivision announced without a written unit that is not true of it, so that the announcement matches the sound.
16. As a listener, I want the mode control present on a single-rhythm Cycle, so that I can set it before adding the second rhythm rather than after.
17. As a listener, I want a Sequence to move from a Polymeter Cycle into a Polyrhythm one, so that an arrangement can change relationship partway through.
18. As a listener, I want a BPM envelope to work in either mode, so that a ramp does not force me back to polymeter.
19. As a listener, I want layers in a Polyrhythm Cycle to stay locked to their shared downbeat through a tempo ramp, so that a ramp does not smear the relationship.
20. As a listener, I want the playing position indicator to follow each layer at its own rate, so that I can see the relationship as well as hear it.
21. As a returning user, I want Configurations saved before this feature to load and play exactly as they did, so that nothing I stored is disturbed.
22. As a returning user, I want a Preset to recall a Cycle's mode along with everything else, so that a saved setup is complete.
23. As a listener, I want changing the mode to restart the transport run, so that I hear the new relationship from a downbeat rather than from wherever the old one had reached.

## Implementation Decisions

**Timing mode is Cycle-owned Configuration state.** It sits beside the Cycle's repetitions and BPM envelope. Two values, Polymeter and Polyrhythm, defaulting to Polymeter. It is not per-Rhythm-layer, because the relationship is between layers rather than a property of one, and it is not global, because a Sequence should be able to change relationship between Cycles.

**A Cycle holds one relationship.** Mixing polymeter and polyrhythm among three simultaneous layers is not expressible at any scope and is not attempted: Polyrhythm makes every Meter in the Cycle one length, Polymeter makes every Signature unit one length, and no set of three layers can satisfy both.

**The reference is the Cycle's first Rhythm layer, positionally.** It gets no name in the glossary and no control. There is no reordering edit in the Configuration, so the position is stable; removing the first layer promotes the next and re-clocks the Cycle, which is accepted and unguarded. Naming it would imply a choice that does not exist.

**The scheduler gains one mode-dependent quantity.** A layer's beats per step is `1 / subdivision` in Polymeter and `spanBeats / (numerator × subdivision)` in Polyrhythm. Every existing expression follows from it — steps per span is `spanBeats / beatsPerStep`, and an event's musical beat is `cycleStep × beatsPerStep` — so the transport's planning structure, its absolute-index scheme and its tempo-curve integration are untouched. The Cycle span in beats becomes mode-aware at its single existing definition, which already feeds the sequence tempo curves, so BPM envelopes follow with no further change.

**The transport emits each event's step duration.** The engine's click-lateness guard currently recomputes a step duration from the instantaneous BPM and the Subdivision, which is wrong for a non-first Polyrhythm layer and already approximate under a ramp, where an event's real spacing comes from the integral of the tempo curve rather than from a single tempo reading. The transport holds both endpoints when it plans the event, so it emits the true gap and the engine reads it. The model's standalone step-duration calculation loses its only production caller and is removed with its tests.

**The pattern is untouched by a mode edit.** The meter-relative grid is `numerator × subdivision` positions in both modes, so no Canonical pattern is written — unlike a Meter-numerator, Subdivision or Display mode edit. The edit carries the `restart-transport-run` consequence.

**Meter labelling becomes mode-aware.** A Polyrhythm Cycle's layers after the first render as `numerator:firstNumerator` everywhere a Meter is written, and their Subdivision names drop the written unit. The label calculation currently reads a Rhythm layer alone and needs the Cycle's mode and first numerator threaded to it.

**The denominator control is removed, not replaced, for those layers.** Deriving and displaying the exact-rational denominator was rejected: only 89 of the 256 numerator-and-first-layer pairs in range yield an integer, and eight of the survivors exceed `/32`. The stored value is preserved untouched and returns when the Cycle returns to Polymeter.

**No density bound.** The reachable worst case is roughly four hundred pulses a second. A rejection rule would make one layer's valid Meter numerators depend on another layer's, which is a worse control than a setting that sounds bad.

**Persistence is repair, not migration.** A stored Cycle with no Timing mode repairs to Polymeter and the Configuration key is unchanged. The Preset key is retired from v3 to v4 so that the new seeded examples reach installs that already have presets, since Seeding only runs against a key that has never been written.

**Seeding gains a matched pair.** One Cycle of `4/4` and `3`, seeded twice — once in each mode — named `4 + 3 Polymeter` and `4 over 3 Polyrhythm`. They join, not replace, the two existing examples.

**The control is `Poly` with segments `meter` and `rhythm`,** placed above the BPM Envelope in the Cycle settings drawer and shown on every Cycle including single-layer ones. The segments carry `Polymeter` and `Polyrhythm` as accessible names. A ninth help entry, "Polymeter and polyrhythm", explains what BPM counts in each mode.

## Testing Decisions

A good test here asserts event times, labels and stored values — what a listener hears, reads and keeps — and never the shape of the arithmetic that produced them. The mode-dependent beats-per-step quantity is deliberately not a test seam: it is asserted through the event times it produces.

Four existing seams cover it, and no new one is proposed.

**The shared transport** is the primary seam and already has the closest prior art: a test asserting that a polymeter Cycle does not advance until every rhythm returns to its downbeat, and one asserting that polymeter layers stay phase-locked throughout a continuous envelope. Both have direct Polyrhythm analogues. New tests assert that a Polyrhythm Cycle's layers coincide on every downbeat and nowhere else within the span, that the first layer's event times are identical in both modes, that a Cycle span equals the first layer's Meter, and that each planned event carries the step duration its own grid implies.

**The model** covers the Cycle span in beats under both modes, and holds the removal of the standalone step-duration calculation.

**The Configuration** covers the mode edit and its `restart-transport-run` consequence, that the edit writes no Canonical pattern, that a stored Cycle without a mode repairs to Polymeter, that a denominator survives a round trip through Polyrhythm, and that removing the first Rhythm layer re-anchors rather than being refused.

**The audio engine** covers the lateness guard reading the event's own step duration, including a dense Polyrhythm layer whose steps are far shorter than the first layer's.

**Playwright** covers the control's presence and its two states, the denominator control disappearing and returning, the `3:4` labelling reaching the Rhythm heading and the Preset notation, the accessible names on the segments, and the four seeded examples on first run.

## Out of Scope

Per-Rhythm-layer Timing mode, and any mixture of relationships within one Cycle.

A settable reference layer, a control to choose it, or a guard against removing it.

Non-dyadic and fractional Meter denominators. Polyrhythm gives them something to express again, and [ADR-0018](../adr/0018-give-each-cycle-a-timing-mode.md) records that one of the reasons for rejecting them is retired, but the rejection stands.

Meter grouping and additive signatures, still out of scope under [ADR-0001](../adr/0001-keep-meter-grouping-out-of-scope.md).

Any bound on pulse density, and any policy rejection of a Meter numerator based on another layer's.

Reordering Rhythm layers within a Cycle.

Compensating repetitions when a mode change shortens a Cycle.

A ratio-first authoring surface: the numerators are the ratio, and there is no separate ratio control.

## Further Notes

Under Polyrhythm, a layer's Signature unit becomes an exact rational fraction of the Primary beat, which is what a non-dyadic denominator denotes. Against a `4/4` first layer, a three-beat layer sounds `3/3` in exact-rational notation; against a `2/4` first layer, it sounds `3/6`, the sextuplet-quarter unit. This is a byproduct rather than a feature — the unit is derived from the relationship, and only about a third of the numerator pairs in range produce an integer denominator at all — but it means the research conclusion that non-dyadic denominators have nothing left to express no longer holds on its own terms.

The single-layer case resolves itself. A Cycle with one Rhythm layer is its own first layer, so both modes produce identical audio and an identical label, and the mode having no visible effect matches it having no audible one.

`index.html`'s description already claims Polynome is "a compact polyrhythm and polymeter metronome". This makes that true.
