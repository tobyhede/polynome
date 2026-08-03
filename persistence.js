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
