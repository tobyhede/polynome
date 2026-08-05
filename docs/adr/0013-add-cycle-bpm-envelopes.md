# Add Cycle BPM envelopes to the shared transport

Each Cycle may carry a relative BPM envelope: Flat, Up, Down, or Peak. The
Configuration's existing `bpm` remains the Preset's starting BPM. An active
Cycle inherits the preceding active Cycle's audible, clamped endpoint; inactive
Cycles retain their envelope but affect neither time nor inheritance. Every
complete Sequence traversal starts from the Configuration BPM again.

This clarifies [ADR-0002](0002-sequence-complete-cycle-spans.md)'s global-tempo decision: global means one shared tempo
curve derived from one Transport origin, not one constant BPM and never an
independent clock per Cycle or Rhythm layer. It supersedes
[ADR-0003](0003-adopt-redesign-interaction-model.md) where that
record requires a lone Cycle to have exactly one repetition and permits tempo
editing during playback. A lone Cycle now supports one through eight
repetitions, and starting-BPM controls are unavailable while the derived live
BPM is displayed.

## Consequences

- Flat applies a signed change at its Cycle boundary and holds the clamped
  result. Flat zero is represented canonically as `null`.
- Up and Down interpolate linearly over primary-beat progress from the inherited
  BPM to a clamped target. Peak reaches its clamped target at the exact musical
  midpoint and returns to its inherited BPM at the end.
- One envelope spans the complete Cycle span multiplied by its repetitions.
  Repetitions lengthen the transition rather than restarting it.
- Event audio time is the Transport origin plus a closed-form integral of
  seconds per primary beat at the event's absolute musical position. Position,
  Pattern position, Sequence boundaries, and current BPM use the inverse of the
  same mapping. Event intervals are never accumulated.
- Flat steps and Sequence-loop resets are the only intentional tempo
  discontinuities. Adjacent continuous envelopes meet at the audible endpoint.
- The transport BPM display is transient derived state while playing. It is
  rounded for display without changing scheduler precision, Configuration,
  persistence, Preset selection, or Save availability.
- A Cycle-envelope edit has the `restart-transport-run` consequence. Existing
  Step-voice, sound, mix, and denominator consequences remain narrow.
- Missing or unrecognised stored envelope data repairs to `null`. This is
  additive repair, not a migration, schema version, compatibility shim, or
  storage-key change.
- Presets store envelope data with the complete Configuration and describe it as
  a relative change, so notation does not change when an earlier Cycle changes
  the inherited BPM.
