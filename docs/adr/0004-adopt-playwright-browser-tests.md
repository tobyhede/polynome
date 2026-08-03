# Adopt Playwright browser tests

Polynome will use Playwright with managed Chromium for browser interaction tests. The application retains zero runtime dependencies; `@playwright/test` is the sole development dependency.

## Consequences

- Browser tests exercise the rendered interface seam: focus, keyboard controls, accessibility state, persistence, current-cycle styling, and responsive overflow.
- Pure timing mathematics and transport planning remain in the Node built-in test suite. Playwright uses Chromium's `OfflineAudioContext` to render the production click graph and assert its frame window, level scaling, off state, muted-layer silence, and stereo channel separation without relying on speakers or wall-clock timing.
- `metronome.js` widens its public surface for that seam: `scheduleClickVoice`, `createLayerOutput`, `SOUND_PROFILES`, and `CLICK_ENVELOPE`. Exporting the voicing values rather than duplicating them keeps signal assertions about scheduling and level scaling independent of click tuning; a sound's frequency, waveform, or length can change without editing a test.
- Level scaling is asserted at the envelope's attack endpoint, where the scheduled gain equals `peakGain × level` exactly. Peak-amplitude ratios over the whole render are not proportional to level, because attack and decay are exponential ramps whose curvature depends on the peak.
- The suite loads the generated `dist/polynome.html` over `file://` and asserts it boots, renders, and starts playback with no page errors. This covers the distribution path the README advertises and the module-scope class of bundler defect that source-served tests cannot see. `npm run test:browser` regenerates the bundle first so the assertion never runs against stale output.
- Physical output latency, device routing, and subjective audible quality remain manual checks.
- `npm run check` runs both suites. Development and CI use Node.js 22 or newer, tracking the end of Node.js 20 support.
- Playwright starts the static server on dedicated port 4174 with reuse disabled and managed shutdown, so tests neither attach to a developer server nor leave an orphan listener.
- CI installs Chromium only. Firefox and WebKit remain out of scope until a concrete cross-browser defect justifies their cost.
- A custom Chrome DevTools Protocol harness was rejected because it would duplicate browser discovery, interaction, assertion, diagnostics, and process-lifecycle behavior behind a shallow local interface.
