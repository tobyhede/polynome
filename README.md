# Polynome

A deliberately small browser metronome with:

- ordered cycles of one or more simultaneous rhythm layers
- polyrhythm and polymeter presets
- editable meter and subdivision per signature unit for every layer
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

## Sequence model

A sequence contains one or more cycles that play in order and then loop. Each
cycle repeats its complete shared span before the sequence advances. Rhythms
inside a cycle begin together and continue until all their meter downbeats
realign.

Each layer has:

- a meter such as `1/4`, `4/4`, or `7/8`
- a subdivision of 1–5 equal pulses within each signature unit
- exactly `signature count × subdivision` editable pattern positions
- a pattern containing accents, hits, and rests
- its own sound, volume, mute state, and stereo position

Examples:

- `1(4/4)`: one cycle containing one 4/4 rhythm.
- `1(4/4 + 3/4)`: one cycle containing simultaneous 4/4 and 3/4 rhythms; their downbeats realign after 12 quarter notes.
- `4(4/4), 3(3/4)`: four complete 4/4 cycles followed by three complete 3/4 cycles.

Tempo is always expressed as quarter-note BPM (`♩ BPM`).

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
model.js         Pure sequence, cycle, rhythm, and timing model
shared-transport.js  Stateful sequence event planning and playhead
metronome.js     Web Audio graph and look-ahead scheduler
server.mjs       Zero-dependency local static server
scripts/          Single-file bundler
dist/             Browser-ready one-file application
test/            Node built-in tests
```

## Current limitations

- Tempo reference is fixed to the quarter note.
- Changes to sequence timing or structure restart the shared transport when playing.
- Clicks are synthesized rather than sampled.
- No swing, MIDI, tempo automation, or shareable URLs yet.
