# Polynome

Polynome describes ordered cycles of independently repeating rhythms derived from one shared musical time reference.

## Language

**Shared transport**:
The common time reference from which every rhythm layer derives its event times.
_Avoid_: Independent clocks, layer clock

**Transport origin**:
The audio time at which the current shared transport begins.
_Avoid_: Start tick, timer start

**Transport run**:
One continuous traversal of the sequence, beginning at a transport origin and retaining the same timing structure until stopped or restarted. Step-voice and mix edits may change what it plays without changing its position.
_Avoid_: Session

**Sequence**:
A non-empty ordered list of cycles whose active cycles play one after another and repeat from the beginning until stopped. A sequence always has at least one active cycle.
_Avoid_: Playlist, arrangement

**Cycle**:
A non-empty exclusive group of rhythm layers. When active, its rhythm layers begin together and play concurrently for a complete cycle span.
_Avoid_: Section, rhythm group

**Active cycle**:
A cycle with one or more repetitions in the sequence. A cycle with zero repetitions is inactive and skipped without changing the order of the remaining active cycles.
_Avoid_: Enabled cycle, muted cycle

**Cycle span**:
The shortest duration after which every rhythm layer in a cycle returns to its downbeat together.
_Avoid_: Bar, measure

**Cycle repetition**:
One traversal of a complete cycle span. A cycle may repeat its span before the sequence advances.
_Avoid_: Count, loop

**Rhythm layer**:
An independently repeating meter-relative grid and pattern that belongs to exactly one cycle, with its own sound, level, and stereo position.
_Avoid_: Track, voice

**Primary beat**:
The shared pulse whose rate is the Configuration's BPM. Every Rhythm layer has
one Signature unit per Primary beat before Subdivision adds pulses within it.
_Avoid_: Click, quarter-note clock

**Meter**:
A repeating span written as a numerator and denominator. The numerator counts
primary beats; the denominator names their written unit without changing their
rate. Numerators range from 1–16 and denominators are 1, 2, 4, or 8.
_Avoid_: Pattern length, subdivision

**Signature unit**:
One primary beat written as `1/denominator`; a meter contains `numerator`
signature units. Its duration is `60 / BPM` regardless of denominator, and it
is not always the perceived beat.
_Avoid_: Beat

**Subdivision**:
The number of equal pulses within each signature unit of a rhythm layer's meter. A subdivision of one leaves the primary beat undivided.
_Avoid_: Total steps, pulses per cycle

**Meter-relative grid**:
The repeating pulse grid formed by applying a rhythm layer's subdivision to every signature unit in its meter.
_Avoid_: Arbitrary cycle division

**Absolute step**:
The non-wrapping occurrence number of a rhythm layer's meter-relative grid position since the transport origin.
_Avoid_: Pattern index

**Pattern position**:
The repeating editable position within a rhythm layer's meter-relative grid. Each pattern position has a Step voice.
_Avoid_: Absolute step

**Step voice**:
The pitch role at a pattern position: `primary`, `secondary`, and `tertiary` use equal gain and descend in four-semitone intervals, while `off` produces no event.
_Avoid_: Step level, Full, half, quarter, accent strength

**Rhythm event**:
A scheduled non-off occurrence identified by rhythm layer, absolute step, pattern position, Step voice, and audio time. Sound and mix are not properties of the rhythm event.
_Avoid_: Tick, callback

**Configuration**:
The complete editable metronome state: tempo, master level, and the full Sequence including every rhythm layer's pattern, sound, level, stereo position, and mute state. It is the value the interface edits, the value stored between visits, and the value a Preset holds a snapshot of. Values arriving from storage are repaired into a Configuration rather than rejected.
_Avoid_: Settings, state, options

**Preset**:
A named reusable snapshot of a Configuration. Applying a preset recalls that Configuration exactly. Its name is its primary identity; meter-and-subdivision notation is only a summary.
_Avoid_: Pattern, project, session

**Seeding**:
Writing the examples `4/4` and `4/4 + 3/4` into storage the first time Polynome runs, when the preset key has never been written. It names the act and nothing else: what it writes are Presets, renameable, replaceable, and deletable like any other, and afterwards nothing tells them apart from the ones a user saved. Deleting them all leaves no Presets, which is a state Polynome stays in.
_Avoid_: Built-in preset, factory preset, default preset, seed preset
