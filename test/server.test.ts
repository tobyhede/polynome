import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Importing the module has to be free of side effects for these to be usable at
// all: a server that bound a port on import would take one from whatever else is
// running, and would do it before the first test had said what it wanted.
import {
  announceChange,
  boundHost,
  createDevServer,
  reloadRequested,
  servedRoot,
  startupLines,
} from "../server.ts";

const server = fileURLToPath(new URL("../server.ts", import.meta.url));

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
 * The tree holds the files to be served and nothing else. The server itself is
 * run from where it lives and told which directory to serve, which is what keeps
 * its own imports resolving against the repository: it now needs `esbuild` on
 * every `.ts` request, and nothing under the system temporary directory is
 * somewhere Node would walk up from and find it.
 */
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "polynome-server-"));
  await writeFile(join(root, "index.html"), "<!doctype html><body><main></main></body></html>");
  await writeFile(join(root, "styles.css"), "body { color: #fff }\n");
  await writeFile(join(root, "app.js"), "export const ready = true;\n");
  // Two modules rather than one, because half of what stripping has to get right
  // is what it does not touch: `typed.ts` still has to ask this server for
  // `unit.ts` afterwards. `unit.ts` imports nothing, which is what lets it be
  // evaluated — see `evaluateModule`. `broken.ts` is the one that does not parse,
  // and it is written here beside the rest so that everything this directory
  // holds is described in one place.
  await writeFile(
    join(root, "typed.ts"),
    'import { unit } from "./unit.ts";\n' +
      "export const bpm: number = 120;\n" +
      "export type Beat = { at: number };\n" +
      "export const seconds = (beats: number): number => beats * unit;\n",
  );
  await writeFile(join(root, "unit.ts"), "export const unit: number = 0.5;\n");
  await writeFile(join(root, "broken.ts"), "export const oops = ;\n");
  return root;
}

/**
 * Evaluates a served module the way the page would, which is the only way to ask
 * what it does rather than what it says. A data URL is the one module specifier
 * this process can build out of a string, and it carries the limitation that
 * decided the fixtures above: nothing relative resolves from it, so only a module
 * that imports nothing can be run this way.
 */
function evaluateModule(code) {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return import(`data:text/javascript;charset=utf-8;base64,${encoded}`);
}

/**
 * What a listener says it bound. `address()` covers a Unix domain socket as well
 * as a TCP one, so its type carries the string form that has neither a host nor a
 * port; every listener in this file is bound over TCP, where the object form is
 * the only one that comes back. Saying so once keeps the narrowing out of the
 * tests, which are about where a bind landed rather than about which kinds of
 * address a server can have.
 */
function boundTo(listener: { address(): string | AddressInfo | null }): AddressInfo {
  return listener.address() as AddressInfo;
}

/**
 * Started on whatever port the operating system has free, and waited on by the
 * line the server prints once it is listening — which is also where the port it
 * was given comes from. Choosing one here instead would mean checking a port was
 * free and then binding it a moment later, and under a loaded machine that gap
 * is long enough for something else to take it.
 */
