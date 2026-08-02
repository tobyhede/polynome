# Adopt Playwright browser tests

Polynome will use Playwright with managed Chromium for browser interaction tests. The application retains zero runtime dependencies; `@playwright/test` is the sole development dependency.

## Consequences

- Browser tests exercise the rendered interface seam: focus, keyboard controls, accessibility state, persistence, current-cycle styling, and responsive overflow.
- Pure timing mathematics and transport planning remain in the Node built-in test suite. Audible quality and stereo separation remain manual checks.
- `npm run check` runs both suites. Development and CI use Node.js 22 or newer.
- Playwright starts the static server on dedicated port 4174 with reuse disabled and managed shutdown, so tests neither attach to a developer server nor leave an orphan listener.
- CI installs Chromium only. Firefox and WebKit remain out of scope until a concrete cross-browser defect justifies their cost.
- A custom Chrome DevTools Protocol harness was rejected because it would duplicate browser discovery, interaction, assertion, diagnostics, and process-lifecycle behavior behind a shallow local interface.
