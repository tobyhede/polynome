# Eastern European and non-dyadic meters

Research date: 2026-08-05

## Conclusion

There is no Web Audio or scheduler limitation preventing Polynome from playing
the common uneven-pulse meters associated with Bulgarian and other Balkan
repertoires. The current restrictions are in the Configuration vocabulary and
the product's notation semantics:

- Meter numerators are selectable from `1` through `16`, so `5/8`, `7/8`,
  `9/8`, `11/8`, and `13/8` are already representable.
- Denominators are restricted to `1`, `2`, `4`, and `8`, so common alternatives
  written over `16`, such as `7/16`, are not selectable.
- Grouping is not stored. A musician can program `7/8` as `2+2+3`, `2+3+2`, or
  `3+2+2` by placing stronger Step voices at the group starts, but the signature
  remains displayed as `7/8`; the Configuration cannot say which grouping the
  pattern implies.
- `7/13` is a different request from `13/8`. A denominator of `13` is a real but
  highly specialized non-power-of-two (often called irrational) signature. It
  does not mean an Eastern European cycle of thirteen eighth- or sixteenth-note
  pulses.

The smallest product change for “more Eastern European time signatures” is
therefore not arbitrary denominator entry. It is likely a set of useful odd-
numerator Presets with explicit accent patterns, plus `/16` if the written unit
matters. Additive labels such as `2+2+3/8` would be a separate representation
feature.

## What the repertoire evidence says

