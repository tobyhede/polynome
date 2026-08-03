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
