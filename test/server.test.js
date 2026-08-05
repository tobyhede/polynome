import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
 * A port nothing is listening on, taken by opening and closing a socket. Two
 * runs could in principle be handed the same one, which is why the port is
 * asked for immediately before it is used rather than at the top of the file.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Started and waited on by the line it prints, so the test proceeds when the
 * server says it is listening rather than after a guessed interval.
 */
async function startServer({ root, reload }) {
  const port = await freePort();
  const child = spawn("node", [join(root, "server.mjs"), ...(reload ? ["--reload"] : [])], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const failed = setTimeout(
      () => reject(new Error("server did not print that it was listening")),
      START_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!chunk.includes("Polynome running")) return;
      clearTimeout(failed);
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });

  return { child, origin: `http://127.0.0.1:${port}` };
}

async function stopServer(running, root) {
  running?.child.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
}

/**
 * Reads the event stream until it has seen as many events as asked for, so a
 * caller waits on the events themselves rather than on a duration chosen to be
 * longer than they should take.
 */
async function readEvents(origin, count, act) {
  const abort = new AbortController();
  const response = await fetch(`${origin}/dev/reload`, { signal: abort.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const opening = await reader.read();
  const handshake = decoder.decode(opening.value);

  await act();

  const events = [];
  const deadline = setTimeout(() => abort.abort(), EVENT_TIMEOUT_MS);
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (line.startsWith("event: ")) events.push(line.slice(7).trim());
      }
    }
  } finally {
    clearTimeout(deadline);
    abort.abort();
  }
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

    const styled = await readEvents(running.origin, 1, async () => {
      await writeFile(join(root, "styles.css"), "body { color: #000 }\n");
    });
    assert.equal(styled.handshake.trim(), ": open");
    assert.deepEqual(styled.events, ["css"]);

    const scripted = await readEvents(running.origin, 1, async () => {
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
