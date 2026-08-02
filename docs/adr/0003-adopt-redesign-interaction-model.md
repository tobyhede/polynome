# Adopt the redesign interaction model

Polynome will implement `/Users/tobyhede/psrc/polynome-redesign/Polynome.dc.html` as its authoritative visual and interaction reference while retaining the production shared transport, Web Audio scheduler, zero-dependency architecture, accessibility, and responsive behavior. This supersedes ADR-0002 only where that decision specified repetition limits, display-only dots, an always-expanded rhythm interface, or a generated sequence summary.

## Consequences

- Pattern positions have four amplitude-only step levels: `off`, `quarter`, `half`, and `full`. Their factors are `0`, `0.25`, `0.5`, and `1`; they never alter frequency, click duration, meter, cycle span, or transport phase.
- Step controls cycle `full → half → quarter → off → full`. New patterns use `full` for the first position and `half` for remaining positions.
- Step-level edits preserve the current transport position and affect subsequently scheduled events. Meter, subdivision, repetition, and structural edits restart from the sequence beginning.
- Eight interactive dots set each cycle's repetition count from 0–8. A zero-repetition cycle is inactive and skipped, but the final active cycle cannot be disabled or removed.
- Rhythm settings live in an accessible collapsible drawer. The sequence summary and numeric repetition input are removed; cycle dots communicate both the configured count and active repetition.
- The initial preset catalogue remains `4/4` and `4/4 + 3/4`. Presets replace the sequence, use one active repetition per cycle, and begin with centred rhythm layers. Preset saving and additional presets are out of scope.
- The prototype is a design reference, not production code. Its React runtime, animation-driven audio, external Google Font requests, and non-responsive shortcuts are not adopted.
- JetBrains Mono and Major Mono Display are self-hosted with system fallbacks and embedded in the generated single-file bundle.
- Persistence takes a clean break because step values and cycle repetition rules change.
