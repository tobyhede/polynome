# Reset the pattern to the canonical voices on a Meter or Subdivision edit

`canonicalSteps` and `resizeSteps` are named below by function and file. Both
moved to `grid.js` as `canonicalPattern` and `repairPattern` in
[ADR-0013](0013-advance-every-grid-control-through-one-edit.md). Everything this
decision asserts about them still holds; only their address changed.

A `set-meter-count` or `set-subdivision` edit writes the canonical pattern for
the grid it produces — `primary` on the downbeat, `secondary` on every later
signature unit, `tertiary` on the pulses Subdivision adds within one — and
discards whatever voices the layer held. A `set-meter-unit` edit still preserves
the pattern exactly, because a denominator changes how the same grid is written
and not what it is.

This reverses what `resizeSteps` did, which was to keep every voice at the index
it already occupied and fill only what the new length added. That behaviour was
never a recorded decision; it was a function and a test named after it, which is
part of why it is worth writing down what replaced it.

The reason it is worth reversing is that an index is not a position in the music.
Position four of a grid at three pulses per unit is the second pulse of the
second unit; position four of a grid at five is the fifth pulse of the first.
Carrying a voice across by index preserves the array and loses the rhythm, and it
leaves the grid in an arrangement nobody chose — the downbeat still `primary`
because it happens to be index zero, and everything after it wherever the old
count left it. A listener who changes the subdivision is asking a different
question of the same meter, and the canonical pattern is the answer that question
has when it is asked for the first time.

Beat Mode is what made this visible rather than what made it true. A Beat control
shows the voice of the position its unit begins on and writes the whole unit, so
a grid whose interior voices are the residue of a previous subdivision is a grid
whose Beat controls cannot describe it. Under the canonical pattern the two
agree from the start, and the only thing that puts a unit out of step with its
own Beat control is a listener editing a pattern position by hand — which is
[ADR-0011](0011-store-the-display-mode-in-the-configuration.md)'s Subdivision
Mode doing exactly what it is for.

## Consequences

- A programmed pattern is lost when the meter numerator or the subdivision
  changes, and there is no undo. This is the whole cost of the decision and it is
  a real one: a listener who has spent a minute placing voices across a bar and
  then reaches for the subdivision to hear the same figure in triplets gets the
  canonical pattern instead. What is available today is saving a Preset first,
  which is one act and not an obvious one. A confirmation, an undo, or a
  best-effort remap are all separate decisions, and a remap would first have to
  answer what the second pulse of four becomes when there are three.
- Nothing is lost when the denominator changes, which is what keeps that edit's
  `update-configuration` consequence honest: it changes notation, and notation
  only.
- Repair fills the positions a stored pattern leaves from the same canonical
  pattern, so a grid reached from storage and a grid reached from an edit hold
  the same voices. Two answers to what the untouched pattern is would have made
  where a rhythm layer came from decide what it sounds like. Repair still keeps
  every voice a stored pattern does supply — it fills gaps and overrides nothing,
  which is what makes a short or outdated stored pattern recoverable rather than
  replaced.
- The canonical pattern is one function, `canonicalSteps`, and the edits and
  repair both go through it. Changing what "untouched" means is a change in one
  place.
- `resizeSteps` no longer takes a length. It takes the meter count and the
  subdivision, because the canonical pattern it fills from cannot be derived from
  their product: four units of one and one unit of four are the same length and
  different music.
