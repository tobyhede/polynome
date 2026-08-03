# Remove the master volume control

Polynome removes its application-level master volume control and the persisted state behind it. Output loudness is the device's to set, and a second volume control in front of the system one earns neither the interface space nor the state it costs. This supersedes ADR-0003 only where that decision specified master volume as an editable mix value; every other mix and transport consequence recorded there remains in force.

## Consequences

- The transport offers playback and tempo. There is no in-application loudness control, and the system or device volume is the only one.
- `masterVolume` leaves the Configuration, together with the `set-master-volume` edit type. A stored configuration written before this decision still loads: repair ignores the field rather than migrating it, and the value is not written back.
- `metronome.js` keeps its master `GainNode`. It is not the removed control but the stage `stop()` zeroes to silence the graph, and it is now fixed at the `MASTER_GAIN` constant. That constant holds the value the previous default produced, so output level is unchanged by this decision.
- `#syncNodes` restores `MASTER_GAIN` rather than reading state, because stopping leaves the node at zero and a preserved context reuses the same node on the next run.
- Per-layer level and stereo position are untouched. The product promise is a separate level and position for every rhythm, which is per-rhythm and never was global.
- The mix-edit transport behaviour in ADR-0003 continues to govern mute, rhythm level, and balance: they apply immediately through the shared per-layer gain and pan nodes without moving the transport origin.
- The wide transport layout loses the third grid column that existed only to hold the control.
