# Replace amplitude levels with four Step voices

Polynome uses four Step voices: `primary`, `secondary`, `tertiary`, and `off`.
The three audible voices use the same click gain. `primary` uses the selected
sound profile's pitch, `secondary` is four semitones lower, and `tertiary` is
eight semitones lower. This supersedes ADR-0003's fractional level vocabulary
and amplitude-only voicing, and ADR-0004's amplitude-scaling assertion.

## Consequences

- Step controls cycle `primary → secondary → tertiary → off → primary`.
- Gain, click duration, and transport phase remain independent of audible Step
  voice. The pitch change is applied as a ratio, preserving the distinction
  between the selected `high`, `low`, and `wood` sound profiles.
- Equal gain is equal amplitude, which is not quite equal loudness: the ear is
  less sensitive as the voices descend. A-weighted, the drop from `primary` to
  `tertiary` is 1.5 dB on `high`, 2.1 dB on `wood`, and 2.7 dB on `low`, whose
  tertiary voice sits lowest at 435 Hz. That residual is accepted and not
  compensated. The amplitude model it replaced coupled loudness to emphasis at
  roughly 6 dB and 12 dB, so this is the same coupling reduced by most of an
  order of magnitude, and trimming it away would restore the per-voice gain this
  decision exists to remove.
- Nothing migrates the former `full`, `half`, and `quarter` values. Polynome has
  not been released, so no stored pattern holds them and there is no data for a
  migration to carry. Repair treats them as it treats any unrecognised value.
- A voice with no entry in the pitch table is not audible. `off` is absent from
  that table rather than present as a silent entry, so one lookup decides both
  pitch and audibility, and an unrecognised voice reaching the public
  `scheduleClickVoice` seam is silent rather than a full-gain click at a
  guessed pitch. Tables keyed by a supplied voice use `model.js`'s null-prototype
  `lookup`, so an inherited name such as `constructor` cannot answer as a
  mapping and turn a frequency into `NaN`.
- The step glyphs still render as a descending ring count. Under equal gain that
  no longer reads as loudness; it reads as the voice hierarchy the pitches
  express. Whether the visual should instead encode pitch directly is left open,
  and is not settled by this decision.
