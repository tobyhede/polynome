import { watch } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMessages, transform } from "esbuild";

/**
 * The directory served and watched when nobody names one, which is the directory
 * this file sits in — the working tree, since that is what a buildless page is
 * loaded from.
 */
const DEFAULT_ROOT = fileURLToPath(new URL(".", import.meta.url));

/**
 * Reloading is opt-in and lives behind a flag, so `npm start` — which is what
 * `playwright.config.ts` runs — serves exactly the bytes it always did. The
 * client below is injected into the HTML response rather than written into
 * `index.html`, which is what keeps it out of `dist/` and `site/`: there is no
 * markup for a build to strip because the source file never carries it.
 *
 * The flag is read here and handed to `createDevServer` as an argument rather
 * than reached for inside it. A process starts with one answer to this and keeps
 * it; a test needs both, and reading the argument vector from inside the factory
 * would put the reloading half of this file beyond anything that does not spawn
 * a process to get at it.
 */
export function reloadRequested(argv) {
  return argv.includes("--reload");
}

const ROOT_FLAG = "--root=";

/**
 * The served directory as an argument, so that a caller can point this at a tree
 * that is not the one this file is in. `test/server.test.ts` is that caller: it
 * serves a directory it writes into, which is the only way to prove a change
 * reloads, and it can now do that while still running this file from where it
 * lives — the alternative, copying the file to the tree it serves, puts `esbuild`
 * beyond anything Node's resolver would walk up to from there.
 */
export function servedRoot(argv) {
  const flagged = argv.find((argument) => argument.startsWith(ROOT_FLAG));
  // Resolved rather than taken as given, because a relative path in an argument
  // is relative to where the command was run.
  return flagged ? resolve(flagged.slice(ROOT_FLAG.length)) : DEFAULT_ROOT;
}

const LOOPBACK = "127.0.0.1";

/**
 * The names that reach this machine and nowhere else. `localhost` is among them
 * because it is the form a developer would type, and it resolves to one of the
 * two addresses beside it.
 */
const LOOPBACK_HOSTS = new Set([LOOPBACK, "::1", "localhost"]);

const HOST_FLAG = "--host=";

/**
 * Loopback unless the command that started this asked for more. What is being
 * served is a working tree — `.git` with every branch and message in it, alongside
 * whatever else is lying about — and no request here is ever asked who is making
 * it, so reaching the rest of the network has to be something a developer chose
 * rather than something they got.
 *
 * The address comes from the argument vector and not from the environment, which
 * is the whole of ADR-0023. This used to read `HOST`, and `HOST` is a name other
 * tooling exports — commonly as `0.0.0.0` — so a shell that had been set up for
 * something else was enough to hand the tree to the network without anyone here
 * deciding anything. An argument is a decision about this server, made in the
 * command that starts it, and it cannot be inherited.
 *
 * `--host=` with nothing after it is read as no host, for the same reason an
 * empty `HOST` was: an empty string is how `listen` is asked for every interface,
 * so taking it at face value would make the one form that looks like a retraction
 * into the widest bind there is.
 *
 * Read out here and handed to `listen` rather than reached for further in, for
 * the reason given at `servedRoot`: a process has one answer to this and keeps
 * it, and a test needs every answer without spawning one to get at it.
 */
export function boundHost(argv) {
  const flagged = argv.find((argument) => argument.startsWith(HOST_FLAG));
  return flagged?.slice(HOST_FLAG.length) || LOOPBACK;
}

/**
 * What the process says once it is listening, returned as lines rather than
 * printed so that the wording is something a test can hold.
 *
 * A loopback bind is announced as `localhost`: it is accurate, since that is what
 * `localhost` resolves to, and it is the form that can be pasted into a browser.
 * `test/server.test.ts` also reads the port out of this line, so the shape of it
 * is load bearing beyond what it says.
 *
 * Any other bind is announced as itself and carries a second line naming what is
 * now reachable. It is a reminder rather than a safeguard — the developer who
 * typed `--host=` and then backgrounded the terminal is the one it is for, and by
 * then it is not something they are looking at. What keeps the wide bind from
 * arriving unasked for is that it has to be typed at all; see ADR-0023.
 */
export function startupLines(host, port, root) {
  if (LOOPBACK_HOSTS.has(host)) return [`Polynome running at http://localhost:${port}`];
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return [
    `Polynome running at http://${urlHost}:${port}`,
    `Serving ${root} to anything that can reach this machine, unauthenticated — .git and all.`,
  ];
}

/*
 * Everything a change here could not usefully redraw, plus the directory whose
 * size would make a recursive watch worth avoiding.
 *
 * Filtered when an event arrives rather than excluded when the watch is set up,
 * because Node 22 — what `.nvmrc` and `engines` ask for — has no way to exclude
 * a subtree from a recursive watch. `fs.watch` grew an `ignore` option in 24.14
 * and 25.5, and the installed `@types/node` is new enough to typecheck a call
 * that passes one, so a future reader has every reason to think this could be
 * tidied up: on the Node this project runs, that option is accepted in silence
 * and does nothing. The cost of filtering late is nil here — darwin takes the
 * native FSEvents path and watches the root as one stream.
 */
