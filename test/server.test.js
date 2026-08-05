import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../server.mjs", import.meta.url));

/*
 * Generous, because these are the only two waits in the suite that are not
 * bounded by something this process controls: a spawned Node has to boot, and a
 * file change has to travel through the platform's watcher. Both are quick when
 * the machine is idle and neither is quick when the rest of the suite is running
 * beside them. The numbers are here to make a hang fail rather than to hold the
 * behaviour to a schedule, so they are far above anything a healthy run needs.
 */
const START_TIMEOUT_MS = 20_000;
const EVENT_TIMEOUT_MS = 20_000;

/*
 * Short, because unlike the two above this one is bounded by the signal that
 * caused it: a Node process with no SIGTERM handler has nothing left to do when
 * the kernel delivers it. A child still here after this long is one that is not
 * going, and the only thing worth doing about that is failing.
 */
const EXIT_TIMEOUT_MS = 5_000;

/**
 * The dev server is given a tree of its own rather than the repository, because
 * proving that a change reloads means changing a file, and a test that edits the
 * source it was launched from would be rewriting the thing under test while the
 * suite runs.
 *
 * The server is copied in rather than pointed at this directory: it serves and
 * watches the directory it is *in*, resolved from its own module URL, so a
 * working directory would move neither.
 */
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "polynome-server-"));
  await copyFile(server, join(root, "server.mjs"));
  await writeFile(join(root, "index.html"), "<!doctype html><body><main></main></body></html>");
  await writeFile(join(root, "styles.css"), "body { color: #fff }\n");
  await writeFile(join(root, "app.js"), "export const ready = true;\n");
  return root;
}

/**
 * Started on whatever port the operating system has free, and waited on by the
 * line the server prints once it is listening — which is also where the port it
 * was given comes from. Choosing one here instead would mean checking a port was
 * free and then binding it a moment later, and under a loaded machine that gap
 * is long enough for something else to take it.
 */
async function startServer({ root, reload }) {
  const child = spawn("node", [join(root, "server.mjs"), ...(reload ? ["--reload"] : [])], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const origin = await new Promise((resolve, reject) => {
    const failed = setTimeout(
      () => reject(new Error(`server did not print that it was listening. stderr: ${stderr}`)),
      START_TIMEOUT_MS,
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const listening = /Polynome running at (http:\/\/localhost:(\d+))/.exec(stdout);
      if (!listening) return;
      clearTimeout(failed);
      resolve(`http://127.0.0.1:${listening[2]}`);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`server exited with ${code}. stderr: ${stderr}`)),
    );
  }).catch(async (failure) => {
    // Nothing was returned for the caller to stop, and a child still holding its
    // pipes open keeps this process alive long past the failure it came here to
    // report. The stop is allowed to fail quietly because the diagnosis worth
    // reading is the one already on its way out.
    await stopChild(child).catch(() => {});
    throw failure;
  });

  return { child, origin };
}

/**
 * A signal is a request, and `kill` returns once it has been made rather than
 * once it has been honoured, so the exit is something to wait for rather than
 * something to assume.
 */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve, reject) => {
    const failed = setTimeout(
      () => reject(new Error(`server pid ${child.pid} outlived SIGTERM by ${EXIT_TIMEOUT_MS}ms`)),
      EXIT_TIMEOUT_MS,
    );
    child.once("exit", () => {
      clearTimeout(failed);
      resolve();
    });
  });
  child.kill("SIGTERM");
  return exited;
}

/**
 * The directory goes after the process that was serving out of it. A reloading
 * server has a watcher on this exact tree, and there is nothing to be gained
 * from racing it to the deletion.
 */
async function stopServer(running, root) {
  if (running) await stopChild(running.child);
  if (root) await rm(root, { recursive: true, force: true });
}

/**
 * Reads the event stream until it has seen as many events as the caller is
 * waiting on, so a caller waits on the events themselves rather than on a
 * duration chosen to be longer than they should take.
 *
 * The kinds are named for the reporting and not for the counting: anything the
 * server sends counts towards the total, so a run that produced the wrong event
 * fails on the caller's comparison — which says what arrived — instead of on a
 * deadline, which could only say that something did not.
 */
async function readEvents(origin, awaited, act) {
  const abort = new AbortController();
  const response = await fetch(`${origin}/dev/reload`, { signal: abort.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const opening = await reader.read();
  const handshake = decoder.decode(opening.value);

  await act();

  const events = [];
  const outstanding = () =>
    `waiting for ${awaited.join(", ")}, having seen ${events.length ? events.join(", ") : "nothing"}`;

  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    abort.abort();
  }, EVENT_TIMEOUT_MS);
  try {
    while (events.length < awaited.length) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (line.startsWith("event: ")) events.push(line.slice(7).trim());
      }
    }
  } catch (cause) {
    // The deadline reaches the read as a DOM exception carrying no message at
    // all, and a server that died reaches it as a socket error naming neither
    // this stream nor what was being waited on. Both are worth telling apart,
    // and neither says anything on its own.
    if (expired) throw new Error(`gave up after ${EVENT_TIMEOUT_MS}ms ${outstanding()}`, { cause });
    throw new Error(`the event stream broke while ${outstanding()}: ${cause.message}`, { cause });
  } finally {
    clearTimeout(deadline);
    abort.abort();
  }
  // Nothing ends this stream while the server is up, so a read that ran out is
  // a server that has gone rather than a wait that is over.
  if (events.length < awaited.length)
    throw new Error(`the server closed the event stream while ${outstanding()}`);
  return { handshake, events };
}

test("the reloading server injects its client and reports what changed", async () => {
  const root = await temporaryRoot();
  let running = null;
  try {
    running = await startServer({ root, reload: true });

    const page = await (await fetch(`${running.origin}/`)).text();
    assert.match(page, /EventSource\("\/dev\/reload"\)/);
    // Injected into the response and not into the file it was read from, which
    // is what keeps it out of anything a build later copies.
    assert.doesNotMatch(await readFile(join(root, "index.html"), "utf8"), /EventSource/);

    const styled = await readEvents(running.origin, ["css"], async () => {
      await writeFile(join(root, "styles.css"), "body { color: #000 }\n");
    });
    assert.equal(styled.handshake.trim(), ": open");
    assert.deepEqual(styled.events, ["css"]);

    const scripted = await readEvents(running.origin, ["reload"], async () => {
      await writeFile(join(root, "app.js"), "export const ready = false;\n");
    });
    assert.deepEqual(scripted.events, ["reload"]);
  } finally {
    await stopServer(running, root);
  }
});

/**
 * The property that keeps the dev tooling out of the bytes anything else sees:
 * `npm start` is what `playwright.config.js` runs and what a static host would
 * mirror, and neither should be handed a page that opens a socket back to a
 * watcher that is not there.
 */
test("the plain server serves the page untouched and has no reload endpoint", async () => {
  const root = await temporaryRoot();
  let running = null;
  try {
    running = await startServer({ root, reload: false });

    const page = await (await fetch(`${running.origin}/`)).text();
    assert.doesNotMatch(page, /EventSource/);
    assert.doesNotMatch(page, /dev\/reload/);

    const reload = await fetch(`${running.origin}/dev/reload`);
    assert.equal(reload.status, 404);
  } finally {
    await stopServer(running, root);
  }
});
