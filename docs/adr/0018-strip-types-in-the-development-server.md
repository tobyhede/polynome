# Strip types in the development server

`server.ts` runs esbuild's `transform` over every `.ts` file it serves and
answers with JavaScript carrying an inline source map. Nothing else about how
the browser reaches the application changes: `index.html` still names
`./app.ts`, every module still names the file that exists, the import map still
resolves `preact` and `htm` out of `node_modules/`, and there is still no
bundle and no output directory in development, so nothing a watcher would have
to rebuild; the watcher `npm run dev` starts reloads the browser and builds
nothing. This is a transform and not a build — it produces nothing that
outlives the response it is part of. Both browser distributions are built
exactly as they were.

The conversion left every reader of this source needing a way to read it, and
three of the four already had one. Node strips annotations natively and runs
`test/`. `tsc` reads the types and emits nothing, because it is here as a
checker. esbuild strips them for `dist/polynome.html` and for `site/`. The
browser parses JavaScript and nothing else, and it is the reader a developer
spends the most time in front of — the one with the application open while the
edit is being made. Leaving it without an answer would have meant the source
version could not be run at all, which is the loop this project is developed in.

The transform belongs in the server because the server is already in the request
path. It reads a file, decides a content type and writes bytes; this adds a case
to the middle of that. Nothing new has to exist, be started, or be kept in sync,
and the module graph the browser walks stays the one on disk: a specifier naming
`./model.ts` comes back here as a request for `./model.ts`, so the server
answers one file at a time and never has to know what imports what.

## Consequences

- `server.ts` is no longer dependency-free. It imported `node:` builtins and
  nothing else, which is what the README called a zero-dependency static server
  and what let `test/server.test.ts` copy the one file into a temporary
  directory and run it there. It imports `esbuild` now. Nothing that ships
  changes — esbuild is a development dependency, the server is a development
  tool, and neither reaches a user — but `npm start` requires `npm install` to
  have run where it used to require only Node, and a copy of this file run
  outside the repository has to be able to resolve `esbuild` from somewhere.
- esbuild has three jobs where `AGENTS.md` justified it with one. It bundles the
  module graph for the two browser distributions, it strips annotations here,
  and it is the parser `test/syntax.test.ts` runs over every tracked file — a
  job it holds for the same reason as this one, since `node --check` exits zero
  on a `.ts` file whatever its annotations say. The three share a version and a
  failure mode: what esbuild accepts now decides what the browser runs, what the
  artifacts contain, and what the suite calls a syntax error, together. It was
  already pinned to an exact version for the distributions' sake, and that pin
  now covers the development loop as well.
- A parse failure moved from the browser to the server, and keeping it legible
  is this decision's obligation rather than a courtesy. A file that does not
  parse never becomes output, so the browser cannot report what it never
  received, and this is an error the browser used to report very well — file,
  position, and the line it went wrong on. It has to stay distinct from a file
  that is not there, too: answering a syntax error with a 404 throws away the
  one thing worth reading, which is where the error is. So a file that fails to
  transform is answered with 200 and `text/javascript`, as a module whose body
  throws the diagnostic. That puts it in the console, where a parse error has
  always appeared. A browser abandons a module request answering with a non-ok
  status without evaluating the body, so a 500 carrying the same text would
  leave the diagnostic in the network panel and nowhere else. A path naming no
  file still answers 404. `test/server.test.ts` holds both halves, including
  that the message names the file and the line.
- Served modules carry an inline source map, so a breakpoint and a stack frame
  land in the TypeScript that was written rather than in the JavaScript this
  server made of it. Stripping mostly preserves line numbers and does not always,
  and "mostly" is the property that costs an hour on the day it does not hold.
- Only `.ts` is transformed. The stylesheet, the fonts, the images and the shell
  go out as the bytes on disk. The one response still read as text is the HTML
  under `--reload`, which has the reload client injected into it rather than
  into `index.html`.
- Nothing is cached. Every request re-reads the file and transforms it again,
  and every response carries `Cache-Control: no-store` as this server's always
  have. A cache needs something to invalidate it, and the only thing watching
  the tree is the reloading mode — so a cache would be correct under `npm run
  dev` and wrong under `npm start`, which is the worse of the two ways to be
  wrong. The cost is one transform per module per load, paid by one browser over
  loopback. If that stops being invisible, a measurement is what should decide
  it, and a file's modification time is what the cache would be keyed on.
- Both browser distributions are untouched. `scripts/build.ts` already ran
  esbuild over this source and already produced JavaScript; what the conversion
  changed there is the extension on its entry points. Neither artifact goes near
  this server — the single file is opened over `file://` and `site/` is served
  by whatever hosts it — so nothing a user receives depends on what is decided
  here.
- Emitting a `.js` beside each source file was rejected. It does not remove the
  transform; it moves it earlier and leaves the result on disk, and everything
  it costs follows from that. There would be two files per module and the one
  that runs would not be the one anyone edits, so the editor, `git grep` and the
  browser would each answer about a different file. The generated half would
  have to be kept out of version control, out of the tracked-file enumeration
  `test/syntax.test.ts` derives, out of the linter and out of the coverage
  figures — a new exclusion in every tool that walks the tree. Its specifiers
  would have to be rewritten as well, because a source that says `./model.ts`
  cannot reach an emitted `model.js`, and rewriting a specifier is precisely
  what a stripper does not do. And its staleness would have no boundary: with no
  build step to stand at, whether the browser has the current code would depend
  on whether something happened to be watching. A transform that is served has
  none of this, because its output lives for one response.
- Bundling in development was rejected. The browser already loads ES modules,
  resolves relative specifiers and reads an import map, so nothing here needs
  bundling for the browser's sake. The two distributions bundle because they
  must — one to be a single file that opens over `file://` with no server and no
  `node_modules/`, the other to carry cache-safe names — and development has
  neither requirement. Buying an artifact means buying its invalidation with it:
  a bundle to rebuild, a watcher to decide when, and a stage standing between
  the file that is wrong and the failure that says so. `AGENTS.md` asks for a
  concrete requirement before a development build, and the requirement here is
  that the browser be handed JavaScript, which a per-file transform satisfies
  exactly.
- Development now has a transform step, which is the reason
  [ADR-0009](0009-adopt-preact-as-the-renderer.md) recorded for rejecting JSX.
  That reason no longer separates the two, since `htm` and JSX would both reach
  the browser through esbuild. The bullet is amended in place there rather than
  rewritten, because what it decided is not in question here: `htm` is what
  every rendered region is written in, and changing that would be a rewrite
  bought with a syntax. ADR-0009 left the door open — "Adopting a development
  build remains available as a separate decision with its own justification" —
  and this is not that decision either. It adds a case to a server that was
  already answering the request and produces no artifact. A JSX adoption still
  needs its own record, and would now have to argue for itself on something
  other than the build step.
