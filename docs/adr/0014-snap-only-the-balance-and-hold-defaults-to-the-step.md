# Snap only the Balance, and hold every default to its control's step

The Balance slider snaps a pointer drag to centre, and nothing else in Polynome
snaps. Balance keeps the ±5% tolerance it already had around pan `0` and loses
its marks at ±0.25, ±0.5, ±0.75 and ±1; the tempo and Level snaps go, and the
drag flags that existed to tell a pointer from a keyboard go with them — the
tempo's outright, the mix one down to the one slider still using it. What
survives of `TEMPO_SNAP` is an interval, renamed `TEMPO_TICK_INTERVAL` and kept
because the tick row under the tempo slider is drawn from it and for no other
reason. `snapToMark` goes with the marks; `snapBalance` is what is left.
Alongside that, each slider's `step` becomes an exported constant in
[`model.ts`](../../model.ts) — `TEMPO_STEP` and the `MIX_STEP` the Level and
Balance share — and every default the Configuration hands out has to lie on the
grid its control's step defines.

These are one decision because they are one mistake twice. A control's `step`
decides which values exist; both halves are what happens when a number is
written as though it did not. A snap was tuned against a grid it no longer
matched, and a default was chosen against a grid that did not exist when it was
chosen. The step is a domain constant, and the values around it — a default, a
tolerance, a mark — are answerable to it.

## The snaps

Coarsening the sliders from `1` to `5` and from `0.01` to `0.05` killed two of
the three snaps outright, and the arithmetic is worth writing down rather than
describing. The tempo produces 55 values between 30 and 300 at a step of five,
and every one of them is either exactly on a ten-BPM mark or exactly five from
one; the tolerance is two, so the snap moves none of them. Level produces 21
values between 0 and 1 at a step of 0.05, and against marks every ten percent
with the same tolerance it moves none of those either. Only Balance still fired,
and it fired hard: at a quarter interval and a five-percent tolerance, 16 of the
41 positions the slider can produce were pulled onto a mark. Nearly two in five
of the values a pointer could reach were not reachable by one.

That ratio is what the decision turns on. A snap earns its place when the grid
is fine enough that a mark is easy to miss and worth aiming for, which is what
was true when the steps were `1` and `0.01`. It buys nothing once the grid lands
on the marks by itself, and it costs something once the grid is coarse enough
that its own neighbours fall inside the tolerance. One step change moved all
three controls across that line at once, two into doing nothing and one into
doing too much.

Restoring the fine steps to make the snaps work again is the obvious repair and
it is the wrong way round: the coarse steps are the improvement, and the snaps
were the scaffolding that made the fine ones bearable. Five BPM and five
percentage points are the increments a musician actually names, and a keyboard
that moves in them is worth more than a pointer that is helped towards a mark it
can now hit unaided. Widening the tempo and Level tolerances is the other
obvious repair, and it collapses on inspection: at a step of five with marks
every ten, the only value a wider tolerance can catch is the midpoint, and a
tolerance that catches the midpoint means the slider can only reach the marks —
which is a step of ten, and better said that way.

Dropping the Balance snap as well, leaving nothing anywhere, is the alternative
that nearly wins, and the reason it does not is worth stating honestly because
it is weaker than the reason the snap was built on. That reason, recorded in
`model.js` rather than in any decision record, was that `panLabel` calls
anything inside four percent of the middle "Centre", and a drag could not make
that reading true — the word sat over a Balance that was audibly off to one
side. At a step of 0.05 the grid contains `0` exactly, so a pointer reaches
centre with no snap at all, and every other value the controls can produce is at
least 0.05 out and reads as a side. The grid now satisfies the argument the snap
was built to satisfy. What the snap still buys is stickiness: the middle catches
a pointer near it, so returning to centre does not mean landing on one of 41
positions exactly. It is kept on that, and only that. Centre is the position a
listener returns to most, and double-clicking the slider — which already returns
it to centre outright — serves the pointer that is nowhere near the middle,
while this serves the one that is.

## The step and the default

The default Level was `0.72`, which is not on the 0.05 grid. A range input does
not reject an off-step value; its value sanitization algorithm rounds it onto the
step and says nothing. So the thumb sat at 0.70 while the readout said 72% and
the audio played 0.72, and one control gave three answers to one question. It
becomes 0.70.

The tempo already lives with the same disagreement on purpose, which is what
identifies the Level case as a defect rather than a variation. Typing 108 into
the BPM field leaves the slider showing 110, and an e2e test asserts exactly
that: the number input is the finer control, it displays the value it holds, and
the slider is an approximate pointer at it. Level has no finer control. There is
no field, no stepper, and nothing that shows 72% except a screen-reader readout
whose slider disagrees with it — so `0.72` was a value nothing could reach,
nothing could correct, and nothing was accountable for.

Nothing caught it because no module could. The steps lived in `index.html` and
in an `htm` template in `app.js`; the defaults lived in `configuration.js`; and
no file knew both numbers, so the relationship between them was not wrong
anywhere in particular. The steps therefore move into `model.js` beside
`TEMPO_LIMIT` and the rest of the shared vocabulary, which is where `AGENTS.md`
already sends a bound that two modules would otherwise restate. That rule now
covers a value the interface owns rather than only the ones the domain does, and
the test that walks every default against its control's grid is what makes it a
rule instead of a habit.

## The tests that were not tests

Four Playwright tests named behaviour that no longer existed and passed anyway:
`dragging the tempo slider stops on the ten-BPM marks`, `dragging the Level
stops on its marks`, the tempo test that abandons a press to prove an arrow key
is left unsnapped, and `dragging the Balance through the middle lands on centre
exactly`. Deleting `snapToMark` outright left five of the six snap tests green,
which is how this was found — mutation, not review.

