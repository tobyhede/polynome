/**
 * Reads the stored value, adopting whatever a previous release left under an
 * older key name so that renaming the key does not silently reset a user's
 * settings. Superseded names hold a value this version can still read and are
 * migrated once; retired names hold shapes it cannot and are only discarded.
 *
 * Storage is supplied by the caller, both to keep this free of any host
 * environment and because a browser may refuse it outright — every method can
 * throw, and none of them may take the page down with it.
 */
export function readStoredValue({ storage, key, supersededKeys = [], retiredKeys = [] }) {
  try {
    for (const retired of retiredKeys) storage.removeItem(retired);

    let raw = storage.getItem(key);
    for (const superseded of supersededKeys) {
      if (raw === null) {
        const candidate = storage.getItem(superseded);
        if (candidate !== null) {
          raw = candidate;
          storage.setItem(key, candidate);
        }
      }
      storage.removeItem(superseded);
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * A slider drag emits a value per pointer move, and writing every one of them
 * to storage synchronously blocks the gesture it is trying to record. Collect
 * the values instead and write only the latest one once the gesture settles,
 * leaving `flush` for the moments where the page may not survive the wait.
 *
 * Timer functions are supplied by the caller so this stays free of any host
 * environment and can be driven deterministically by tests.
 */
export function createPersistence({ write, delay, setTimer, clearTimer }) {
  let timer = null;
  let pending = null;

  function writePending() {
    if (pending === null) return;
    const { value } = pending;
    pending = null;
    try {
      write(value);
    } catch {
      // The metronome remains usable when storage is unavailable.
    }
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  // A box keeps a legitimately null or undefined value distinguishable from
  // having nothing to write.
  function schedule(value) {
    pending = { value };
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      writePending();
    }, delay);
  }

  function flush() {
    cancelTimer();
    writePending();
  }

  return { schedule, flush };
}
