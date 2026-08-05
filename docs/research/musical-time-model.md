# Musical-time model for Polynome

> **Superseded timing decision:** This document records the earlier fixed-
> quarter-note model. Polynome now defines BPM as the shared primary-click rate;
> see [Meter validity and tempo reference](meter-validity-and-tempo-reference.md).

> **Resolved product decisions:** Polynome uses meter-relative grids only, with subdivisions of `1` through `5` pulses per signature unit. Grouping is not modeled as state or UI. Four Step voices express emphasis: off, tertiary, secondary, and primary. The three audible voices share one gain and descend in four-semitone intervals ([ADR-0008](../adr/0008-replace-step-levels-with-voices.md), which replaced the earlier amplitude-only levels). Existing local state is hard-reset without migration or schema-version machinery, here as everywhere: Polynome is unreleased, so no stored data exists to migrate.

## Conclusion

The reported problem is real, but the proposed correction is only fully correct for **simple meter**. In 4/4 and 5/4, treating the numerator units as the base editable positions is a reasonable product choice: there are four or five quarter-note units, and each can be divided into two, three, or four pulses. It is not a universal definition of musical beats. In 6/8, the numerator counts six eighth-note **divisions**, while the usual perceived meter has two dotted-quarter beats. In 7/8 grouped 2+2+3, there are seven eighth-note divisions but three unequal groups.

For this deliberately small metronome, the recommended model is:

```text
meter:              numerator N, denominator D
tempo:              quarter-note BPM B (already an explicit product constraint)
grid:               pulsesPerSignatureUnit K, chosen from 1, 2, 3, 4, 5
editable positions: N * K
```

Call the denominator value a **signature unit** (or meter division), not always a beat. Show a dynamic dropdown such as `1 per quarter`, `2 per quarter`, `3 per quarter (triplet)`, `4 per quarter` for `/4`, and the equivalent labels relative to an eighth for `/8`. This produces the user's expected 4, 8, and 12 positions in 4/4 without pretending that `12` is a standard note-value denominator.

No additional grouping metadata is required for the product's meter-relative timing calculations.

## Terms that must remain distinct