The last of the four is the instructive one, because it names the Balance and
still went hollow. It asserts that a pointer crossing the middle lands on centre,
which stopped being a claim about the snap the moment the step became 0.05: the
grid contains `0` exactly and the track's middle maps to it, so the assertion
passes with nothing snapping at all. A test can be emptied by a change to a
control it does not mention. Only `dragging the Balance stops on its marks` and
the mix press test survived with anything to say, and the mix press test survived
only by accident of arithmetic — it stepped to 0.45, which sat exactly on the old
±0.5 mark's tolerance. Under this decision it would have gone hollow too, so it
is re-pointed to step off centre instead.

Each of them asserts a property rather than a value: a dragged value is either
on a mark or clear of one by more than the tolerance, never stranded beside it.
That is the right shape for an assertion against the browser's own mapping from
pointer position to value, and it is exactly the shape that passes vacuously
when the domain holds no counterexample. The general statement is that a snap
whose tolerance is narrower than the gap between its control's producible values
and its marks cannot be observed through the interface at all: the grid never
yields a value inside the tolerance, so there is nothing for the assertion to
catch and nothing for its negation to catch either. Step, interval and tolerance
are one relationship rather than three numbers, and whether that relationship is
alive is arithmetic — which is the Node suite's, not the browser's.

## Consequences

- A Balance of ±0.05 is unreachable by pointer, because the snap pulls those two
  positions onto centre. Reaching them means arrowing off centre or typing into
  nothing, and there is nothing to type into — so in practice it means arrowing.
  This is the whole cost of keeping the snap, it is paid by a listener who wants
  a hair off centre, and it is the reason dropping the snap entirely is a
  defensible position rather than a wrong one.
- The snap now moves two of the 41 values the Balance can produce, both onto
  centre, where it moved sixteen. That is the measurement the decision should be
  reversed on if it is ever reversed: if a later step makes the grid finer, the
  count goes up and the ±0.25 marks become worth having again.
- `panLabel` still calls anything inside four percent "Centre", and no value the
  controls can produce is now inside that window except `0` itself — the nearest
  neighbour is 0.05. The window is dead for every value a pointer or a keyboard
  can reach and live only for one arriving from storage, which is what it is
  for now. It is not widened to 0.05: a window that admits a value the interface
  cannot produce would be a reading waiting for a future step change to make
  false again.
- The tick row means less than it did. It was the drawn form of the marks a drag
  stopped on, and the reader and the pointer aimed at one set of tempos; now it
  is a scale, and a drag stops every five BPM regardless of where a tick falls.
  It is still worth drawing — it is how a slider says 30 to 300 — but nothing
  holds it to a snap any more, because there is no snap. `TEMPO_SNAP` is renamed
  `TEMPO_TICK_INTERVAL` and reduced from a frozen table to the one number that
  still does anything, so the tolerance beside it cannot be read as live. What
  holds it to the slider now is arithmetic rather than a shared constant: the
  step divides the interval, which the Node suite asserts.
- The tempo slider loses its drag flag and the four listeners that maintained it.
  The mix flag survives for the Balance alone, and the `keydown` listener that
  lowers it is still what it always was — the thing that keeps the first arrow
  key off centre from being pulled straight back onto it.
- `snapToMark` goes, replaced by a `snapBalance` that takes one argument and
  compares against one literal. Its generality is what made three snaps easy to
  add, and also what made two of them easy to leave broken: three frozen
  constants read as three deliberate configurations of one mechanism, and only
  one of them had ever been checked against the grid it applied to. A mechanism
  general enough to be configured is general enough to be misconfigured
  silently, and there is one snap left to configure. The float-dust guard it
  carried goes with it rather than being carried over — the dust came from
  scaling the value into percent to meet a mark table counted in percent, and a
  comparison made in the slider's own domain against a literal its value string
  parses to exactly has none to guard against.
- A stored Configuration holding an off-grid Level still loads and still plays
  what it holds. Repair normalises into range and does not round onto the step,
  so the same three-way disagreement is reachable from storage even though it is
  no longer reachable from the interface. That is accepted rather than closed:
  rounding on repair would move a value a listener may have set deliberately,
  and the only values that can now reach storage are already on the grid.
  `AGENTS.md`'s rule against migrations covers the rest — Polynome is
  unreleased, and the only browser holding `0.72` is a developer's.
- The rule the test enforces is about defaults, not about every value. The tempo
  can still hold 108, because the number input displays it exactly; what the
  test forbids is the application itself shipping a value its own slider cannot
  show. Extending it to every value would delete the BPM field's whole purpose.
- The two drag tests that asserted a tempo or a Level snap go, because there is
  nothing left for them to observe, and the arithmetic that would have caught
  their vacancy replaces them in the Node suite. The Balance keeps its browser
  tests: crossing the middle still has an observable snap, and it is the one
  place a real pointer is still doing something a unit test cannot describe.
- `index.html` cannot import, so the tempo slider's `step` attribute is still a
  literal there. It is held to `TEMPO_STEP` by a Node test that reads the shell
  as text, alongside its `min` — both are the grid, since the standard counts
  steps from the minimum. That is a cheaper place for it than the browser suite,
  which already holds the rendered control's bounds to `TEMPO_LIMIT`: the
  question is whether two files agree about a number, and answering it does not
  need a browser.

## Related

- [ADR-0003](0003-adopt-redesign-interaction-model.md) records that a tempo drag
  keeps the current run at its previous tempo and begins a new one on release.
  That is untouched: this decision changes which values a drag produces, not
  when the transport hears about them.
