# Synchronize the audio graph only when its state changes

The metronome synchronizes its Web Audio graph when graph-affecting state
changes, and never as routine scheduler work. `start()` synchronizes the graph
before its first scheduler tick, `updateMix()` synchronizes it as part of the
edit, and every change to the rhythm-layer set restarts the Transport run and
therefore goes through `start()`. A dirty flag records that one of those paths
has changed the graph's desired state and is cleared only after synchronization
finishes.

This replaces the scheduler's former eventual-consistency fallback.
`#schedule()` called `#syncNodes()` on every one of its forty ticks per second,
even though no scheduler path changes the Configuration. At the default
Configuration, that issued 120 `setTargetAtTime` calls per second — the master
gain plus each layer's gain and pan on every tick — all restating values already
in force. At twelve layers it issued 1,000 per second. Each call places a
control message on the `AudioContext`'s control-message queue; the measurements
and primary sources are recorded in
[Performance optimisation and regression testing](../research/performance-optimisation-and-regression-testing.md).

The graph remains no further behind the engine state than before. The previous
fallback could repair a missed update on the next 25 ms scheduler tick, but no
graph-affecting state reaches the engine without an immediate synchronization
path. Configuration-only edits and Step-voice edits deliberately do not dirty
the graph: neither changes a node or an `AudioParam`. Stopping still sets the
master gain to zero, and the next start dirties the graph before restoring that
same preserved node.

## Consequences

- A steady-state scheduler tick allocates and automates only the clicks it
  plans. It does not rebuild the rhythm list and identifier set or issue mix
  automation.
- `test/audio-work.test.ts` holds the new contract at zero steady-state
  `setTargetAtTime` calls. The total AudioParam budgets fall from 128 to 8 calls
  per second at the default Configuration and from 1,725 to 725 at the domain
  maximum; measured steady-state traffic, excluding transport shutdown, is 6.0
  and 720.0 respectively.
- A new path that changes the master, layer gain, layer pan, or layer set must
  dirty and synchronize the graph itself. Waiting for a scheduler tick is no
  longer a supported recovery path.
- Mix automation still uses `setTargetAtTime` with its 10 ms time constant, so
  levels and stereo position continue to ramp rather than step. The change is
  when that automation is issued, not how it reaches its target.
- The physical-output checks remain necessary: automated tests can count and
  inspect automation but cannot hear whether a mix edit arrived promptly or
  ramped cleanly.
