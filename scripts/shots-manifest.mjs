// The manifest is what lets a filtered run stand on the shots a previous run
// took. Kept apart from `shots.mjs` so it can be exercised without importing
// Playwright or starting a server: everything here is filesystem and ordering.

import { readFile } from "node:fs/promises";

/**
 * A filtered run re-shoots part of the matrix, so it keeps the shots it did not
 * regenerate and folds the new ones in. Only a full run starts from empty.
 *
 * A missing manifest is the ordinary first run and keeps nothing. Every other
 * failure — unparsable JSON, a truncated write, an unreadable file — is left to
 * surface: the alternative silently drops the shots the run exists to preserve.
 * This is read before the capture begins, so failing here costs no work.
 */
export async function priorShots(directory, regenerated) {
  const path = `${directory}/manifest.json`;
  let previous;
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not read the previous manifest at ${path}`, { cause: error });
  }
  return previous.shots.filter((shot) => !regenerated.has(`${shot.state}__${shot.profile}`));
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
