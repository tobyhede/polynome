# Store a rhythm layer's display mode in the Configuration

Every rhythm layer carries a `displayMode` of `beat` or `subdivision`, and it
lives in the Configuration beside that layer's meter, subdivision and pattern
rather than in the interface state `app.js` holds in module scope. It is
therefore repaired from storage like any other field, written back to storage,
carried into a Preset, and compared by `sameRhythm`. Beat Mode is the default and
the value repair falls back to, so the default Configuration opens in it and a
Configuration saved before this field existed opens in it too.

The alternative was `openRhythms` and its neighbours: a `Set` of rhythm
identifiers in module scope, which is where the interface already keeps which
settings pane is open and which subdivision menu is showing. Those are all states
a reload is expected to clear, and this one is not. A listener who has taken a
layer at subdivision five down to four Beat controls has said how they want to
work on it, and finding twenty controls again on the next visit is the same kind
of loss as finding the tempo back at 96. Keeping it there and persisting it
anyway would mean a second stored value keyed by rhythm identifiers — which
repair regenerates whenever they do not match the shape this module issues — so
the reference would break exactly when a Configuration arrived from storage
slightly wrong, which is the case storage exists to survive.

It is in the Configuration because it is a property of the rhythm layer, and the
Configuration is the value a Preset holds a snapshot of. That it is compared, and
therefore saved, is the consequence of that placement rather than a separate
choice, and the first consequence below is where its cost is paid.

## Consequences

- Toggling the view marks the Configuration unsaved and lights the `+ Save` chip,
  because `sameRhythm` compares the field. A listener who only wanted to look at
  a layer differently is offered a save they did not ask for. That is the price
  of the view surviving a reload, and it is paid in a chip taking the accent
  rather than in anything changing under them.
- The same comparison clears the Preset selection. Two Presets differing only in
  their view are two different Presets, and one recalled while the interface is
  in the other view applies its own — the view is part of what a Preset is a
  snapshot of, so recalling one restores how it was being looked at. The preset
  panel's notation summary does not mention the view, so those two Presets read
  identically in the list and only their names tell them apart.
- `set-display-mode` takes the `update-configuration` consequence, the narrowest
  one there is: nothing audible depends on the view, so a run in progress is
  neither restarted nor repatched. Changing the view while playing is exactly as
  quiet as changing a meter denominator.
- Repair replaces an unrecognised value with `beat` as it does everywhere else.
  Nothing migrates a Configuration stored before the field existed, per the rule
  in `AGENTS.md`: an absent field is an unrecognised value and gets the default.
- The interface says "Beat 1" while `CONTEXT.md` tells the vocabulary to avoid
  "beat" for a signature unit. That entry is amended rather than the label
  changed: a listener counts a bar in beats, and "Signature unit 1" on a control
  would be the glossary talking to itself.

## Related

- [ADR-0012](0012-reset-the-pattern-on-a-meter-or-subdivision-edit.md) decides
  what a Meter-numerator or Subdivision edit does to the pattern, which is what
  makes a Beat control's voice describe its whole beat.
