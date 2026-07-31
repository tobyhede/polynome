# Polynome

Polynome describes multiple independently repeating rhythms derived from one shared musical time reference.

## Language

**Shared transport**:
The common time reference from which every rhythm layer derives its event times.
_Avoid_: Independent clocks, layer clock

**Transport origin**:
The audio time at which the current shared transport begins.
_Avoid_: Start tick, timer start

**Transport run**:
One continuous use of the shared transport, beginning at a transport origin and retaining the same tempo, meters, and patterns until stopped or restarted.
_Avoid_: Session

**Rhythm layer**:
An independently repeating meter-relative grid and pattern with its own sound, level, and stereo position, timed by the shared transport.
_Avoid_: Track, voice

**Meter**:
A repeating span written as a numerator and denominator.
_Avoid_: Pattern length, subdivision

**Signature unit**:
One `1/denominator` duration within a meter; a meter contains `numerator` signature units. It is not always the perceived beat.
_Avoid_: Beat

**Subdivision**:
The number of equal pulses within each signature unit of a rhythm layer's meter.
_Avoid_: Total steps, pulses per cycle

**Meter-relative grid**:
The repeating pulse grid formed by applying a rhythm layer's subdivision to every signature unit in its meter.
_Avoid_: Arbitrary cycle division

**Absolute step**:
The non-wrapping occurrence number of a rhythm layer's meter-relative grid position since the transport origin.
_Avoid_: Pattern index

**Pattern position**:
The repeating editable accent, hit, or rest position within a rhythm layer's meter-relative grid.
_Avoid_: Absolute step

**Rhythm event**:
A scheduled accent or hit identified by rhythm layer, absolute step, pattern position, strength, and audio time. Sound and mix are not properties of the rhythm event, and a rest produces no event.
_Avoid_: Tick, callback
