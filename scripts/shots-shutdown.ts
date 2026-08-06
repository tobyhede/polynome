// How a shots run stops the server it started. Kept apart from `shots.ts` for
// the same reason the manifest is, only more sharply: `shots.ts` runs the whole
// capture at import, so nothing declared inside it can be reached from a test
// without a browser, a free port and the full matrix of screenshots.

import type { ChildProcess } from "node:child_process";

/**
 * How long a child is given to honour SIGTERM before the decision is taken away
 * from it. Generous for the server this stops, which closes its listener on the
 * first signal and is gone in milliseconds; the number is here to bound a child
 * that never will, not to hold a healthy one to a schedule.
 */
export const SHUTDOWN_GRACE_MS = 2_000;

/**
 * SIGTERM is a request, and a request can be declined. A child that installs a
 * handler and ignores it, or that wedges partway through its own cleanup, never
 * emits `exit` — so a promise waiting on that event alone waits for the length
 * of the run, which in CI is a screenshot job hung with nothing to read. This
 * bounds that. The child is asked first, because a server given the chance
 * closes its connections and its listener rather than dropping them, and once
 * the grace is up it is killed instead: SIGKILL reaches no handler, so settling
 * beside it is a claim about a process that is already gone rather than one that
 * has agreed to go.
 *
 * `clearTimeout` rather than `unref` on the escalation. Unreferencing stops a
 * timer holding the event loop open but not from firing, so a child that went on
 * the first signal would still be sent a SIGKILL nothing is waiting on; clearing
 * says the escalation is over, which is the thing that is actually true, and
 * gets the loop released as a consequence rather than as the whole point.
 *
 * `settle`, not `resolve`: this ends on either of two paths and only one of them
 * is the child resolving to go. `shots.ts`, where the shutdown used to live, has
 * a second reason — `resolve` is node:path's there, and shadowing it would hand
 * any later path work in that scope the wrong binding without a word of
 * complaint.
 */
export function stopChild(child: ChildProcess, graceMs = SHUTDOWN_GRACE_MS) {
  return new Promise<void>((settle) => {
    // Asked before anything is sent, because a child that has already been
    // reaped is the one case where no signal produces an event to wait for.
    if (child.exitCode !== null || child.signalCode !== null) return settle();
    const escalation = setTimeout(() => {
      child.kill("SIGKILL");
      settle();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(escalation);
      settle();
    });
    child.kill("SIGTERM");
  });
}
