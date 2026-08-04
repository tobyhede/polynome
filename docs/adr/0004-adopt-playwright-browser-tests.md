# Adopt Playwright browser tests

Polynome will use Playwright with managed Chromium for browser interaction tests. The application retains zero runtime dependencies, and `@playwright/test` is the only development dependency this decision adds.

The level-scaling assertion is superseded by ADR-0008. Every other consequence
below — the seam, the tooling, the ports, the bundle check — remains in force.

## Consequences

- Browser tests exercise the rendered interface seam: focus, keyboard controls, accessibility state, persistence, current-cycle styling, and responsive overflow.
- Pure timing mathematics and transport planning remain in the Node built-in test suite. Playwright uses Chromium's `OfflineAudioContext` to render the production click graph and assert its frame window, Step-voice pitch, off state, muted-layer silence, and stereo channel separation without relying on speakers or wall-clock timing.
- `metronome.js` widens its public surface for that seam: `scheduleClickVoice`, `createLayerOutput`, `SOUND_PROFILES`, `CLICK_ENVELOPE`, and `STEP_PITCH_RATIOS`. Exporting the voicing values rather than duplicating them keeps signal assertions about scheduling and pitch independent of click tuning; a sound's frequency, waveform, or length can change without editing a test. Because that surface is public, `scheduleClickVoice` is reached with values Configuration repair never saw, and answers an unrecognised voice with silence rather than a guessed pitch.
- Superseded by ADR-0008. It read: "Level scaling is asserted at the envelope's attack endpoint, where the scheduled gain equals `peakGain × level` exactly. Peak-amplitude ratios over the whole render are not proportional to level, because attack and decay are exponential ramps whose curvature depends on the peak." There is no level to scale now. The equal-gain promise is asserted against the scheduled automation in the Node suite, where the three audible voices must produce one identical envelope. The rendered peaks are asserted only within a tolerance, because which sample is largest depends on where an oscillator crest falls relative to the envelope apex, and that differs per voice with frequency: the lowest voice can measure the loudest.
- The suite loads the generated `dist/polynome.html` over `file://` and asserts it boots, renders, and starts playback with no page errors. This covers the distribution path the README advertises and the module-scope class of bundler defect that source-served tests cannot see. `npm run test:browser` regenerates the bundle first so the assertion never runs against stale output.
- Physical output latency, device routing, and subjective audible quality remain manual checks.
- `npm run check` runs both suites. Development and CI use Node.js 22 or newer, tracking the end of Node.js 20 support.
- Playwright starts the static server on dedicated port 4174 with reuse disabled and managed shutdown, so tests neither attach to a developer server nor leave an orphan listener.
- CI installs Chromium only. Firefox and WebKit remain out of scope until a concrete cross-browser defect justifies their cost.
- A custom Chrome DevTools Protocol harness was rejected because it would duplicate browser discovery, interaction, assertion, diagnostics, and process-lifecycle behavior behind a shallow local interface.