Dobri Hristov's early theory of Bulgarian folk meter, first published in 1913
and available in a peer-reviewed translation, describes unequal meters as
regularly repeating combinations of two- and three-element parts. It identifies
both `7/16` forms with the long group at the end or beginning, and identifies
the first as the basis of the rŭchenitsa. The translator's introduction also
summarizes Bulgarian `5/8` and `7/8` as alternating groups of two and three
eighth notes. [Goldberg, translation of Hristov, sections 0.1, 2.8, and
3.12–3.15](https://mtosmt.org/issues/mto.24.30.4/mto.24.30.4.goldberg.html)

This is the central semantic point: the characteristic feature is the ordered
short/long grouping, not an unusual denominator. `7/8` may be `2+2+3`,
`2+3+2`, or `3+2+2`; those patterns sound different even though their two-number
signature is identical. Steinberg's notation reference likewise defines an
additive signature as an explicit display of beat groups and gives `2+3+2/8`
as an alternative display of `7/8`. [Dorico Pro: types of time
signatures](https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/notation_reference/notation_reference_time_signatures/notation_reference_time_signatures_types_r.html)

MusicXML makes the same distinction in an interchange format: `3+2/8` uses an
additive numerator, while composite signatures with different denominators use
multiple numerator/denominator pairs. [MusicXML 4.0 `<time>`
element](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/time/)

## Tempo semantics

A BPM number is incomplete until the product defines which duration it counts.
Polynome defines BPM as the rate of the shared primary click:

```text
primaryBeatDuration = 60 / BPM
meterDuration = numerator * primaryBeatDuration
```

Consequently, at 120 BPM a `7/4` layer and a `7/8` layer both have a 0.5-second
primary beat and a 3.5-second Meter. The denominator names the written beat but
does not rescale it. This is useful metronome behavior: changing the notation
does not unexpectedly change the click rate the listener set.

A notation-oriented tempo uses a named note value instead. If the mark is
specifically `quarter note = 120`, its arithmetic is:

```text
quarterDuration = 60 / BPM
signatureUnitDuration = quarterDuration * 4 / denominator
meterDuration = numerator * signatureUnitDuration
```

The two interpretations produce different results:

| Signature | Current primary-click semantics | Fixed `quarter = 120` semantics |
|---|---:|---:|
| `7/4` | 0.5 s units; 3.5 s Meter | 0.5 s units; 3.5 s measure |
| `7/8` | 0.5 s units; 3.5 s Meter | 0.25 s units; 1.75 s measure |
| `7/13` | 0.5 s units; 3.5 s Meter | `2/13` s units; `14/13` s measure |

Neither convention is an audio-scheduling limitation. Both can derive every
event from one Transport origin and an absolute event index. They are different
product promises, however. Adding `13` to the denominator select while retaining
the current clock would make `7/13` sound exactly like `7/8` at the same BPM;
interpreting it proportionally would instead make denominator changes alter
layer rate and shared-cycle duration.

A notation-faithful product therefore needs an explicit tempo reference such as
`quarter = 120`, `eighth = 120`, or a grouped beat such as `dotted quarter = 120`.
Polynome deliberately avoids that extra control and treats BPM as primary clicks
per minute.

## Grouping semantics

Grouping answers a different question from tempo reference. `7/8` states that
the measure contains seven eighth-note units, but it does not identify its
larger perceived beats. The same seven equal pulses can be grouped several
ways:

```text
2 + 2 + 3    ONE two | ONE two | ONE two three
3 + 2 + 2    ONE two three | ONE two | ONE two
2 + 3 + 2    ONE two | ONE two three | ONE two
```

The pulses remain evenly spaced. Only the positions of the group-start accents
change:

| Grouping | Zero-based group-start positions |
|---|---|
| `2+2+3` | `0, 2, 4` |
| `3+2+2` | `0, 3, 5` |
| `2+3+2` | `0, 2, 5` |
| `3+2+2+3+3` in `13/8` | `0, 3, 5, 7, 10` |

Polynome can already sound each form: stronger Step voices mark the group
starts, while weaker or silent voices occupy the remaining positions. What it
cannot do is store the grouping independently or display an additive signature
such as `2+2+3/8`.

An explicit representation could add a list such as `groups: [2, 2, 3]`, with
the invariant that its sum equals the Meter numerator. That would support
additive labels, grouping-aware Beat controls, and automatic starting accents.
It would also duplicate information currently carried by the Step pattern: a
changed accent could mean either a different click arrangement or a different
metrical grouping. ADR-0001 resolves that ambiguity in favor of the smaller
model, leaving grouping implicit in Step voices.

## What `7/13` means

Ordinary written note values use power-of-two denominators. A non-power-of-two
denominator instead describes a tuplet-derived unit. Dorico's official example
is `5/6`: five sextuplet-quarter units, with the complete sextuplet occupying a
whole note. By the same interpretation, `7/13` is a bar containing seven units
of a 13-way division of a whole note. It is musically coherent contemporary
notation, but it is not shorthand for a Balkan thirteen-pulse meter. [Dorico
Pro: non-power-of-two time
signatures](https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/notation_reference/notation_reference_time_signatures/notation_reference_time_signatures_types_r.html)

If the intended example was a thirteen-pulse odd meter, that is normally
`13/8` or `13/16`, with an additive grouping such as `3+2+2+3+3` chosen to
describe the actual rhythm. `13/8` is supported by the current controls;
`13/16` is not.

## Repository verification

The current domain is explicit rather than an accidental UI constraint:

- [`model.js`](../../model.js) sets the numerator range to `1..16`, denominator
  choices to `[1, 2, 4, 8]`, and subdivision to `1..5`. Stored denominators not
  in the list are repaired to `4`.
- [`configuration.js`](../../configuration.js) builds every rhythm's pattern as
  `numerator × subdivision` positions. It accepts only the denominator list
  from `model.js`; a numerator or subdivision edit rebuilds the grid, while a
  denominator edit only updates Configuration metadata.
- [`app.js`](../../app.js) renders both signature components as selects from
  those choices, so there is no hidden input route to `/13` or `/16`.
- [`model.js`](../../model.js) computes a Step duration as
  `60 / BPM / subdivision` and a lone Meter span as
  `numerator × 60 / BPM`. Neither calculation reads the denominator.
- [`shared-transport.js`](../../shared-transport.js) derives each audio event
  from the Transport origin plus an absolute Step index multiplied by that Step
  duration. Adding a display-only denominator cannot introduce scheduler drift.
- [ADR-0001](../adr/0001-keep-meter-grouping-out-of-scope.md) deliberately keeps
  grouping out of Configuration and assigns emphasis to the Step pattern.

A direct runtime probe against the current modules confirmed the consequences:

| Requested signature | Repaired signature | Positions at subdivision 1 | Span at 120 BPM |
|---|---|---:|---:|
| `13/8` | `13/8` | 13 | 6.5 s |
| `7/16` | `7/4` | 7 | 3.5 s |
| `7/13` | `7/4` | 7 | 3.5 s |

The repair result does not preserve an unsupported label, in accordance with
the repository's no-migrations policy.

## Technical boundary versus product boundary

For an individual rhythm, any uneven pattern made from at most 16 equal base
pulses is already within the scheduler's safe arithmetic. The Step voices can
encode short/long group starts without changing event timing. Thus the common
`5`, `7`, `9`, `11`, and `13` pulse cases do not require a transport redesign.

There are still two real boundaries:

1. **Notation fidelity.** Because denominator changes are metadata-only,
   `7/4`, `7/8`, and a hypothetical `7/13` would have identical event times at
   the same BPM and Subdivision. That is intentional metronome behavior, but it
   is not a general-purpose notation model for irrational meters. Faithfully
   interpreting `/13` relative to fixed note durations would require revisiting
   the tempo-reference model, not merely adding `13` to a select.
2. **Arbitrary scale.** Cycle spans are the least common multiple of simultaneous
   numerators. The current `1..16` cap bounds both grids and LCM growth. Raising
   it without a concrete repertoire requirement could create extremely long
   shared cycles; this is unrelated to supporting `13/8`, which is already
   inside the bound.

## Recommended scope

For the stated goal, distinguish three possible requests:

1. **More playable Balkan/Eastern European rhythms:** add curated Presets such
   as `7/8 (2+2+3)`, `7/8 (3+2+2)`, `9/8 (2+2+2+3)`, `11/8`, and `13/8`, with
   Step voices encoding group starts. No model or scheduler change is needed.
2. **More conventional written units:** add `16` to the denominator vocabulary
   and its tests. In current timing semantics this is a display/accessibility
   change, not an audio change.
3. **Literal `7/13` and other irrational signatures:** first define whether BPM
   remains the primary-click rate or refers to a fixed written note value. Only
   then change the domain; accepting the label without that decision would
   imply notation semantics the engine does not implement.

Additive notation in the signature control is optional for playback but useful
for preserving and communicating the intended grouping. It would reverse the
specific product decision in ADR-0001 and therefore needs explicit product
justification rather than being treated as a scheduler limitation.
