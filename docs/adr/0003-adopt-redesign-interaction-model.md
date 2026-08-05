# Adopt the redesign interaction model

Polynome will adopt the visual and interaction model of an external single-file React design prototype reviewed during the redesign. That prototype is not versioned in this repository and is not authoritative: the consequences recorded below are the reference. The production shared transport, Web Audio scheduler, zero-dependency architecture, accessibility, and responsive behavior are retained. This supersedes ADR-0002 only where that decision specified repetition limits, display-only dots, an always-expanded rhythm interface, or a generated sequence summary.

Master volume as an editable mix value is superseded by ADR-0007. The
fractional step-level vocabulary and its amplitude-only voicing are superseded
by ADR-0008. The immutable built-in catalogue is superseded by ADR-0010, which
is where that correction is read from; the two examples it names are `4/4 8ths`
and `4/4 Triplets` since [PR #22](https://github.com/tobyhede/polynome/pull/22),
and they are ordinary Presets rather than a catalogue. Every other mix and
transport consequence below remains in force, and reads the same with
`primary`, `secondary`, and `tertiary` substituted for `full`, `half`, and
`quarter`.

The immutable Preset catalogue below was superseded by
[ADR-0010](0010-seed-example-presets-into-storage.md), and the examples it now
seeds are recorded in [ADR-0015](0015-refine-defaults-and-sliders.md).

## Consequences

- Pattern positions have four amplitude-only step levels: `off`, `quarter`, `half`, and `full`. Their factors are `0`, `0.25`, `0.5`, and `1`; they never alter frequency, click duration, meter, cycle span, or transport phase. Superseded by ADR-0008: the four positions are now Step voices at equal gain, distinguished by pitch instead of amplitude. That they never alter click duration, meter, cycle span, or transport phase still holds; that they never alter frequency does not, and is the point of the replacement.
- Step controls cycle `full → half → quarter → off → full`. New patterns use `full` for the first position and `half` for remaining positions. Superseded by ADR-0008: the cycle and the new-pattern defaults are unchanged in shape, under the renamed voices.
- Step-level and mix edits preserve the current transport position: step levels, mute, sound, rhythm level, balance, and master volume never move the transport origin. Step-level and sound changes apply to subsequently scheduled rhythm events, so events already inside the scheduler look-ahead keep the values they were scheduled with; mute, rhythm level, balance, and master volume apply immediately through the shared per-layer gain and pan nodes.
- Tempo, meter-numerator, subdivision, cycle-repetition, and structural edits (adding or removing a cycle or a rhythm layer, and applying a preset) begin a new transport run from a new transport origin, at the first active cycle and its first cycle repetition. A meter-denominator edit changes notation metadata without changing click timing, so it preserves the current run. Dragging the tempo slider keeps the current run at its previous tempo; the new run begins when the slider is released.
- Eight interactive dots set each cycle's repetition count from 0–8. A zero-repetition cycle is inactive and skipped, but the final active cycle cannot be disabled or removed. When the sequence contains exactly one cycle, that cycle always has exactly one repetition; zero and multiple repetitions apply only when the sequence contains multiple cycles.
- Rhythm settings live in an accessible collapsible drawer. The sequence summary and numeric repetition input are removed; cycle dots communicate both the configured count and active repetition.
- The initial built-in preset catalogue remains `4/4` and `4/4 + 3/4`. The earlier decision to keep preset saving out of scope is superseded: listeners may save named, browser-local presets containing the complete Configuration. A preset name is its primary identity, with generated meter-and-subdivision notation as secondary description; sound and mix remain stored but absent from that notation. Applying any preset replaces the complete Configuration, and the built-ins remain immutable. Where those saved presets are kept, and what that costs across tabs and hosts, is decided in ADR-0006.
- Master volume as a user-editable value is superseded by ADR-0007; the mix behaviour above still governs mute, rhythm level, and balance.
- The prototype is a design reference, not production code. Its React runtime, animation-driven audio, external Google Font requests, and non-responsive shortcuts are not adopted.
- JetBrains Mono and Major Mono Display are self-hosted with system fallbacks and embedded in the generated single-file bundle.
- Persistence takes a clean break because step values and cycle repetition rules change.
