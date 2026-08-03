# Meter validity and tempo reference

Research date: 2026-08-04

## Conclusion

The reported mismatch is real, but it is not evidence that Polynome's scheduler
is drifting. It is a product-level timing-semantics bug already present on
`main`: the interface presents an unlabeled `BPM` value while the engine gives
it one hidden, fixed meaning:

- Before the correction, Polynome treated BPM as **quarter notes per minute**,
  independent of meter.
- Metronom.us treats BPM as the rate of its primary clicks. Changing its
  denominator changes the displayed note-value interpretation, but not the
  wall-clock interval between those clicks.

At subdivision 1 and a displayed tempo `B`:

| Signature unit | Former Polynome interval | Metronom.us interval | Difference |
|---|---:|---:|---:|
| `/4` | `60/B` seconds | `60/B` seconds | none |
| `/8` | `30/B` seconds | `60/B` seconds | Polynome is 2x the click rate |
| `/16` | `15/B` seconds | unsupported | Polynome is 4x the `/4` click rate |

The applications should align at the same BPM in `/4` with subdivision 1. If
they do not, that is a separate runtime or state bug. Their default settings are
also different at the time of research: Polynome opens at 96 BPM in 4/4, while
Metronom.us opened at 80 BPM in 3/4, so comparing the two defaults alone makes
Polynome 20% faster before meter semantics enter the picture.

Restricting meter denominators does not by itself repair the bug. The confirmed
product decision is to use the ordinary metronome model:

1. BPM is the shared primary-beat rate for every Rhythm layer.
2. Subdivision alone divides each primary beat into additional pulses.
3. The numerator determines how many primary beats form a Meter; the
   denominator names their written unit but does not rescale their duration.

The product decision is to keep Meter entry immediate: both components are
selects, numerators range from 1–16, and denominators are restricted to the
conventional written units `1`, `2`, `4`, and `8`. Non-power-of-two time
signatures are real contemporary notation, but they are too unusual for this
metronome's ordinary control surface.

## What a time signature determines

In ordinary Western notation, the denominator maps a signature unit through
successive halving: `1` is a whole note, `2` a half note, `4` a quarter note,
`8` an eighth note, and so on. The numerator gives the number of those units in
the written bar. Steinberg's Dorico documentation also makes the important
polymeter point that note lengths remain fixed between staves: a quarter note
in 2/4 remains equal to a quarter note in 6/8 even when their barlines do not
coincide. [Dorico: Time signatures](https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/notation_reference/notation_reference_time_signatures/notation_reference_time_signatures_c.html)

The two integers do not always reveal the perceived or conducted beats:

- Simple 4/4 normally has four quarter-note beats.
- Compound 6/8 contains six eighth-note divisions but normally has two dotted-
  quarter beats.
- Irregular 5/4 or 7/8 needs unequal grouping; additive notation such as
  `2+3+2/8` can state that grouping explicitly.

