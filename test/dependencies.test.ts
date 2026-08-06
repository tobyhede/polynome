import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolving against this file rather than the working directory lets the test
// run from anywhere, not only from the repository root.
const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
const nvmrc = fileURLToPath(new URL("../.nvmrc", import.meta.url));

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Only the three fields these tests assert on are named. A manifest holds far
 * more, but describing the rest here would be a second copy of it to keep in
 * step, and the point of each test below is what its own field says.
 */
async function readManifest(): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}> {
  return JSON.parse(await readFile(manifest, "utf8"));
}

/**
 * A runtime dependency's code is copied into both distributions, so its version
 * is part of what ships and a range means two builds of the same commit can
 * disagree. esbuild is pinned for the same reason from the other side — it
 * decides the bytes rather than supplies them — and Playwright is left to float
 * because nothing it does reaches a user.
 *
 * The lockfile already makes an install reproducible; this is about the version
 * the manifest itself asks for, which is what a fresh `npm install`, a bot
 * bumping a range, or a reader deciding what is deployed all go by.
 */
test("every runtime dependency is pinned to an exact version", async () => {
  const { dependencies = {} } = await readManifest();

  assert.ok(
    Object.keys(dependencies).length,
    "Expected the manifest to declare the runtime dependencies this asserts on",
  );
  assert.deepEqual(
    Object.entries(dependencies).filter(([, range]) => !EXACT.test(range)),
    [],
  );
});

/**
 * esbuild reaches no user directly, but it decides the bytes both distributions
 * ship, so a range lets two builds of one commit differ in exactly the way the
 * exact runtime pins above exist to prevent. AGENTS.md states that rule; this
 * is what holds it.
 *
 * The declaration is asserted before the pin because the check is otherwise
 * vacuous the moment the entry is renamed or dropped: an absent devDependency
 * has no range to fail on, and a bundler that has quietly stopped being pinned
 * looks identical to one that is.
 */
test("esbuild is pinned to an exact version", async () => {
  const { devDependencies = {} } = await readManifest();

  assert.ok(
    Object.hasOwn(devDependencies, "esbuild"),
    "Expected the manifest to declare esbuild, whose pin this asserts",
  );
  assert.match(devDependencies.esbuild, EXACT);
});

/**
 * The two checks below compare a concrete Node version against `engines.node`,
 * and both are only meaningful if that field is a single lower bound. A
 * compound range — `>=22.18.0 <23`, or two clauses joined by `||` — would be
 * read as its first clause by anything this simple and silently stop testing
 * the rest, so anything but a bare `>=x.y.z` is refused rather than
 * approximated. Widening the declaration is then a deliberate act that has to
 * teach this helper the new shape first.
 */
function declaredFloor(engines: { node?: string } | undefined) {
  const declared = engines?.node;

  assert.ok(typeof declared === "string", "Expected the manifest to declare engines.node");

  const floor = declared.match(/^>=(\d+)\.(\d+)\.(\d+)$/);

  assert.ok(
    floor,
    `engines.node must be a bare >=x.y.z floor for this suite to compare against, not ${declared}`,
  );
  return floor.slice(1, 4).map(Number);
}

/**
 * Only the three release numbers are compared, so a version must carry all
 * three to be read at all. That is what rejects a bare major such as `22`: it
 * names no release, and it is the one shape `.nvmrc` can hold that leaves the
 * selected version up to whichever releases happen to be installed.
 *
 * A prerelease is rejected rather than truncated to the release it precedes.
 * `22.18.0-nightly` sorts *below* `22.18.0`, so reading it as those three
 * numbers would let a build that predates the floor be counted as meeting it —
 * and this floor exists because the API arrived in the release itself. Nothing
 * this project runs on names one, so the honest answer to one turning up is to
 * stop rather than to guess which side of the line it falls.
 */
function releaseParts(version: string, source: string) {
  const parts = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);

  assert.ok(parts, `${source} must name an exact released x.y.z version, not ${version}`);
  return parts.slice(1, 4).map(Number);
}

function satisfies(version: number[], floor: number[]) {
  for (const [index, part] of version.entries()) {
    if (part !== floor[index]) return part > floor[index];
  }
  return true;
}

/**
 * `.nvmrc` is what `nvm use` and CI's `actions/setup-node` both read, and nvm
 * has no way to express a range: a bare major resolves against whichever
 * releases are installed locally, which can be one below the floor. So the file
 * names an exact release, and this asserts it is not below what the manifest
 * declares — a floor nothing selects is a floor nobody runs.
 */
test(".nvmrc names an exact Node that satisfies engines.node", async () => {
  const { engines } = await readManifest();
  const floor = declaredFloor(engines);
  const pinned = (await readFile(nvmrc, "utf8")).trim();

  assert.ok(
    satisfies(releaseParts(pinned, ".nvmrc"), floor),
    `.nvmrc pins ${pinned}, which is below the ${engines.node} that engines.node declares`,
  );
});

/**
 * The floor is a claim about which Node can run this repository at all, and
 * nothing else here would notice it being wrong: the suite runs under whatever
 * Node was invoked, so a floor raised past that version fails no other test
 * while making every install refuse. Checking the running version turns the
 * declaration into something the test run itself stands behind.
 */
test("the Node running this suite satisfies engines.node", async () => {
  const { engines } = await readManifest();
  const floor = declaredFloor(engines);

  assert.ok(
    satisfies(releaseParts(process.version, "process.version"), floor),
    `this suite is running on ${process.version}, below the ${engines.node} that engines.node declares`,
  );
});
