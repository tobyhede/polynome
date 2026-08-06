// The manifest is what lets a filtered run stand on the shots a previous run
// took. Kept apart from `shots.ts` so it can be exercised without importing
// Playwright or starting a server: everything here is filesystem and ordering.

import { readFile } from "node:fs/promises";

/**
 * A missing manifest is the ordinary first run, so it comes back as nothing
 * rather than as a manifest. Every other failure — unparsable JSON, a truncated
 * write, an unreadable file — is reported against the path, because the path is
 * what makes it actionable, and reported rather than swallowed, because the
 * alternative silently drops the shots the run exists to preserve. This is read
 * before the capture begins, so failing here costs no work.
 *
 * JSON that parses is not yet a manifest. A file with no `shots` array is
 * unreadable in the only sense that matters to the caller, so it fails the same
 * way and through the same message; left to the caller's filter it would
 * surface as a missing method on a value nobody upstream ever sees. Nothing
 * beyond that array is checked, so this returns what was parsed rather than
 * anything claiming a fuller shape.
 *
 * The check also disambiguates the empty return: a manifest holding the literal
 * `null` parses, fails it, and throws, so `undefined` can only mean ENOENT.
 */
async function parseManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed?.shots)) throw new TypeError("The manifest holds no shots array");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Could not read the previous manifest at ${path}`, { cause: error });
  }
}

/**
 * A filtered run re-shoots part of the matrix, so it keeps the shots it did not
 * regenerate and folds the new ones in. Only a full run starts from empty.
 *
 * A shot is kept only if the matrix still declares both its state and its
 * profile. Clearing the directory is the full run's job, so a filtered one is
 * the only thing standing between a renamed or deleted state and a manifest
 * that still names it, and what it hands back is treated downstream as an
 * equal member of the matrix. `inMatrixOrder` is where that bites: it ranks by
 * `indexOf`, which answers -1 for a name the matrix does not hold, so one
 * undeclared shot both appears and drags the reading order of every other card
 * out of shape — with nothing raised, because sorting is the failure.
 */
export async function priorShots(directory, regenerated, stateNames, profileNames) {
  const path = `${directory}/manifest.json`;
  const previous = await parseManifest(path);
  if (!previous) return [];
  return previous.shots.filter(
    (shot) =>
      stateNames.includes(shot.state) &&
      profileNames.includes(shot.profile) &&
      !regenerated.has(`${shot.state}__${shot.profile}`),
  );
}

/**
 * Sorts shots into the order the matrix declares rather than the order they
 * were captured or recovered, so a filtered run's kept and fresh shots
 * interleave into the same reading order a full run produces.
 */
export function inMatrixOrder(shots, stateNames, profileNames) {
  const rank = (shot) =>
    stateNames.indexOf(shot.state) * profileNames.length + profileNames.indexOf(shot.profile);
  return [...shots].sort((left, right) => rank(left) - rank(right));
}
