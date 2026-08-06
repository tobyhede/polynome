import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalPattern,
  controlCounts,
  controlIndexAt,
  controls,
  DISPLAY_MODES,
  repairPattern,
} from "../grid.ts";

/**
 * The rhythm layers below are written by hand rather than through
 * `createConfiguration`, because this module sits beneath the one that repairs
 * and must be testable without it. Every field these functions read is present;
 * the fields a Configuration carries for other reasons are not.
 */
function layer({
  count = 4,
  subdivision = 1,
  displayMode = "beat",
  steps,
}: {
  count?: number;
  subdivision?: number;
  displayMode?: string;
  steps?: string[];
} = {}) {
  return {
    signature: { count, unit: 4 },
    subdivision,
    displayMode,
    steps: steps ?? canonicalPattern(count, subdivision),
  };
}

test("the canonical pattern marks the downbeat, the later units, and the pulses within", () => {
  assert.deepEqual(canonicalPattern(4, 1), ["primary", "secondary", "secondary", "secondary"]);
  assert.deepEqual(canonicalPattern(2, 3), [
    "primary",
    "tertiary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
});

/**
 * The count and the subdivision cannot be recovered from their product, which
 * is why the pattern is not derived from a length: these two grids are the same
 * six positions and different music.
 */
test("the same grid length gives different canonical patterns", () => {
  assert.notDeepEqual(canonicalPattern(2, 3), canonicalPattern(3, 2));
  assert.equal(canonicalPattern(2, 3).length, canonicalPattern(3, 2).length);
});

test("a Beat Mode control runs a signature unit and a Subdivision Mode control runs one position", () => {
  const beatModeControls = controls(layer({ count: 2, subdivision: 3 }));
  assert.equal(beatModeControls.length, 2);
  assert.deepEqual(
    beatModeControls.map(({ positions }) => positions),
    [
      [0, 1, 2],
      [3, 4, 5],
    ],
  );

  const subdivided = controls(layer({ count: 2, subdivision: 3, displayMode: "subdivision" }));
  assert.equal(subdivided.length, 6);
  assert.deepEqual(
    subdivided.map(({ positions }) => positions),
    [[0], [1], [2], [3], [4], [5]],
  );
});

test("a control shows the Step voice of the position its run begins on", () => {
  const steps = ["off", "primary", "tertiary", "secondary", "tertiary", "tertiary"];

  assert.deepEqual(
    controls(layer({ count: 2, subdivision: 3, steps })).map(({ voice }) => voice),
    ["off", "secondary"],
  );
  assert.deepEqual(
    controls(layer({ count: 2, subdivision: 3, displayMode: "subdivision", steps })).map(
      ({ voice }) => voice,
    ),
    steps,
  );
});

/**
 * A row can only break between signature units, so every control has to say
 * which one it falls in. A run never crosses a signature unit in either mode,
 * so no control belongs to two.
 */
test("every control names the signature unit it falls in", () => {
  assert.deepEqual(
    controls(layer({ count: 3, subdivision: 2 })).map(({ signatureUnit }) => signatureUnit),
    [0, 1, 2],
  );
  assert.deepEqual(
    controls(layer({ count: 3, subdivision: 2, displayMode: "subdivision" })).map(
      ({ signatureUnit }) => signatureUnit,
    ),
    [0, 0, 1, 1, 2, 2],
  );
});

test("a control index inverts the run a pattern position falls in", () => {
  const beatModeLayer = layer({ count: 2, subdivision: 3 });
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((position) => controlIndexAt(beatModeLayer, position)),
    [0, 0, 0, 1, 1, 1],
  );

  const subdivided = layer({ count: 2, subdivision: 3, displayMode: "subdivision" });
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((position) => controlIndexAt(subdivided, position)),
    [0, 1, 2, 3, 4, 5],
  );
});

/**
 * The playhead asks this every animation frame, including the frames before a
 * transport run has a position and after it stops. A layer with no position
 * under the transport has no control under it either.
 */
test("no pattern position under the transport means no control under it", () => {
  const rhythm = layer({ count: 2, subdivision: 3 });

  assert.equal(controlIndexAt(rhythm, null), null);
  assert.equal(controlIndexAt(rhythm, undefined), null);
});

test("the index a control is at is the index its own run reports back", () => {
  for (const displayMode of DISPLAY_MODES) {
    const rhythm = layer({ count: 3, subdivision: 4, displayMode });

    for (const [index, { positions }] of controls(rhythm).entries()) {
      for (const position of positions) {
        assert.equal(controlIndexAt(rhythm, position), index);
      }
    }
  }
});

test("the row counts follow the run length rather than the mode", () => {
  assert.deepEqual(controlCounts(layer({ count: 7, subdivision: 4 })), {
    signatureUnits: 7,
    controlsPerSignatureUnit: 1,
  });
  assert.deepEqual(controlCounts(layer({ count: 7, subdivision: 4, displayMode: "subdivision" })), {
    signatureUnits: 7,
    controlsPerSignatureUnit: 4,
  });
});

/**
 * Every control the counts promise is a control that exists, at every grid the
 * domain offers. A row layout that fits
 * `signatureUnits × controlsPerSignatureUnit` boxes and found a different
 * number of controls in them would leave a ragged row.
 */
test("the row counts multiply out to the controls there are", () => {
  for (const displayMode of DISPLAY_MODES) {
    for (let count = 1; count <= 16; count += 1) {
      for (let subdivision = 1; subdivision <= 5; subdivision += 1) {
        const rhythm = layer({ count, subdivision, displayMode });
        const { signatureUnits, controlsPerSignatureUnit } = controlCounts(rhythm);

        assert.equal(signatureUnits * controlsPerSignatureUnit, controls(rhythm).length);
      }
    }
  }
});

test("repair fills only the positions a stored pattern leaves", () => {
  assert.deepEqual(repairPattern(["off", "primary"], 2, 3), [
    "off",
    "primary",
    "tertiary",
    "secondary",
    "tertiary",
    "tertiary",
  ]);
});

test("repair discards a pattern the grid has no room for", () => {
  assert.deepEqual(repairPattern(["off", "off", "off", "off", "off"], 2, 1), ["off", "off"]);
});

/**
 * A stored pattern is whatever a previous release, another tab, or a hand-edited
 * storage entry left behind, so a voice it offers is trusted only when it is one
 * of the four. An inherited object name is the case a plain lookup would let
 * through.
 */
test("repair replaces a voice that is not one of the four", () => {
  assert.deepEqual(repairPattern(["constructor", "toString", "__proto__"], 3, 1), [
    "secondary",
    "secondary",
    "secondary",
  ]);
  assert.deepEqual(repairPattern(null, 2, 1), ["primary", "secondary"]);
});