const UNWATCHED = [
  ".git",
  ".serena",
  "dist",
  "node_modules",
  "playwright-report",
  "site",
  "test-results",
];

/**
 * A change to the stylesheet re-points the `<link>` instead of reloading the
 * page. The distinction is worth the few lines: this is a metronome, a reload
 * drops the AudioContext with it, and the tempo envelope drawer is the kind of
 * thing that is adjusted while something is playing. Anything else — a module,
 * the markup — is a full reload, because a buildless page has no smaller unit
 * of replacement than itself.
 */
const RELOAD_CLIENT = `<script>
(() => {
  const source = new EventSource("/dev/reload");
  source.addEventListener("css", () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const next = new URL(link.href, location.href);
      next.searchParams.set("reload", String(Date.now()));
      link.href = next.href;
    }
  });
  source.addEventListener("reload", () => location.reload());
})();
</script>`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * The module a browser gets for a TypeScript request: the same file with its
 * annotations gone and nothing else altered. Specifiers are left exactly as they
 * were written — `./model.ts` stays `./model.ts` — so the next request arrives
 * back here and the graph the browser ends up holding is the one on disk.
 *
 * A file that does not parse answers with a module that throws the diagnostic,
 * rather than with an error status. A browser treats any non-ok status on a
 * module request as a failed load and never evaluates the body, so a 500 carrying
 * this text would show it only to whoever had the network panel open; a module
 * that throws puts it in the console, which is where a syntax error reported
 * itself before any of this was TypeScript.
 */
async function stripTypes(source, filePath) {
  try {
    const stripped = await transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2020",
      // Named, and mapped inline, so that a breakpoint lands in the TypeScript
      // that was written rather than in what this made of it.
      sourcefile: filePath,
      sourcemap: "inline",
    });
    return stripped.code;
  } catch (failure) {
    // A parse failure arrives as a list of messages. Anything else — a transform
    // service that would not start, say — arrives with none, and then its own
    // text is the only thing there is to report.
    const messages = failure?.errors?.length
      ? await formatMessages(failure.errors, { kind: "error", color: false })
      : [`${filePath}: ${failure}`];
    // Stringified rather than quoted by hand: the diagnostic runs to several
    // lines and quotes the offending source back, so it carries both newlines and
    // whatever quoting was in the line that failed.
    return `throw new SyntaxError(${JSON.stringify(messages.join("\n"))});\n`;
  }
}

/**
 * What goes out for a file that was read. The bytes go out untouched unless this
 * is TypeScript, which no browser parses, or a page being served for reloading,
 * which is the one other case that reads them as text.
 */
function responseBody(file, filePath, contentType, reload) {
  if (extname(filePath) === ".ts") return stripTypes(file.toString("utf8"), filePath);
  if (reload && contentType.startsWith("text/html")) {
    return file.toString("utf8").replace("</body>", `${RELOAD_CLIENT}</body>`);
  }
  return file;
}

/**
 * One collapsed change, written out to every stream still able to take it.
 *
 * A listener leaves the set on `request.on("close")`, so a response whose client
 * has gone is only in it for as long as that event takes to arrive — but that is
 * exactly the window this runs in, since the debounce below fires forty
 * milliseconds after a save and a tab being closed part way through one is an
 * ordinary thing to do. What the write does to one of those depends on how far
 * it got: a destroyed response absorbs it and answers false, but one that has
 * ended emits an `error`, and no `ServerResponse` carries a handler for that, so
 * it arrives as an uncaught exception and the development server is gone —
 * taking the watch and every other open stream with it.
 *
 * Exported because the set belongs to a server and nothing outside it can reach
 * in. The alternative is staging that race against a live socket, which would be
 * a test that has to win a race to say anything, and therefore one that reports
 * this guard as present on most runs whether it is or not.
 */
export function announceChange(listeners: Set<ServerResponse>, kind, name) {
  for (const listener of listeners) {
    // Dropped rather than merely skipped, because the only thing that removes a
    // listener is its own request closing, and the write above is what finds out
    // first when that has not arrived. Deleting the element being visited is
    // defined behaviour for a Set, and the ones already visited are untouched.
    if (listener.writableEnded || listener.destroyed) {
      listeners.delete(listener);
      continue;
    }
    listener.write(`event: ${kind}\ndata: ${name}\n\n`);
  }
}

/**
 * A server that is not listening yet, so that importing this module binds
 * nothing and whoever creates one decides the port.
 *
 * Everything the reload feature carries between requests belongs to the server
 * rather than to the module: two of these in one process — which is one test
 * away — would otherwise watch through a single watcher and write every event
 * into a single set of streams, so each would report the other's changes.
 */
