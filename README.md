# Polynome

A deliberately small browser metronome with:

- ordered cycles of one or more simultaneous rhythm layers
- polyrhythm and polymeter presets
- editable meter and subdivision per signature unit for every layer
- four step levels: off, quarter, half, and full
- independent volume and stereo pan for each rhythm
- sample-accurate Web Audio scheduling from one shared transport clock
- no runtime dependencies, accounts, analytics, or framework build step

## Open it immediately

With Node.js 22 or newer, run the bundle command, then double-click the generated file:

```bash
npm run bundle
open dist/polynome.html
```

The generated `dist/polynome.html` contains the complete application, including its fonts, in one file and needs no server. Generated output is intentionally not committed.

## Run the source version

Requires Node.js 22 or newer only for development tools and the tiny local static server.

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

The application itself is static and can also be hosted directly on GitHub Pages, Netlify, Cloudflare Pages, or any ordinary web server.

## Test it

Install the development tools and managed Chromium once:

```bash
npm install
npx playwright install chromium
```

```bash
npm test
npm run test:browser
npm run check
```

`npm test` covers the pure timing and state model. The Chromium suite covers
browser focus, accessibility state, persistence, playback controls, and the
mobile layout. `npm run check` runs both suites and generates the bundle and
site output.

## Sequence model

A sequence contains one or more cycles that play in order and then loop. Each
cycle repeats its complete shared span before the sequence advances. Rhythms
inside a cycle begin together and continue until all their meter downbeats
realign.

Each layer has:

- a meter such as `1/4`, `4/4`, or `7/8`
- a subdivision of 1–5 equal pulses within each signature unit
- exactly `signature count × subdivision` editable pattern positions
- a pattern whose steps control click amplitude at 0, 0.25, 0.5, or 1
- its own sound, volume, mute state, and stereo position

Examples:

- `1(4/4)`: one cycle containing one 4/4 rhythm.
- `1(4/4 + 3/4)`: one cycle containing simultaneous 4/4 and 3/4 rhythms; their downbeats realign after 12 quarter notes.
- `4(4/4), 3(3/4)`: four complete 4/4 cycles followed by three complete 3/4 cycles.

Tempo is expressed as BPM against the fixed quarter-note reference used by the timing model. The interface labels it simply as `BPM`.

## Timing design

JavaScript timers do not play sounds directly. A short look-ahead loop fills the browser audio queue, while every click is scheduled against `AudioContext.currentTime` at an exact time derived from the shared transport origin, sequence position, cycle repetition, and absolute rhythm step. Intervals are never accumulated from the previous event.

```text
transport origin + sequence offset + cycle offset + repetition offset + step index × step duration
```

This prevents cumulative drift between rhythm layers and cycle transitions.

## Files

```text
index.html       Interface shell
styles.css       Responsive visual design
app.js           UI state, persistence, and interaction
configuration.js Editable configuration, presets, and edit availability
model.js         Pure sequence, cycle, rhythm, and timing model
shared-transport.js  Stateful sequence event planning and playhead
metronome.js     Web Audio graph and look-ahead scheduler
persistence.js   Deferred storage writes and storage-key migration
server.mjs       Zero-dependency local static server
scripts/          Single-file bundler
fonts/            Self-hosted interface fonts and licenses
dist/             Browser-ready one-file application
test/            Node built-in tests
e2e/             Playwright browser interaction tests
playwright.config.js  Managed Chromium and local test server
```

## Current limitations

- Tempo reference is fixed to the quarter note.
- Changes to sequence timing or structure restart the shared transport when playing; step-level and mix edits do not.
- Clicks are synthesized rather than sampled.
- No swing, MIDI, tempo automation, or shareable URLs yet.
