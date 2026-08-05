import { watch } from "node:fs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

/**
 * Reloading is opt-in and lives behind a flag, so `npm start` — which is what
 * `playwright.config.js` runs — serves exactly the bytes it always did. The
 * client below is injected into the HTML response rather than written into
 * `index.html`, which is what keeps it out of `dist/` and `site/`: there is no
 * markup for a build to strip because the source file never carries it.
 */
const reloading = process.argv.includes("--reload");

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

const listeners = new Set();

function startWatching() {
  let pending = null;
  let onlyStyles = true;
  watch(root, { recursive: true }, (_event, name) => {
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
      for (const listener of listeners) listener.write(`event: ${kind}\ndata: ${name}\n\n`);
    }, 40);
  });
  console.log("Watching for changes; CSS swaps in place, everything else reloads");
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (request, response) => {
  try {
    const requestedPath = decodeURIComponent(
      new URL(request.url, `http://${request.headers.host}`).pathname,
    );

    if (reloading && requestedPath === "/dev/reload") {
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
    // The bytes go out untouched unless this is a page being served for
    // reloading, which is the one case that reads them as text.
    const file = await readFile(filePath);
    const body =
      reloading && contentType.startsWith("text/html")
        ? file.toString("utf8").replace("</body>", `${RELOAD_CLIENT}</body>`)
        : file;
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Polynome running at http://localhost:${port}`);
  if (reloading) startWatching();
});
