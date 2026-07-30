# Polynome

A deliberately small browser metronome with:

- multiple independent rhythm layers
- polyrhythm and polymeter presets
- editable cycle/signature and subdivision per layer
- accent, hit, and rest steps
- independent volume and stereo pan for each rhythm
- sample-accurate Web Audio scheduling from one shared transport clock
- no runtime dependencies, accounts, analytics, or build step

## Open it immediately

Run the bundle command once, then double-click the generated file:

```bash
npm run bundle
open dist/polynome.html
```

A prebuilt copy is included in `dist/polynome.html`. It contains the complete application in one file and needs no server.

## Run the source version

Requires Node.js 20 or newer only for the tiny local static server.

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

The application itself is static and can also be hosted directly on GitHub Pages, Netlify, Cloudflare Pages, or any ordinary web server.

## Test it

```bash
npm test
npm run check
```

## Rhythm model

Each layer has:

- a cycle such as `2/4`, `4/4`, or `7/8`
- an evenly spaced subdivision pattern within that cycle
- a pattern containing accents, hits, and rests
- its own sound, volume, mute state, and stereo position

Examples:

- `3:2`: two layers share a `2/4` cycle; one uses a triplet subdivision and one uses a half-note subdivision.
- `4/4 + 3/4`: each layer has a different cycle length, so their downbeats realign after 12 quarter notes.
- `7/8 · 2+2+3`: one custom seven-step subdivision accents steps 1, 3, and 5.

Tempo is always expressed as quarter-note BPM (`♩ BPM`).

## Timing design

JavaScript timers do not play sounds directly. A short look-ahead loop fills the browser audio queue, while every click is scheduled against `AudioContext.currentTime` at an exact time derived from:

```text
transport origin + absolute step index × step duration
```

This prevents cumulative drift between rhythm layers.

## Files

```text
index.html       Interface shell
styles.css       Responsive visual design
app.js           UI state, persistence, and interaction
model.js         Pure rhythm model and timing maths
metronome.js     Web Audio graph and look-ahead scheduler
server.mjs       Zero-dependency local static server
scripts/          Single-file bundler
dist/             Browser-ready one-file application
test/            Node built-in tests
```

## Current limitations

- Tempo reference is fixed to the quarter note.
- Changes to cycle or subdivision restart the shared transport when playing.
- Clicks are synthesized rather than sampled.
- No swing, MIDI, tempo automation, or shareable URLs yet.