export function createDevServer(root = DEFAULT_ROOT, reload = false) {
  // The open event streams, which are held as the responses they will be written
  // into: an SSE endpoint answers by never ending its response.
  const listeners = new Set<ServerResponse>();

  function startWatching() {
    let pending = null;
    let onlyStyles = true;
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (!name || UNWATCHED.includes(name.split(/[/\\]/)[0])) return;
      // An editor writes a file as a rename over a temporary one, so a single save
      // arrives as several events. Collapsing them keeps one save to one reload —
      // and a window holding anything but a stylesheet is a reload, because the
      // cheaper answer is only correct when every file in it was a stylesheet.
      if (extname(name) !== ".css") onlyStyles = false;
      clearTimeout(pending);
      pending = setTimeout(() => {
        const kind = onlyStyles ? "css" : "reload";
        onlyStyles = true;
        announceChange(listeners, kind, name);
      }, 40);
    });
    // A recursive watch is a handle on the filesystem, and it outlives every
    // request rather than belonging to one, so the server it was opened for is
    // what closes it. A process that runs until it is killed would not notice
    // either way; a caller that closes the server and expects to be finished
    // would otherwise be held open by a watcher on a directory it has already
    // deleted, which is what `test/server.test.ts` does after every case.
    listener.once("close", () => {
      clearTimeout(pending);
      watcher.close();
    });
    console.log("Watching for changes; CSS swaps in place, everything else reloads");
  }

  const listener = createServer(async (request, response) => {
    try {
      const requestedPath = decodeURIComponent(
        new URL(request.url, `http://${request.headers.host}`).pathname,
      );

      if (reload && requestedPath === "/dev/reload") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        // The stream has to say something before the browser reports it open, and
        // a comment is the one thing an EventSource reads and discards.
        response.write(": open\n\n");
        listeners.add(response);
        request.on("close", () => listeners.delete(response));
        return;
      }

      const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
      const safePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
      let filePath = join(root, safePath);

      const fileStats = await stat(filePath);
      if (fileStats.isDirectory()) filePath = join(filePath, "index.html");

      const contentType = types[extname(filePath)] || "application/octet-stream";
      // The read stays here, outside everything that could fail on what it
      // returns, so that a file which is absent and a file which does not parse
      // remain two different answers. Only the first of them is a 404.
      const file = await readFile(filePath);
      const body = await responseBody(file, filePath, contentType, reload);
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(body);
    } catch (failure) {
      // ENOENT is the only failure caught here that means what the answer says,
      // and it is the one that arrives constantly — every path naming nothing,
      // every favicon a browser asks after. Everything else is a file that is
      // there and could not be handed over: a mode that refuses the read, a
      // directory that cannot be walked, a disk that gave up. Answering those
      // with the same silent sentence is what leaves a developer hunting for a
      // file that is sitting in front of them, so they go to stderr, which is
      // where this server's other operator-facing lines already go.
      if (failure?.code !== "ENOENT") console.error(`Could not serve ${request.url}: ${failure}`);
      // Still a 404, and for the reason ADR-0018 gives: a browser abandons a
      // module request answering with any non-ok status without evaluating the
      // body, so a 500 would put a different word in the network panel and
      // nothing in the console — no diagnosis reaches anyone through a status,
      // which is why the diagnosis is now logged instead. What it would cost is
      // real: this catch also covers a request this could not decode, and a URI
      // with a broken percent-escape is not this machine being at fault. The one
      // claim true of every failure above is the one worth making to a client —
      // there is nothing here to hand over — and 404 is how that is said.
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  // The watch starts when the server does, so one that is created and never
  // listened to — which is what a test holds — never reaches the filesystem.
  if (reload) listener.once("listening", startWatching);

  return listener;
}

// True only for the file Node was given to run. Importing this module therefore
// costs a caller nothing, which is what lets `test/server.test.ts` reach the
// factory above without a port being taken from whatever else is running.
// `import.meta.main` arrived in Node 22.18, so that is the oldest Node this file
// can be started by.
if (import.meta.main) {
  const root = servedRoot(process.argv);
  const host = boundHost(process.argv);
  // The port stays an environment variable, where the address no longer is,
  // because the two are not the same kind of thing: a port that arrives from a
  // shell moves a server that only this machine can reach, and `playwright.config.ts`
  // hands one to `npm start` for exactly that reason.
  const port = Number(process.env.PORT || 4173);
  const listener = createDevServer(root, reloadRequested(process.argv));
  // The port that was actually bound rather than the one that was asked for. They
  // are the same for every number, and different for zero — which is how a caller
  // asks the operating system to pick a free one, and the only way to find out
  // what it picked.
  listener.listen(port, host, () => {
    // A listener bound to a pipe reports its address as a string and has no port
    // at all. This one is always bound to a host and a number, so the fallback is
    // for the reader and the type checker rather than for a case that arrives.
    const bound = listener.address();
    const listening = typeof bound === "object" && bound ? bound.port : port;
    for (const line of startupLines(host, listening, root)) console.log(line);
  });
}
