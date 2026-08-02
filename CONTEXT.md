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
One continuous traversal of the sequence, beginning at a transport origin and retaining the same timing structure until stopped or restarted. Step-level and mix edits may change without changing its position.
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

**Meter**:
A repeating span written as a numerator and denominator.
_Avoid_: Pattern length, subdivision

**Signature unit**:
One `1/denominator` duration within a meter; a meter contains `numerator` signature units. It is not always the perceived beat.
_Avoid_: Beat

**Subdivision**:
The number of equal pulses within each signature unit of a rhythm layer's meter. A subdivision of one leaves the signature unit undivided; in `/4` meters this produces quarter-note pulses.
_Avoid_: Total steps, pulses per cycle

**Meter-relative grid**:
The repeating pulse grid formed by applying a rhythm layer's subdivision to every signature unit in its meter.
_Avoid_: Arbitrary cycle division

**Absolute step**:
The non-wrapping occurrence number of a rhythm layer's meter-relative grid position since the transport origin.
_Avoid_: Pattern index

**Pattern position**:
The repeating editable position within a rhythm layer's meter-relative grid. Each pattern position has a step level.
_Avoid_: Absolute step

**Step level**:
The relative amplitude at a pattern position: `off` produces no event, while `quarter`, `half`, and `full` multiply the rhythm layer's level by `0.25`, `0.5`, and `1`. These names describe amplitude only, never note value or duration.
_Avoid_: Accent, hit, rest, strength

**Rhythm event**:
A scheduled non-off occurrence identified by rhythm layer, absolute step, pattern position, step level, and audio time. Sound and mix are not properties of the rhythm event.
_Avoid_: Tick, callback
