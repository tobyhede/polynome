# Refine defaults and sliders

Polynome opens at 120 BPM. Its first-run examples are `4/4 8ths`, one 4/4 Beat
Mode rhythm at Subdivision two, and `4/4 Triplets`, the same grid at Subdivision
three. Both examples hold 120 BPM. They replace the `4/4` and `4/4 + 3/4`
examples recorded in
[ADR-0010](0010-seed-example-presets-into-storage.md); the seeding mechanism and
their status as ordinary renameable, replaceable and deletable Presets do not
change.

The tempo slider moves in five-BPM intervals. Its separate decrement and
increment controls still move by one BPM, and the number field still accepts an
exact BPM, so coarse movement does not remove fine adjustment. Rhythm Level and
Balance sliders move by `0.05`; Balance also marks the zero midpoint of its
range, between hard left and hard right.

The examples are refinements rather than stored-shape migrations. Polynome is
still pre-release, so the Preset key moves from `polynome-presets-v2` to
`polynome-presets-v3` and the old key is retired. The current Configuration key
stays `polynome-configuration-v2` because its stored shape did not change.

## Consequences

- A fresh Configuration is no longer identical to either seeded Preset: it has
  one 4/4 Beat Mode rhythm at Subdivision one, while the examples demonstrate
  binary and ternary subdivision.
- The example catalogue demonstrates two pulse densities of one rhythm rather
  than polymeter. Polymeter remains available by adding a rhythm layer; it is no
  longer a first-run Preset.
- Pointer and keyboard use of the tempo slider moves in five-BPM steps. The
  one-BPM buttons and exact number field remain the fine controls.
- Level exposes 21 selectable values and Balance exposes 41. Balance's midpoint
  marker is decorative and does not add a value or event.
- Existing developer Presets under the v2 key are discarded rather than copied
  into v3. This is retirement, not a migration, under the pre-release policy in
  [`AGENTS.md`](../../AGENTS.md).