- **Measure / cycle**: the repeating span bounded by the meter. In this app a rhythm layer's cycle can correspond to one notated measure, but the concepts should not be silently conflated if arbitrary polyrhythm spans remain supported.
- **Beat**: a perceived or conducted pulse. In simple meter it normally matches the denominator unit; in compound meter it spans three denominator units; in odd meter it depends on grouping.
- **Beat unit**: the note duration assigned to the beat. It is a quarter note in simple 4/4, a dotted quarter in ordinary 6/8, and is not recoverable from `N/D` alone for every meter.
- **Division**: the first equal partition of a beat: normally two parts in simple meter and three in compound meter. Open Music Theory distinguishes this from further **subdivision** ([simple meter](https://viva.pressbooks.pub/openmusictheory/chapter/meter/), [compound meter](https://viva.pressbooks.pub/openmusictheory/chapter/compound-meters-and-time-signatures/)).
- **Subdivision**: a further partition below the division level. Product UIs often use the word loosely for any grid density, which is the source of the present ambiguity.
- **Pulse / grid position**: one evenly spaced scheduling position exposed by the app. This is a product-domain concept, not necessarily a sounded note.
- **Note value**: a written duration such as quarter, eighth, or sixteenth. Note values do not by themselves state their metrical role ([Open Music Theory, Notating Rhythm](https://viva.pressbooks.pub/openmusictheory/chapter/notating-rhythm/)).
- **Tuplet**: an explicit proportional division. A triplet places three parts in a span normally occupied by two in simple meter; compound meter already divides beats naturally into three, so three eighth notes within a 6/8 dotted-quarter beat are not a triplet ([Open Music Theory, Borrowed Divisions](https://viva.pressbooks.pub/openmusictheory/chapter/other-rhythmic-essentials/)).
- **Pattern step**: one editable emphasis value — an amplitude level when this was written, a Step voice since ADR-0008. In the recommended model it maps one-to-one to a grid position, but it should not be called a musical beat.

## What time signatures actually say

| Meter | Written capacity | Usual perceived beats | What additional information matters |
|---|---|---|---|
| 4/4 | Four quarter-note units | Four quarter-note beats | Simple quadruple meter |
| 5/4 | Five quarter-note units | Commonly five quarter-note pulses grouped, for example, 3+2 or 2+3 | Grouping determines accent and larger beat structure |
| 6/8 | Six eighth-note units | Two dotted-quarter beats, each divided into three eighths | Compound-duple interpretation |
| 7/8, 2+2+3 | Seven eighth-note units | Three groups lasting 2, 2, and 3 eighths | The explicit grouping/order |

In simple meter, the numerator gives beats per measure and the denominator gives the beat unit ([Open Music Theory, Simple Meter and Time Signatures](https://viva.pressbooks.pub/openmusictheory/chapter/meter/)). In compound meter, the numerator instead gives divisions per measure: 6/8 contains six eighth-note divisions but two dotted-quarter beats ([Open Music Theory, Compound Meter and Time Signatures](https://viva.pressbooks.pub/openmusictheory/chapter/compound-meters-and-time-signatures/)). Asymmetrical meters require grouping—the same 7/8 may be 2+2+3, 3+2+2, or another order ([Open Music Theory, Twentieth-Century Rhythmic Techniques](https://viva.pressbooks.pub/openmusictheory/chapter/twentieth-century-rhythmic-techniques/)).

The numerator is therefore not always the perceived beat count. It reliably states how many denominator units fill the written measure; meter interpretation adds grouping.

MusicXML reinforces this separation: time signatures use numerator/denominator fields and may encode additive values such as `3+2/8`, while rhythmic resolution is a separate divisions-per-quarter value that must account for tuplets ([MusicXML `<time>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/time/), [MusicXML `<divisions>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/divisions/)).

## Formulas under quarter-note BPM

Let:

- `B` = quarter notes per minute
- `N/D` = time signature
- `q = 60 / B` = quarter-note duration in seconds
- `g_i` = a group length measured in denominator units
- `K` = equal pulses per denominator/signature unit

Then:

```text
measureDuration = q * N * (4 / D)
groupDuration(i) = q * g_i * (4 / D)
pulseDuration = q * (4 / D) / K
positionsPerMeasure = N * K
eventTime(i) = transportOrigin + absolutePulseIndex * pulseDuration
```

The measure formula is valid independently of whether the meter is simple, compound, or odd because it measures the notated span in quarter-note units. Quarter-note BPM is an explicit, standard tempo interpretation: MusicXML's playback tempo is quarter notes per minute ([MusicXML `<sound>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/sound/)), and a metronome mark such as quarter = 60 means one quarter note per second ([Open Music Theory, Tempo](https://viva.pressbooks.pub/openmusictheory/chapter/other-aspects-of-notation/)).

If the product instead defines subdivisions relative to the **perceived beat**, two integers are insufficient:

```text
simple meter:   beatsPerMeasure = N
compound meter: beatsPerMeasure = N / 3, with dotted beat units
odd meter:      beats and their unequal durations come from groups[]
```

A fully general tuplet also needs a ratio, not a synthetic denominator. If a base note duration is divided as `actual:normal`, then:

```text
tupletPulseDuration = baseNoteDuration * normal / actual
```

For an eighth-note triplet, three eighths occupy the normal duration of two: `actual=3`, `normal=2`. MusicXML likewise represents tuplets with actual and normal note counts rather than a `12` note type ([MusicXML notation basics](https://www.w3.org/2021/06/musicxml40/tutorial/notation-basics/)).

## Worked representations

At quarter-note BPM `B`, with the recommended `K = pulsesPerSignatureUnit`:

Grouping shown below is music-theory annotation for the reader, not part of the model: no grouping state is stored or exposed (ADR-0001).

| Example | Representation | Positions | Pulse duration |
|---|---|---:|---:|
| 4/4 quarter grid | `N=4, D=4, K=1` | 4 | `60/B` |
| 4/4 eighth grid | `N=4, D=4, K=2` | 8 | `30/B` |
| 4/4 quarter-beat triplets | `N=4, D=4, K=3` | 12 | `20/B` |
| 5/4 quarter grid | `N=5, D=4, K=1` (heard as 3+2) | 5 | `60/B` |
| 6/8 eighth grid | `N=6, D=8, K=1` (heard as 3+3) | 6 | `30/B` |
| 7/8 eighth grid | `N=7, D=8, K=1` (heard as 2+2+3) | 7 | `30/B` |

For 6/8, positions 0 and 3 are the two ordinary beat starts. The six positions are denominator-unit divisions, not six perceived beats. A pattern can accent positions 0 and 3 and mark or silence the other positions according to the desired click.

For 7/8 grouped 2+2+3, positions 0, 2, and 4 are group starts. The groups last 2, 2, and 3 eighth-note units respectively, so they are not three equal-duration beats.

A **3:2 polyrhythm** is different from choosing a meter grid: define a shared span `S`, then place three events at `origin + j*S/3` and two at `origin + k*S/2`. The current preset uses a two-quarter cycle as `S`; that is musically coherent. Changing both layers to `K=3` and `K=2` per quarter would still produce a 3:2 rate ratio, but it would repeat the relationship within every quarter and double both event counts over the current two-quarter span. The product must decide which span the preset intends.

## Representation options

### A. Pulses per beat: `1 / 2 / 3 / 4`

Benefits: compact data, direct dropdown, and intuitive in 4/4. It naturally expresses beat, binary division, triplet division, and four-way division.

Cost: the word **beat** is ambiguous. In 6/8, three pulses per perceived dotted-quarter beat gives the ordinary six eighth-note positions, not an exotic triplet. In 7/8 2+2+3, equal pulses per grouped beat would produce unequal pulse durations. This option is only sound if “beat” is precisely defined and grouping-aware.

### B. Grid denominator: `4 / 8 / 12 / 16 ...`

Benefits: `4`, `8`, and `16` resemble familiar note values and make duration arithmetic easy when the grid tiles the measure.

Costs: `12` is not a conventional note value; it is shorthand for a quarter divided into three. Values may not tile every signature (a quarter grid gives 3.5 positions in 7/8), labels become misleading across `/4` and `/8`, and tuplets require proportional context. This representation is not recommended as the domain model.

### C. Explicit note value plus tuplet ratio

Example: `{ noteUnit: 8, tuplet: { actual: 3, normal: 2 } }` for eighth-note triplets.

Benefits: musically rigorous, portable to notation formats, and capable of arbitrary tuplets.

Costs: more state, validation, terminology, and UI than this metronome currently needs. It pushes toward notation-editor scope and is not recommended now.

### Recommendation: pulses per signature unit

Use option A's small integer but name its reference precisely: `pulsesPerSignatureUnit`, where the signature unit is `1/D` of a whole note. This guarantees `N*K` editable positions for every meter, handles odd meters uniformly, and permits dynamic, honest labels. Grouping is deliberately not kept as state (see ADR-0001): accent structure is expressed only through the per-position step value, an amplitude-only level when this was written and a Step voice since ADR-0008.

This is intentionally less ambitious than a full beat-aware or note-value/tuplet model. If a later requirement demands “click only perceived beats” or arbitrary tuplets spanning multiple units, add an explicit grid reference/span then; do not overload `K`.

## Assessment of the proposed correction and current app

### Right

- A 4/4 quarter-note grid should expose four positions; an eighth-note grid should expose eight; quarter-beat triplets should expose twelve.
- The time signature must determine the duration/capacity of the cycle before grid density is applied.
- A dropdown is clearer than a free numeric field if only supported musical divisions are intended.
- “Subdivision” should describe density within a declared reference unit, not silently mean arbitrary total steps.

### Incomplete

- “The time signature is the number of beats” fails for ordinary compound meter: 6/8 has two perceived beats, not six.
- 5/4 and 7/8 need grouping to describe accent and perceived-beat structure.
- “Subdivision 12 = triplet” is only a useful arithmetic shorthand relative to a quarter-note reference. Triplet is a 3:2 relationship, not a note-value denominator.
- “Two beats per step” should be “two pulses/notes per signature unit” (or per beat, once beat is precisely defined).

### Musically wrong or misleading in current semantics

- `stepDuration = measureDuration / steps.length` is mathematically correct for evenly distributing an arbitrary pulse count across a cycle. It is not itself a timing error.
- Calling `steps.length` a **subdivision** is misleading because it is currently the total pulses per cycle, not divisions per beat or denominator unit.
- The UI allows meter and raw pattern length to vary independently without explaining whether the result is a note grid, a tuplet across a beat, or an n:m division across the whole cycle.
- The former 3:2 preset was a valid three-against-two division of one shared two-quarter span. It should not be used as evidence that the meter numerator always determines pattern length.
- The former 7/8 preset was musically reasonable as seven eighth-note positions accented 2+2+3, but the model stored the grouping only implicitly in accent states.

## Presets and persistence implications (superseded — options considered before the hard reset)

> These options were considered and rejected. Polynome hard-resets persisted state: it writes a new storage key, deletes the retired keys on load, and stores no schema version and no migration path. Only the "clear one-time reset" option was adopted; the rest is the reasoning behind the rejection, not guidance.

- Considered and rejected: introduce an explicit schema version before changing persisted meaning. An old `steps.length=8` cannot always reveal whether the user intended eight pulses per cycle or two pulses per quarter.
- Safest migration: preserve old layers as a legacy `pulsesPerCycle` mode, or invalidate old local state with a clear one-time reset. Inferring `K = steps.length/N` is safe only when it is an allowed integer.
- 4/4 + 3/4 maps cleanly to `K=1` for each layer.
- 7/8 maps cleanly to `K=1`; a 2+2+3 feel is expressed with step levels at pattern positions 0, 2, and 4 rather than stored grouping.
- Considered and rejected: 3:2, 4:3, and 5:4 require a product decision about the shared comparison span. Preserve them as explicit `pulsesPerCycle` polyrhythms, or redefine their meter/span and accept changed playback speed and pattern length.
- Do not silently reinterpret existing saved arrays; that would change users' rhythms while retaining their labels.

## Resolved product direction

- Every rhythm layer uses a meter-relative grid with `N*K` pattern positions.
- The subdivision dropdown supports `K = 1..5` pulses per signature unit.
- The initial preset catalogue is meter-first: one `4/4` rhythm, or `4/4 + 3/4` polymeter. That catalogue stopped being a catalogue in [ADR-0010](../adr/0010-seed-example-presets-into-storage.md), and the examples seeded in its place are `4/4 8ths` and `4/4 Triplets` — two 4/4 layers told apart by Subdivision rather than by meter, so what ships is no longer meter-first.
- Ratio presets remain out of scope until the product has an explicit shared-cycle pulse model.
- Emphasis remains entirely in the step value; no grouping state or control is introduced. That value was an amplitude-only level when this was written and is a Step voice since ADR-0008.
- Existing persisted state is discarded rather than migrated because its subdivision meaning is ambiguous.