async function startServer({ root, reload = false, env = {} }) {
  const child = spawn("node", [server, `--root=${root}`, ...(reload ? ["--reload"] : [])], {
    // Passed through rather than scrubbed. `HOST` used to be emptied out of it,
    // because this server read that variable and a developer who had exported one
    // would otherwise have had every server here bind wherever they were
    // pointing. Nothing reads it now — see ADR-0023 — so there is nothing to
    // empty, and one case below hands one in on purpose to say so.
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const origin = await new Promise((resolve, reject) => {
    const failed = setTimeout(
      () =>
        reject(
          new Error(
            `server did not print that it was listening. stdout: ${stdout} stderr: ${stderr}`,
          ),
        ),
      START_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // A bind wider than loopback is failed on the moment it is announced rather
      // than waited out. The deadline above would reach the same verdict twenty
      // seconds later, and it would spend those twenty seconds serving the tree
      // this test wrote to everything on the network — which is the one thing
      // this suite must not do while finding out that it can happen.
      const wide = /Polynome running at http:\/\/(?!localhost)(\S+)/.exec(stdout);
      if (wide) {
        clearTimeout(failed);
        reject(new Error(`the server announced a bind on ${wide[1]} rather than loopback`));
        return;
      }
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

  // Everything the child has said so far, read as a function because it goes on
  // saying things after this returns. It is what lets a case assert on the line
  // that was printed as well as on the fact that one was.
  return { child, origin, output: () => stdout };
}

/**
 * A signal is a request, and `kill` returns once it has been made rather than
 * once it has been honoured, so the exit is something to wait for rather than
 * something to assume.
 */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve, reject) => {
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
  // A 404 or a 500 still answers with a body, and a body is still a readable
  // stream, so nothing below notices that no stream was ever opened. What is
  // read is the error page: it becomes the handshake, the next read runs out,
  // and every caller is told the server closed the event stream while waiting —
  // which names neither the status nor the fact that this endpoint is not there
  // any more, and points the reader at the watcher rather than at the route. An
  // error status that does not end its body is worse again, since then the only
  // thing left to end the read is the twenty-second deadline.
  //
  // The request is abandoned before throwing, because an error raised past an
  // unread body leaves the connection open and this process holding it.
  if (!response.ok) {
    abort.abort();
    throw new Error(`the event stream answered ${response.status} rather than opening`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const opening = await reader.read();
  const handshake = decoder.decode(opening.value);

  await act();

  const events = [];
  // What is still owed, as opposed to what has turned up. One save can reach the
  // watcher as more than one batch, and the debounce only collapses the ones
  // inside its window — so an event from the write before this one can arrive on
  // this stream, ahead of the event this read came for. That is the filesystem's
  // doing rather than the server's, and waiting for the kind that was asked for
  // is the difference between tolerating it and failing on it.
  const owed = [...awaited];
  const outstanding = () =>
    `waiting for ${owed.join(", ")}, having seen ${events.length ? events.join(", ") : "nothing"}`;

  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    abort.abort();
  }, EVENT_TIMEOUT_MS);
  try {
    while (owed.length) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (!line.startsWith("event: ")) continue;
        const kind = line.slice(7).trim();
        events.push(kind);
        if (kind === owed[0]) owed.shift();
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
  if (owed.length) throw new Error(`the server closed the event stream while ${outstanding()}`);
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
    // Resolving at all is the assertion: the read waits for the kind it came
    // for, so arriving here is the stylesheet having reported itself as one.
    assert.ok(styled.events.includes("css"), styled.events.join(", "));

    const scripted = await readEvents(running.origin, ["reload"], async () => {
      await writeFile(join(root, "app.js"), "export const ready = false;\n");
    });
    assert.ok(scripted.events.includes("reload"), scripted.events.join(", "));
  } finally {
    await stopServer(running, root);
  }
});

/**
 * The property that keeps the dev tooling out of the bytes anything else sees:
 * `npm start` is what `playwright.config.ts` runs and what a static host would
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

/**
 * No browser parses TypeScript, so a page loaded from source has to be handed
 * JavaScript. What the transform leaves alone matters as much as what it removes:
 * the specifier still names `.ts`, that request arrives back here, and the module
 * graph the browser ends up with is the one on disk rather than one this server
 * invented.
 */
test("a TypeScript module is served as JavaScript with its annotations gone", async () => {
  const root = await temporaryRoot();
  let running = null;
  try {
    running = await startServer({ root, reload: false });

    const response = await fetch(`${running.origin}/typed.ts`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/javascript/);

    const code = await response.text();
    assert.match(code, /const bpm = 120/);
    assert.doesNotMatch(code, /: number/);
    assert.doesNotMatch(code, /export type/);
    assert.match(code, /from "\.\/unit\.ts"/);
    // Asked for so that a breakpoint lands in the TypeScript that was written
    // rather than in the JavaScript this server made of it.
    assert.match(code, /sourceMappingURL=data:application\/json;base64,/);

    // The module it imports is served the same way, and running it is what
    // separates stripped-of-annotations from actually-JavaScript.
    const unit = await (await fetch(`${running.origin}/unit.ts`)).text();
    assert.equal((await evaluateModule(unit)).unit, 0.5);
  } finally {
    await stopServer(running, root);
  }
});

/**
 * A file that does not parse is a file that is there, and the two failures have
 * to stay distinguishable: reporting a syntax error as a missing file throws away
 * the one thing worth reading, which is where the error is.
 *
 * The diagnostic comes back as a module that throws it, so it arrives in the
 * console. A browser abandons a module request that answers with any non-ok
 * status without evaluating the body, so a 500 carrying the same text would put
 * it only in the network panel.
 */
test("a TypeScript module that does not parse answers with the diagnostic", async () => {
  const root = await temporaryRoot();
  let running = null;
  try {
    running = await startServer({ root, reload: false });

    const response = await fetch(`${running.origin}/broken.ts`);
    assert.notEqual(response.status, 404);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/javascript/);

    const code = await response.text();
    await assert.rejects(evaluateModule(code), (thrown: Error) => {
      // The file and the line, because a diagnostic that names neither is a
      // diagnostic nobody can act on.
      assert.match(thrown.message, /broken\.ts:1:\d+/);
      assert.match(thrown.message, /Unexpected/);
      return true;
    });

    // The file that genuinely is not there still says so, which is the half that
    // the answer above must not have swallowed.
    const absent = await fetch(`${running.origin}/nothing-here.ts`);
    assert.equal(absent.status, 404);
  } finally {
    await stopServer(running, root);
  }
});

/**
 * The served directory is the working tree, `.git` is in it, and no request is
 * ever asked who is making it — so the default has to be the interface that only
 * this machine can reach, and anything wider has to be something a developer
 * asked for by name, in the command that starts the server.
 *
 * The wider bind is asserted at the resolver rather than by binding it. A test
 * that opened the hole this default exists to close would, for as long as it ran,
 * be the thing being guarded against.
 */
test("the server binds loopback unless a --host flag asks for more", async () => {
  // No flag, which is what `npm start` and `npm run dev` both hand over.
  assert.equal(boundHost([]), "127.0.0.1");
  // The other two flags this file reads are not this one. A prefix match across
  // an argument vector is where that goes wrong, so it is stated rather than
  // assumed.
  assert.equal(boundHost(["--reload", "--root=/tmp/x"]), "127.0.0.1");
  // `--host=` with nothing after it is read as no host, for the reason an empty
  // `HOST` was before it: an empty string is how `listen` is asked for every
  // interface, so taking it at face value would turn the one form that looks
  // like a retraction into the widest bind there is.
  assert.equal(boundHost(["--host="]), "127.0.0.1");
  // The escape hatch, which is the whole reason this is a flag rather than
  // nothing at all: reaching the network stays possible and stays deliberate.
  assert.equal(boundHost(["--host=0.0.0.0"]), "0.0.0.0");
  // The separated form is not the grammar, and it fails towards loopback rather
  // than towards the address that was typed — which is the direction to fail in,
  // even though it means a developer who typed it gets a server they cannot
  // reach from the phone they were holding.
  assert.equal(boundHost(["--host", "0.0.0.0"]), "127.0.0.1");

  const root = await temporaryRoot();
  const listener = createDevServer(root);
  try {
    await new Promise<void>((ready) => listener.listen(0, boundHost([]), ready));
    const bound = boundTo(listener);
    // What the socket says it bound, rather than the string that was handed to
    // `listen` — of the two, only this one can report the bind going elsewhere.
    assert.equal(bound.address, "127.0.0.1");

    // The root the factory was given is the root it serves, which is the whole
    // reason a test can point one at a directory it is free to change.
    const page = await (await fetch(`http://127.0.0.1:${bound.port}/`)).text();
    assert.match(page, /<main><\/main>/);
  } finally {
    await new Promise((closed) => listener.close(closed));
    await rm(root, { recursive: true, force: true });
  }
});

test("the first repeated --host flag wins", () => {
  assert.equal(boundHost(["--host=192.0.2.1", "--host=127.0.0.1"]), "192.0.2.1");
});

/**
 * The vulnerability this server used to carry, written down as a test. `HOST` is
 * a name other tooling exports, and `0.0.0.0` is the ordinary value for it, so
 * reading it here meant a developer who had never made a decision about this
 * project could inherit one — and what they inherited was an unauthenticated read
 * of the whole working tree by anything on the network. The startup warning was
 * all that stood in front of it, and a warning line in a terminal that has been
 * backgrounded for an hour is not a thing anyone reads.
 *
 * Spawned rather than asserted at the resolver, because the resolver is no longer
 * where this could go wrong. Nothing in `server.ts` reads the environment for an
 * address any more, and the only way to demonstrate an absence like that is to
 * run a process with the variable set and watch it be ignored.
 */
test("an exported HOST does not reach the bind", async () => {
  const root = await temporaryRoot();
  let running = null;
  try {
    running = await startServer({ root, env: { HOST: "0.0.0.0" } });

    // `startServer` fails on any announced bind that is not loopback, so getting
    // here is already the answer. What follows is the same claim read off the
    // line itself, so a failure says which address was printed rather than only
    // that the wait ended.
    assert.match(running.output(), /Polynome running at http:\/\/localhost:\d+/);
    assert.doesNotMatch(running.output(), /0\.0\.0\.0/);
    // The second startup line only exists for a wider bind, so its absence is the
    // server agreeing that nothing was exposed.
    assert.doesNotMatch(running.output(), /unauthenticated/);

    // And it is otherwise the server it always was: a variable that decides
    // nothing is not a variable that quietly decided something else.
    const page = await (await fetch(`${running.origin}/`)).text();
    assert.match(page, /<main><\/main>/);
  } finally {
    await stopServer(running, root);
  }
});

/**
 * `startServer` above learns the port by reading this line, so its shape is load
 * bearing for most of this file. A loopback bind is called `localhost` because
 * that is the name which resolves to it, and the form a developer will paste.
 */
test("the startup line names loopback as localhost and reports a wider bind", () => {
  assert.deepEqual(startupLines("127.0.0.1", 3210, "/srv/polynome"), [
    "Polynome running at http://localhost:3210",
  ]);

  // The developer who typed `--host=` an hour ago and has not looked at that
  // terminal since is the one who needs telling what it is now reaching, so the
  // warning names the directory and what is in it.
  const wide = startupLines("0.0.0.0", 3210, "/srv/polynome");
  assert.match(wide[0], /^Polynome running at http:\/\/0\.0\.0\.0:3210$/);
  assert.match(wide.join("\n"), /\/srv\/polynome/);
  assert.match(wide.join("\n"), /\.git/);

  // An IPv6 literal needs brackets in a URL so that its colons cannot be read
  // as the separator before the port. This is presentation only: `boundHost`
  // still returns the bare address that Node's `listen` expects.
  assert.equal(
    startupLines("2001:db8::1", 3210, "/srv/polynome")[0],
    "Polynome running at http://[2001:db8::1]:3210",
  );
});

/**
 * Everything below runs the server in this process rather than spawning one.
 * The spawned tests above prove the file works when Node is handed it, which is
 * what `npm run dev` actually does — but a child keeps its own coverage
 * counters and nothing collects them, so the reload half of `server.ts` read as
 * untested while being tested thoroughly. These reach the same paths through the
 * exported factory, so what the suite covers and what it appears to cover are
 * the same set.
 */
async function serveInProcess(t, { reload = false } = {}) {
  const root = await temporaryRoot();
  const listener = createDevServer(root, reload);
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  t.after(async () => {
    // An event stream answers by never ending its response, so `close` alone
    // would wait for a connection that is not going to end on its own. The
    // sockets are destroyed first, which is what lets the server finish closing
    // and the watcher behind it be released.
    const closed = new Promise((done) => listener.close(done));
    listener.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  return { root, origin: `http://127.0.0.1:${boundTo(listener).port}` };
}

/**
 * The fixture files are written before the watch begins, and on darwin a
 * recursive watch is an FSEvents stream that can deliver events from just before
 * it was opened. Those name files this test never touched, which would be
 * harmless on its own — but a batch still inside its debounce window absorbs the
 * write made next, so the event being waited for never arrives as one of its
 * own.
 *
 * Waiting a while for the stream to go quiet would settle it most of the time
 * and pick a duration to be wrong about on a loaded machine. A marker write
 * settles it on a condition instead: it must produce an event, so this cannot
 * mistake a watch that has not started for one with nothing left to say, and a
 * round trip that reports the marker and nothing else is a stream that had
 * nothing queued behind it. Anything older either collapsed into the marker's
 * own window — leaving one event, which is the answer — or arrived beside it,
 * which is a backlog, and the next attempt is made against a stream that has
 * now drained it.
 */
async function settleWatcher(origin, root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = join(root, `settle-${attempt}.marker`);
    const { events } = await readEvents(origin, ["reload"], () =>
      writeFile(marker, String(attempt)),
    );
    if (events.length === 1) return;
  }
  throw new Error("the watcher kept reporting changes this test did not make");
}

test("a reloading server in this process injects the client and streams what changed", async (t) => {
  const { root, origin } = await serveInProcess(t, { reload: true });
  await settleWatcher(origin, root);

  const page = await (await fetch(`${origin}/`)).text();
  assert.match(page, /EventSource\("\/dev\/reload"\)/);
  // Injected ahead of the closing tag rather than appended, so what the browser
  // parses is still a document.
  assert.match(page, /<\/script><\/body>/);

  // A stylesheet swaps in place; anything else has no smaller unit of
  // replacement than the page, so it reloads. Both kinds come from one watcher,
  // and reading them from one stream is what shows the debounce telling them
  // apart rather than reporting whichever arrived first.
  const styled = await readEvents(origin, ["css"], () =>
    writeFile(join(root, "styles.css"), "body { color: #000 }\n"),
  );
  assert.equal(styled.handshake, ": open\n\n");
  assert.ok(styled.events.includes("css"), styled.events.join(", "));

  const scripted = await readEvents(origin, ["reload"], () =>
    writeFile(join(root, "app.js"), "export const ready = false;\n"),
  );
  assert.ok(scripted.events.includes("reload"), scripted.events.join(", "));
});

test("a server that was not asked to reload has neither the client nor the endpoint", async (t) => {
  const { origin } = await serveInProcess(t);

  const page = await (await fetch(`${origin}/`)).text();
  assert.doesNotMatch(page, /EventSource/);
  // The endpoint is not merely quiet without the flag — it is not a path this
  // server knows, so it answers the way any other unknown path does.
  const stream = await fetch(`${origin}/dev/reload`);
  assert.equal(stream.status, 404);
  assert.equal(await stream.text(), "Not found");
});

/**
 * All three flags are parsed from an argument vector rather than read from
 * `process.argv` inside the factory, which is what lets them be checked without
 * a process to carry them. The third is `--host=`, and it is asserted above,
 * beside the default it exists to step around.
 */
test("the argument vector decides the served directory and whether to reload", () => {
  assert.equal(reloadRequested(["--reload"]), true);
  assert.equal(reloadRequested(["--root=/tmp/x"]), false);
  assert.equal(reloadRequested([]), false);

  // Resolved against the working directory, because that is what a relative
  // argument means to whoever typed it.
  assert.equal(servedRoot([`--root=${tmpdir()}`]), tmpdir());
  assert.equal(servedRoot(["--root=."]), process.cwd());
  // No flag is the directory `server.ts` sits in, which is the repository.
  assert.equal(servedRoot([]), fileURLToPath(new URL("..", import.meta.url)));
});

/**
 * The two cases above prove the transform through a spawned server, which is
 * what `npm start` runs. This reaches the same code in this process, so the
 * suite's coverage figures describe what it tests: a child keeps its own
 * counters and nothing collects them, and `stripTypes` would otherwise read as
 * untouched while being the most exercised function in the file.
 */
test("the transform and its diagnostic are reachable without spawning a server", async (t) => {
  const { origin } = await serveInProcess(t);

  const typed = await fetch(`${origin}/typed.ts`);
  const body = await typed.text();
  assert.equal(typed.status, 200);
  assert.match(typed.headers.get("content-type"), /^text\/javascript/);
  // The annotations are gone and the specifier is not: the browser asks this
  // server for `./unit.ts` next, which is what keeps the graph the one on disk.
  assert.doesNotMatch(body, /: number/);
  assert.match(body, /\.\/unit\.ts/);

  const broken = await fetch(`${origin}/broken.ts`);
  const diagnostic = await broken.text();
  // Present but unparseable is not absent, so it is not a 404 — and the module
  // it answers with throws the diagnostic into the console.
  assert.equal(broken.status, 200);
  assert.match(diagnostic, /^throw new SyntaxError\(/);
  assert.match(diagnostic, /broken\.ts/);

  const absent = await fetch(`${origin}/nothing-here.ts`);
  assert.equal(absent.status, 404);
});

/**
 * Every failure under the request handler used to leave by one door and say one
 * sentence. A path naming nothing says it truthfully; a mode that refuses the
 * read, a directory that cannot be walked and a disk that gave up all said it
 * too, so the failure meaning "your file is not where you think" was
 * indistinguishable from the ones meaning "something on this machine is wrong",
 * and none of them left a trace anywhere. The status is unchanged — see the
 * handler for why a 500 would buy nothing — and the reason now goes to stderr,
 * beside the lines this server already prints for whoever started it.
 *
 * The failure is provoked rather than stood in for: a real file, with a real
 * mode, refused by the real `open`. That is what costs the case its portability,
 * since a process running as root is refused nothing and Windows does not read
 * these bits at all — so the over-long name is asserted first and unconditionally,
 * and it is what keeps this test from passing while proving nothing on a machine
 * where a refusal cannot be staged.
 */
test("a failure that is not an absent file is reported to the operator", async (t) => {
  const { root, origin } = await serveInProcess(t);
  // Held rather than left to print, because a suite that reports a passing run
  // in the middle of a server's error output has taught its reader to skim it.
  const logged = t.mock.method(console, "error", () => {});

  // A name longer than any filesystem here will hold: `stat` refuses it as
  // ENAMETOOLONG rather than ENOENT, which is the branch under test, and it
  // needs neither a mode nor a uid to arrange.
  const overlong = await fetch(`${origin}/${"n".repeat(300)}.ts`);
  assert.equal(overlong.status, 404);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /ENAMETOOLONG/);

  // The case the finding is about, staged where it can be. The file is written
  // here rather than in `temporaryRoot` because it only exists where the read
  // can actually be refused, and a fixture that is sometimes there is not
  // something that directory can be said to hold.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await writeFile(join(root, "denied.ts"), "export const secret = true;\n");
    await chmod(join(root, "denied.ts"), 0o000);

    const refused = await fetch(`${origin}/denied.ts`);
    // `stat` still answers for this file — a mode of zero refuses opening it,
    // not describing it — so the failure is the read, which is where a file that
    // is present and unreachable differs from one that is not there.
    assert.equal(refused.status, 404);
    assert.equal(logged.mock.callCount(), 2);
    const reported = logged.mock.calls[1].arguments[0];
    assert.match(reported, /EACCES/);
    assert.match(reported, /denied\.ts/);
  }

  // The other direction, and the reason this discriminates on the code rather
  // than logging everything it catches: an ordinary miss is not a fault of the
  // machine, and a line of stderr for every favicon a browser asks after is how
  // an operator learns to stop reading them.
  const before = logged.mock.callCount();
  const absent = await fetch(`${origin}/nothing-here.ts`);
  assert.equal(absent.status, 404);
  assert.equal(await absent.text(), "Not found");
  assert.equal(logged.mock.callCount(), before);
});

/**
 * Real `ServerResponse` objects, opened and held the way the reload endpoint
 * holds them, because the question this fixture exists to ask is what Node does
 * on a write to a response in a particular state — and a stand-in shaped like
 * one would answer that by assumption rather than by running it.
 *
 * A raw socket rather than `fetch`, because `fetch` will not resolve until it
 * has headers and will not let go of the connection afterwards, and this needs
 * to hold several streams open at once and then mistreat them individually.
 */
async function openEventStreams(t, count) {
  const responses = [];
  const sockets = [];
  const received = [];

  const host = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(": open\n\n");
    responses.push(response);
  });
  await new Promise<void>((ready) => host.listen(0, "127.0.0.1", ready));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    host.closeAllConnections();
    await new Promise((closed) => host.close(closed));
  });

  const { port } = boundTo(host);
  for (let index = 0; index < count; index += 1) {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    received.push("");
    socket.setEncoding("utf8");
    // The test destroys some of these on purpose, and a socket whose peer is
    // gone reports it as an error nobody would otherwise be listening for.
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received[index] += chunk;
    });
    await new Promise((connected) => socket.once("connect", connected));
    // The response only exists once the request has been parsed, and the caller
    // is handed the responses — so each stream is opened to its handshake before
    // the next is asked for, which is what makes the order they arrive in known.
    const opened = new Promise((handshake) => socket.once("data", handshake));
    socket.write("GET /dev/reload HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await opened;
  }

  return { responses, sockets, received };
}

