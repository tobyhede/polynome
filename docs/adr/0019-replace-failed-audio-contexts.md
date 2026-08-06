# Replace failed audio contexts after bounded recovery

Polynome will keep the Web Audio lifecycle wholly inside `metronome.js`, but a context is no longer presumed reusable for the life of the page. This decision supersedes [ADR-0005](0005-own-the-audio-context-lifecycle.md): ordinary interruptions retain their transport run and receive bounded recovery, while a render error, a positively stalled audio clock, failed bounded recovery, or an explicit user request replaces the context and begins a new Transport run because timestamps from two audio clocks cannot share a Transport origin.

## Consequences

- `interrupted` is an operating-system-owned state. The engine normally waits for the browser to restore it, with one bounded recovery attempt after the page becomes visible; it does not continuously treat interruption as suspension.
- A visible run checks whether `AudioContext.currentTime` advances. Wall time may diagnose a stalled audio clock but never decides a musical timestamp.
- A visible `suspended` context and a foregrounded `interrupted` context receive one bounded `resume()` attempt before replacement. A context that still reports `running` while its clock is frozen instead receives one bounded `suspend()`/`resume()` cycle, followed by another clock check, before replacement. No browser promise is awaited without an application-owned deadline.
- Replacement stops and disconnects old sources, best-effort closes the failed context, rebuilds the graph, and establishes a fresh Transport origin. Missed events are skipped rather than emitted as a catch-up burst.
- Recovery is serialized and generation-guarded so late events and promises from an abandoned context cannot affect its replacement.
- The interface provides an explicit, accessible Restart Audio action because neither context state nor clock progress proves that sound reaches the physical output.
- Context replacement is reserved for positive failure evidence or an explicit request. Healthy foregrounding and ordinary recoverable interruptions do not restart the Transport run.
- Page code still cannot guarantee background playback after the operating system freezes, discards, or kills the browser.
