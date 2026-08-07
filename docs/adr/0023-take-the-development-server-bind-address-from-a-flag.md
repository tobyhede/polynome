# Take the development server's bind address from a flag

`server.ts` reads the address it binds from `--host=<addr>` in its own argument
vector, beside the `--root=` and `--reload` it already read there. Nothing about
the default changes: with no flag it binds `127.0.0.1`, and a wider bind is still
announced as itself and still carries a second line naming the directory it has
just exposed. What changes is where a wider bind is allowed to come from. It came
from `HOST` in the environment, and it now comes from the command that starts the
server or from nowhere.

`HOST` is a name other tooling exports, and `0.0.0.0` is the ordinary value for
it. That is the whole of the problem. A developer who had never made a decision
about this project could inherit one from a shell profile, a direnv file, a
container image or a framework's conventions set up for something else entirely,
and what they inherited was this server. What this server hands over is the
repository directory: measured against a running instance, `/AGENTS.md`,
`/.serena/project.local.yml` and `/.git` all answer 200, and the last of them
names the worktree gitdir path. No request is ever asked who is making it, and
none should be — there is no login, no token and no allowlist here, because there
has never been a reason to build one for a server that only this machine can
reach.

Traversal is not what this is about, and it is worth saying so because it is the
first thing a reader will reach for. `..` in a request path, percent-encoded once
or twice, and the `....//` form all answer 404 against the normalisation in the
request handler. Nothing escapes the served root. The finding is that the served
root itself is the working tree, and that reaching it from beyond loopback was
something a shell could decide.

The default was already right and is unchanged. What this record decides is which
kind of input may override it. An environment variable is ambient: it is set
elsewhere, for another reason, at an earlier time, and it applies to every process
that inherits it, including the ones nobody was thinking about when it was set. An
argument is not ambient. It is typed into the command that starts this server, it
lasts exactly as long as that run, and there is no path to a wide bind that does
not go through somebody writing `--host=` down. For a default whose entire job is
to be difficult to leave, that is the difference that matters.

The escape hatch is unchanged in everything but its spelling. `npm start --
--host=0.0.0.0` is what the README documents for opening the application on a
phone, `npm run dev -- --host=0.0.0.0` does the same with reloading, and both
still print what they have exposed.

## Consequences

- A differently-named variable — `POLYNOME_HOST`, say — was rejected, and it is
  the cheapest-looking alternative, so it is the one worth being explicit about.
  It fixes the collision and nothing else. The reason `HOST=0.0.0.0` was dangerous
  is not that the name is popular; it is that an environment variable is inherited
  by every process started under it, so the decision outlives the moment and the
  reason it was made. A developer who exports `POLYNOME_HOST=0.0.0.0` on Tuesday
  to reach the metronome from a phone has a LAN-exposed working tree on Thursday,
  and nothing between those two days says so. A rarer name makes that rarer
  without making it any less silent, and "rarer" is not a property a security
  default should rest on. The flag has the property directly: it cannot persist,
  because there is nowhere for it to persist to.
- The startup warning stays, and stays exactly as worded, but it is not what makes
  this safe and never was. `startupLines` is read by `test/server.test.ts` for the
  port, so its shape is load bearing regardless — and as a safeguard it depends on
  a person reading a line in a terminal at the moment it is printed. The terminal
  a development server runs in is backgrounded, split into a pane nobody is
  looking at, or scrolled past by the next command within seconds. The warning is
  worth keeping for the case it is actually good at, which is the developer who
  did choose the wide bind and has since forgotten it is still running; it is
  worthless for the case that prompted this, which is the developer who never
  chose anything. A control that only works when someone is watching is not a
  control, and building on it would have meant making it louder — a prompt, a
  confirmation, a countdown — which is a worse tool applied to a problem that
  disappears once the value has to be typed.
- `PORT` stays in the environment, and the asymmetry is deliberate rather than an
  oversight left for someone to tidy up. A port decides where on this machine the
  server answers; an address decides which machines can ask. An inherited `PORT`
  moves a server that is still only reachable from here, which is a nuisance at
  worst, and `playwright.config.ts` passes `env: { PORT: String(port) }` to
  `npm start` precisely because it wants to move it — the browser suite takes 4174
  to avoid colliding with `npm start` on 4173 and `npm run shots` on 4175. Moving
  `PORT` to a flag would break that for no gain. The rule this leaves is worth
  naming, because the next variable will be judged against it: what can widen who
  reaches this process is an argument, and what merely rearranges it locally is
  free to be ambient.
- `--host=` with nothing after it reads as no host, which is the one piece of the
  old behaviour that is carried over unchanged rather than reconsidered. An empty
  string is how `listen` is asked for every interface, so taking it literally
  would turn the form that looks most like a retraction into the widest bind
  available. The reasoning that applied to an exported-but-empty `HOST` applies
  identically to a flag someone typed and then deleted the value from.
- Only the `--host=addr` form is read. `--host 0.0.0.0`, separated by a space, is
  not the grammar `--root=` established and is not parsed, so it falls through to
  loopback and the server the developer wanted to reach from their phone is one
  they cannot reach. That is a real papercut, and it is the direction to fail in:
  a mistyped flag that quietly binds narrower costs someone a minute, and one that
  quietly binds wider is the finding this record exists to close. Refusing unknown
  arguments outright would remove the papercut, but this file has never validated
  its argument vector and adding a parser to it is a different change.
- `resolveHost` is gone and `boundHost(argv)` is in its place, exported and tested
  the same way. It takes the argument vector rather than a string, which puts it
  with `servedRoot` and `reloadRequested` and gives it the property those two were
  written for: a process has one answer to this and keeps it, while a test needs
  every answer, and reading `process.argv` inside the factory would put the answer
  beyond anything that does not spawn a process to get at it.
- `scripts/shots.ts` no longer empties `HOST` out of the environment it spawns the
  server with, and the paragraph explaining why it did is gone with it. That
  clearing was correct and load bearing while the variable was read — a screenshot
  run is a command whose entire visible output is a page of images, which is the
  worst possible place for an inherited wide bind to hide. It is now dead defence
  against a variable nothing reads, and dead defence is worse than none, because
  the next reader has to work out whether it still does anything.
- `test/server.test.ts` states the vulnerability rather than only the fix. `an
  exported HOST does not reach the bind` spawns the server with `HOST=0.0.0.0` in
  its environment and asserts the announced bind is still loopback, that the
  address never appears in what the process printed, and that the second startup
  line — which exists only for a wider bind — was never printed at all. The suite's
  spawn helper now fails the moment a non-loopback bind is announced instead of
  waiting out the twenty-second start deadline, because the twenty seconds between
  those two verdicts are seconds spent serving a directory to the network, and a
  test that reproduces the exposure while reporting it is not one this suite should
  contain for any longer than it must.
- The wider bind itself is still asserted at the resolver rather than by binding
  it, which is the arrangement the file already had and the reason it had it: a
  test that opened the hole the default exists to close would, for as long as it
  ran, be the thing being guarded against. `boundHost(["--host=0.0.0.0"])`
  answering `0.0.0.0` is what keeps the escape hatch from rotting, and it needs no
  socket.