/**
 * The reload broadcast writes into responses it has been holding since some
 * earlier request, and a client that has gone leaves one behind for as long as
 * its close event takes to arrive. The two ways a response can be past writing
 * to are not equally quiet: a destroyed one absorbs the write and returns false,
 * while one that has ended emits an `error`, and no `ServerResponse` carries a
 * handler for that — so it reaches the process as an uncaught exception and the
 * development server is gone, taking the watch with it.
 *
 * Both are checked here because the guard has to cover both, and only the second
 * announces itself. A destroyed listener that is written to costs nothing today;
 * it is the one left in the set afterwards that is worth failing on, because a
 * set that only ever grows is how the quiet case turns into the loud one.
 */
test("a change is not announced into a response that has ended or been destroyed", async (t) => {
  const { responses, sockets, received } = await openEventStreams(t, 3);
  const [live, ended, destroyed] = responses;

  ended.end();
  destroyed.destroy();

  // Stated rather than assumed. `end()` leaves a response ended and, for this
  // one tick, not yet destroyed, and that is the whole case: let a turn of the
  // loop pass and the socket is recycled, the response reads as destroyed too,
  // and the write it would have refused becomes the write it swallows. A run
  // that arrived here in the wrong state would otherwise pass while proving
  // nothing.
  assert.equal(ended.writableEnded, true);
  assert.equal(ended.destroyed, false);
  assert.equal(destroyed.destroyed, true);

  const listeners = new Set([live, ended, destroyed]);
  announceChange(listeners, "css", "styles.css");

  assert.ok(!listeners.has(ended), "an ended response was left in the set");
  assert.ok(!listeners.has(destroyed), "a destroyed response was left in the set");
  // The other half of the guard: skipping the dead must not cost the living
  // their event, which is the only thing this endpoint exists to deliver.
  assert.ok(listeners.has(live), "the live response was pruned along with the dead ones");
  assert.equal(listeners.size, 1);

  await new Promise((arrived) => sockets[0].once("data", arrived));
  assert.match(received[0], /event: css\ndata: styles\.css\n\n/);
});
