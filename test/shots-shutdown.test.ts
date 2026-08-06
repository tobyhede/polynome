import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { stopChild } from "../scripts/shots-shutdown.ts";

/*
 * Long enough that a machine under the rest of the suite still gets its child
 * scheduled inside it, short enough that the one test which does wait it out
 * costs a quarter of a second. Nothing else waits on it.
 */
const GRACE_MS = 250;

/*
 * A grace no test reaches, used where reaching it is the failure. It is longer
 * than the timeouts below, so a shutdown that sat out its full grace fails on
 * the runner's clock with a message naming the test, rather than passing slowly.
 */
const UNREACHED_GRACE_MS = 10_000;

/*
 * Every test here can hang rather than fail — that is the defect it exists for —
 * so each carries the runner's own timeout. Far above anything a healthy run
 * needs, and its only job is to turn a stuck suite into a red one.
 */
const TIMEOUT_MS = 5_000;

// Installs the handler before saying it is ready, because a SIGTERM that lands
// in the gap is honoured by the default disposition and the child dies on the
// first signal — which is the test passing for exactly the wrong reason.
const IGNORES_SIGTERM = 'process.on("SIGTERM", () => {});';
const READY = 'setInterval(() => {}, 1000); process.stdout.write("ready\\n");';

/**
 * Real children rather than a stub, because what is under test is what a process
 * does with a signal, and only a process decides that: a fake that emits `exit`
 * when it is told to would be asserting the test's own manners back at itself.
 * Node running a one-line program is the smallest thing that can hold a signal
 * disposition of its own. The child announces itself on stdout and is waited
 * for, so the shutdown under test always meets a process that is up.
 *
 * The SIGKILL registered here is not the one being tested: it is the cleanup for
 * a test that failed or timed out partway, whose child would otherwise outlive
 * the run and hold its stdout pipe — and with it the runner's event loop — open.
 */
async function spawnChild(t, script) {
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => {
    child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  return child;
}

/**
 * SIGTERM is a request. A child that installs a handler and declines it never
 * emits `exit`, so a shutdown waiting on that event alone waits for the length
 * of the run — a screenshot job hung in CI with nothing to read. The grace ends
 * that, and what ends it is SIGKILL, which no handler sees.
 */
test("a child that ignores SIGTERM is killed once its grace is up", {
  timeout: TIMEOUT_MS,
}, async (t) => {
  const child = await spawnChild(t, `${IGNORES_SIGTERM} ${READY}`);
  // Subscribed before the shutdown runs, because the exit it is waiting for
  // can happen inside it: a listener attached afterwards would be waiting for
  // an event that has already gone by.
  const exited = once(child, "exit");
  const started = Date.now();

  await stopChild(child, GRACE_MS);

  // A little tolerance, because the timer and the clock it is measured against
  // are not the same one and it can fire a fraction before its deadline. The
  // margin only has to be smaller than an immediate kill, which is what this
  // rules out.
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= GRACE_MS - 20, `settled after ${elapsed}ms, without waiting the grace`);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL", "the child was still running when the shutdown settled");
});

/**
 * The grace is a bound, not a delay: a child that goes when it is asked is not
 * waited on any longer, and is never killed. Proven with a grace this test could
 * not reach, so a shutdown that had become a fixed pause would fail on the
 * runner's timeout rather than pass a little slower.
 */
test("a child that honours SIGTERM is not waited on and not killed", {
  timeout: TIMEOUT_MS,
}, async (t) => {
  const child = await spawnChild(t, READY);
  const exited = once(child, "exit");

  await stopChild(child, UNREACHED_GRACE_MS);

  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM", "the child was escalated to SIGKILL despite going quietly");
});

/**
 * A child that has already gone cannot emit the event a shutdown would wait on,
 * so this is the case that hangs first and the reason the check comes before
 * anything is sent. `startServer` reaches it whenever the server dies during
 * startup and the failure path stops what it could not wait for.
 */
test("a child that has already gone settles without waiting", {
  timeout: TIMEOUT_MS,
}, async (t) => {
  const child = await spawnChild(t, READY);
  child.kill("SIGTERM");
  await once(child, "exit");
  assert.equal(child.signalCode, "SIGTERM", "the child was meant to be gone before the shutdown");

  // Settling is the assertion. There is nothing left to observe about a process
  // that has already been reaped, so what fails here is the runner's timeout,
  // which is why the grace above it is one this test cannot reach.
  await stopChild(child, UNREACHED_GRACE_MS);
});
