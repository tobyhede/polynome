# Pull a tempo drag toward ten-BPM marks again, compared against the pointer this time

The tempo slider gets a drag flag and a pointer-position calculation back, and
with them a sticky pull toward the nearest `TEMPO_TICK_INTERVAL` mark:
dragging within `TEMPO_STICK_RADIUS` (4 BPM) of a ten-BPM mark lands on it
instead of on whatever `TEMPO_STEP` (5 BPM) would otherwise have rounded to.
It supersedes [ADR-0014](0014-snap-only-the-balance-and-hold-defaults-to-the-step.md)
where that record removed the tempo slider's drag flag, its four listeners,
and its snap outright — both the flag and a working snap are back, and the
"consequences" that said otherwise no longer hold.

## Why this is not the same mistake twice

ADR-0014 killed the old snap because its 2 BPM tolerance compared against the
value `TEMPO_STEP` had already rounded to, and every tempo the slider can
produce sits either exactly on a mark or exactly `TEMPO_STEP` from one — a
tolerance narrower than that gap can never disagree with the step, so the old
snap fired on nothing.

`stickyTempo` compares against `rawSliderTempo`'s reading of the pointer's own
position on the track instead, taken before the browser's step-rounding ever
touches it. That reading can tell a drag two BPM short of a mark from one that
has already rounded onto the tempo beside it, which is exactly what the old
comparison could not do. `TEMPO_STICK_RADIUS` still has to clear
`TEMPO_STEP / 2` — under that, every position the radius appears to catch is
one the browser's own rounding already assigned to the same mark, so the
comparison agrees with the step by construction and the stick is inert again,
the same failure by the opposite mistake. It also has to stay under
`TEMPO_STEP`, or the two marks flanking an off-mark tempo close its reachable
zone from both sides at once — the failure the Balance quarter-marks made,
which ADR-0014 also removed. 4 sits inside that band: `model.ts` holds the
reasoning against both bounds, and `test/model.test.ts` holds the arithmetic
that keeps every tempo the slider steps to reachable at its own position.

## What ADR-0014 got right and still stands

Nothing about the coarse steps changes. `TEMPO_STEP` is still 5, `MIX_STEP` is
still 0.05, and neither Level nor Balance gets a mark-snap back — ADR-0014's
finding that a snap earns its place only when the grid is fine enough to miss
a mark by accident still holds for both, and neither grid changed. Balance
keeps exactly the one snap ADR-0014 left it: the centre tolerance, untouched
here.

## Consequences

- `app.ts` regains a `bpmSliderDragging` flag and `pointerdown`/`pointermove`/
  `pointerup`/`pointercancel`/`keydown` listeners on the tempo slider, mirroring
  `balanceSliderDragging`'s shape. ADR-0014's "The tempo slider loses its drag
  flag and the four listeners that maintained it" no longer describes the
  code; it is superseded by this record.
- The tick row is a snap's drawn form again, for the marks the stick pulls
  toward. ADR-0014's "nothing holds it to a snap any more, because there is no
  snap" is superseded here — the row still draws from `TEMPO_TICK_INTERVAL` and
  for no other reason, but that interval is now also the stick's own target.
- Only a drag reads the pointer position `stickyTempo` needs. Arrow keys, the
  one-BPM stepper keys, and a typed tempo all reach `set-tempo` with no
  pointer behind them, so every tempo they could always reach they still can;
  the stick narrows nothing about the keyboard.
- The radius costs the same shape of thing the Balance centre tolerance costs,
  scaled to the tempo grid: each of the 28 marks between 30 and 300 takes a
  `TEMPO_STICK_RADIUS - TEMPO_STEP / 2` = 1.5 BPM bite from both edges of its
  two off-mark neighbours' reachable zones, narrowing each from 5 BPM to 2 BPM
  rather than closing it. Every tempo the slider steps to remains reachable by
  drag; none are keyboard-only.
- `rawSliderTempo` reads a `--slider-thumb-inset` custom property to map a
  screen position onto the tempo range the way the browser's own step-rounding
  does, rather than across the slider's full bounding box. That property is
  root-scoped rather than repeated, because `.bpm-ticks` and the `.mix-tick`
  marks on Level and Balance both position themselves against the same
  browser-default thumb inset, and a second copy is how they would drift from
  the thumb and from each other.
