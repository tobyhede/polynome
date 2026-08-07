# Compute the Content-Security-Policy at build time

Both browser distributions ship a Content-Security-Policy in a
`<meta http-equiv>` element that `scripts/build.ts` writes into the finished
document. Neither policy is stated anywhere a person edits. The origins and
schemes each artifact loads from are named by the build step that assembles it —
three short lists — and every hash is taken from the artifact as written, after
the last rewrite and the last escape, over the exact text the parser will hand
each inline element.

The two policies differ, because the two artifacts are loaded differently.
`site/` is:

```
default-src 'none'; script-src 'self' 'sha256-…'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'
```

and `dist/polynome.html` is:

```
default-src 'none'; script-src 'sha256-…' 'sha256-…'; style-src 'sha256-…'; font-src data:; base-uri 'none'; form-action 'none'
```

A meta element is the only mechanism available. GitHub Pages serves what is in
the directory and offers no way to set a response header, and the single-file
distribution is a file with no server in front of it at all. That rules out the
header form, and with it `frame-ancestors`, `report-uri` and `sandbox`, which a
document-supplied policy is required to ignore. It also rules out a nonce: a
nonce has to be unpredictable and different in every response, and both artifacts
are static bytes that are served, copied and opened unchanged. What is left is
hashes, and a hash is over content that changes whenever the Accent bootstrap,
the stylesheet or the bundle changes — which is why it is computed rather than
written down.

Polynome has no live injection sink today. The one `innerHTML` write in `app.ts`
interpolates numbers derived from constants, every other region renders through
Preact's escaping, and neither bundle contains an `eval` or a `Function`
constructor. This is defence in depth, and it is worth having now because
[ADR-0021](0021-share-configurations-in-client-only-url-fragments.md) put a
decoder for attacker-supplied bytes into the startup path: a Share link is a URL
fragment that a stranger composed, decompressed and parsed before the interface
is drawn. A policy is what makes the difference between a future mistake in that
path being a defect and being an execution.

## Consequences

- The policy is not in `index.html`, and it cannot be. The source document is
  what the development server serves, and two of its inline scripts are absent
  from both artifacts. The import map resolves `preact` and `htm` out of
  `node_modules/` for a browser loading modules directly, and both builds strip
  it; the reload client is the `EventSource` listener `server.ts` splices in
  ahead of `</body>` under `--reload`, and it exists precisely so that no markup
  a build would have to strip is ever written to disk. A hash-based policy in the
  source document refuses both — measured, not reasoned about: serving the source
  document with the bootstrap's hash and nothing else reports two
  `script-src-elem` violations, one for the map and one for the client. `npm run
  dev` would lose its reload and `npm start` would lose its module resolution,
  and the artifacts — where the policy is actually wanted — would gain nothing,
  since neither carries either script. Building the policy is what lets the two
  documents differ.
- The single-file artifact names no origin. `'self'` matches nothing in a
  `file://` document — an opaque origin is not equal to itself — and this is one
  file that gets opened off disk at least as often as it gets served. The failure
  is silent and nearly convincing: with `script-src 'self'` a Chromium loading
  the artifact from disk refuses the stylesheet, the bootstrap and the bundle
  together, and because the markup is static the page still lays out. What a
  reader gets is an unstyled shell in Times with no Cycles in it, not a blank tab
  and not an error. So every source in that policy is a hash or a scheme, and the
  only scheme is the `data:` the `.woff2` dataurl loader needs. `test/bundle.test.ts`
  holds `'self'` out of it by name.
- `frame-ancestors` is absent deliberately. It is one of the three directives a
  meta element must ignore, so writing it would produce a policy that reads as
  clickjacking protection to everyone who saw it and does nothing whatsoever —
  worse than the absence, because the absence is at least visible to whoever goes
  looking. If framing needs refusing, the answer is a response header, which
  means a host that can set one, which is a different decision. `test/site.test.ts`
  and `test/bundle.test.ts` both assert it is not there.
