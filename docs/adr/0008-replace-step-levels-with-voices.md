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
- Configuration repair maps the former `full`, `half`, and `quarter` values to
  `primary`, `secondary`, and `tertiary`, preserving patterns and saved presets.
  ADR-0003 took a clean break rather than migrate; that is not available here,
  because ADR-0006 has since put listener-named presets in local storage and a
  break would discard patterns they wrote.
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