These distinctions are documented by both
[Open Music Theory's compound-meter chapter](https://viva.pressbooks.pub/openmusictheory/chapter/compound-meters-and-time-signatures/)
and [Dorico's time-signature types](https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/notation_reference/notation_reference_time_signatures/notation_reference_time_signatures_types_r.html).
MusicXML likewise represents `3+2/8` and composite signatures such as
`2/4 + 3/8`, demonstrating that a finite list of common numerator/denominator
pairs is not a complete definition of meter.
[MusicXML `<time>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/time/)

### Which values are valid?

There is no useful finite whitelist of numerators. Positive numerators support
simple, compound, irregular, and additive meters; a product may impose a
practical upper bound without calling excluded values musically invalid.

For denominators, powers of two are the conventional note values and should be
the normal product surface. A non-power-of-two denominator is not nonsense,
however. Dorico defines 5/6 as five sextuplet-quarter units where the complete
sextuplet equals a whole note, and notes their use by Thomas Adès. It separately
acknowledges fractional time signatures in Boulez's music.
[Dorico: non-power-of-two and fractional time signatures](https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/notation_reference/notation_reference_time_signatures/notation_reference_time_signatures_types_r.html)

That makes `4/3`, `5/6`, and `7/10` mathematically and musically interpretable,
but niche. The current exact-rational interpretation—one `/D` unit is `4/D`
quarter notes—is coherent for non-power-of-two meters. The UX question is
whether Polynome intends to teach and expose that advanced notation. Its core
product promise does not require doing so.

## BPM needs a reference note value

A bare BPM number is insufficient whenever the relevant note value can change.
MusicXML's regular metronome mark therefore pairs a required `beat-unit` (which
can also be dotted or tied) with a `per-minute` value.
[MusicXML `<metronome>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/metronome/)
For playback interchange it also offers a different convention: the `tempo`
attribute on `<sound>` is explicitly quarter notes per minute.
[MusicXML `<sound>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/sound/)

Both models are legitimate when named. For example, a score marking `♩ = 60`
means sixty quarter notes per minute, or one quarter note per second.
[Open Music Theory: Tempo](https://viva.pressbooks.pub/openmusictheory/chapter/other-aspects-of-notation/)
In 6/8, a metronome mark may instead refer to the dotted-quarter conducted beat.
The signature alone does not select that tempo reference unambiguously.

Before the correction, Polynome chose the fixed-quarter convention in
`model.js`:

```text
quarterDuration = 60 / BPM
signatureUnitDuration = quarterDuration * 4 / denominator
stepDuration = signatureUnitDuration / subdivision
barDuration = numerator * signatureUnitDuration
```

This is internally consistent arithmetic, but it is not acceptable product
behaviour behind a generic `BPM` control: musicians reasonably expect the
displayed tempo to describe the beat they hear. Polynome now uses:

```text
primaryBeatDuration = 60 / BPM
stepDuration = primaryBeatDuration / subdivision
meterDuration = numerator * primaryBeatDuration
```

This matches Soundbrenner's documented convention: its beat is defined by the
selected time signature, changing time signature does not automatically change
BPM, and an `x/8` meter must use double the BPM only when a musician explicitly
wants to preserve quarter notes per minute.
[Soundbrenner app manual](https://www.soundbrenner.com/pages/manual-the-metronome-app)

## What Metronom.us does

The first-party site's current UI restricts the numerator to 1 through 13 and
the denominator to 4 or 8. Those are product limits, not the boundaries of
valid music. Its bundled implementation computes a base duration as
`round(60000 / bpm)` and does not scale that duration by the signature
denominator. The denominator instead selects a rhythm catalogue and its note
glyphs. The default rhythm emits one primary click per base duration.
[Metronom.us application bundle](https://metronom.us/js/main-D4ht3yw4.js)

A browser measurement on 2026-08-04 confirmed the implementation: at 80 BPM,
changing 3/4 to 3/8 left the steady primary-click interval at approximately
0.75 seconds. The site's own explanation states that 120 BPM produces 120
clicks per minute, while the note value receiving the click depends on the time
signature.
[Metronom.us: What is BPM?](https://metronom.us/en/what-is-bpm/)

Metronom.us is evidence for user expectations, not a scheduler architecture to
copy. Its bundle drives the loop from a worker-backed interval and calls Howler
playback on each tick. Polynome's transport-origin plus absolute-index Web Audio
scheduling is the stronger timing design and should remain unchanged.

## Product decision

Confirmed and implemented:

- BPM means primary beats per minute, matching ordinary metronome expectations.
- Every layer derives that beat from the same Transport origin.
- Subdivision controls additional pulse density.
- Numerator controls Meter and Cycle length.
- Denominator remains the written name of the beat and has no timing
  consequence.

This deliberately prioritizes metronome behavior over notation-engine
semantics. Simultaneous `3/4` and `3/8` layers with the same Subdivision now have
the same event times; their denominator labels differ, but their clocks do not.