- The starting policy was narrowed rather than widened. `img-src 'self' data:`
  was dropped: nothing in either artifact fetches an image. Every glyph in the
  interface is inline SVG, which is markup rather than a request, and the one
  image-shaped thing in the stylesheet is a `mask-image` holding a
  `linear-gradient`. `connect-src` is absent for the same reason — the
  application makes no network request of any kind, and the compression the Share
  feature uses is a stream transform rather than a fetch. Everything unnamed
  falls to `default-src 'none'`, and each directive that is named was checked by
  removing it and watching the browser refuse something: without `font-src` both
  woff2 faces are blocked and report `error` in `document.fonts`, and without
  `style-src` the site's stylesheet is refused outright. A directive nothing
  needs is a directive nobody can safely remove later.
- `form-action 'none'` governs a live element. The save panel is a real `<form>`
  with a submit button, and no navigation is ever attempted only because the
  submit handler calls `preventDefault` before anything else. That makes the
  directive free today and load-bearing the moment someone deletes that line, so
  `e2e/csp.spec.ts` saves a preset and then submits an empty name — the path that
  ends in `reportValidity` rather than a write — and asserts the policy refused
  nothing either time.
- The policy is spliced in immediately after the character encoding declaration,
  and a document without one is refused rather than shipped bare. A policy
  governs what is fetched after the parser reaches it, so a meta element arriving
  after the stylesheet link would leave exactly the thing it was added for
  ungoverned while still reading, to anyone auditing the document, as a page with
  a policy. The encoding declaration is the one thing that has to come earlier
  still. This joins the family of rewrites `scripts/build.ts` refuses instead of
  skipping, for the reason all of them are refusals: an artifact that is complete
  and quietly wrong is the failure no later assertion catches.
- A hand-written hash was rejected, and it is the alternative worth naming
  because it looks so much cheaper. It is a constant that has to change whenever
  the Accent bootstrap is edited, whenever a dependency moves a byte in the
  bundle, or whenever esbuild is upgraded — and nothing announces that it has
  stopped matching. The build succeeds, the suite passes, the artifact is
  well-formed, and the browser refuses a script while rendering the page around
  it. The whole argument for computing it is that this class of staleness has no
  symptom.
- The tests hash independently of the build, which is the only arrangement that
  proves anything. `test/site.test.ts` and `test/bundle.test.ts` read the inline
  elements out of the emitted document and take their own digests; a test calling
  `scripts/build.ts`'s own helper would agree with it about a wrong answer,
  because the two would move together. Both files also hold the regression that
  motivated the work: `default-src` is `'none'`, and no `'unsafe-'` keyword
  appears anywhere. A policy is loosened one keyword at a time by whoever is
  unblocked by it, and `'unsafe-inline'` is the entire policy undone.
- Static assertions cannot tell a matching hash from a mismatched one, so
  `e2e/csp.spec.ts` loads both artifacts in a browser — the single file over
  `file://`, the site over `http://` — and asserts that no
  `securitypolicyviolation` event fires while the interface boots and wears the
  Accent read from storage. The two halves are both necessary: `default-src *`
  would pass the first and a document with no policy at all would pass the
  second. The listener is installed with `page.addInitScript`, which is injected
  through the debugging protocol rather than parsed out of the markup and so is
  not itself governed by the policy under test — checked, because a listener the
  policy blocked would report zero violations for the happiest of wrong reasons.
- The site artifact is built inside its own spec rather than taken as found.
  `npm run test:browser` runs `npm run bundle` and not `npm run site`, so `site/`
  otherwise holds whatever a previous command happened to leave, and a policy
  checked against a stale document is not checked.
- `dist/polynome.html` grew 317 bytes, and `test/artifact-size.test.ts` rises
  from 285,000 to 286,000 to hold the real figure of 285,156. It is the one entry
  in that file whose growth does not scale with the source: three digests and
  their directives, fixed until a fourth inline element appears.
