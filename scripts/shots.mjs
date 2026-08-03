// Renders the interface across a mobile viewport matrix so layout changes can be
// judged by eye instead of guessed at. This is a scratch tool, not a test: it
// asserts nothing and is deliberately absent from `npm run check`.
//
//   npm run shots
//   npm run shots -- --state=idle,dense --device=iphone-se
//   npm run shots -- --url=http://127.0.0.1:4173   (reuse a running server)

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const shotsRoot = resolve(root, "shots");

// Device entries emulate touch, user agent, and pixel density. The two
// `boundary` entries are plain viewports sitting on the breakpoint edges in
// styles.css, where layout bugs concentrate.
const PROFILES = [
  { name: "iphone-se", device: "iPhone SE", note: "320px floor" },
  { name: "reference-375", viewport: { width: 375, height: 812 }, note: "mobile design reference" },
  { name: "iphone-15", device: "iPhone 15", note: "short viewport" },
  { name: "pixel-7", device: "Pixel 7" },
  { name: "boundary-540", viewport: { width: 540, height: 900 }, note: "top of the 540px block" },
  { name: "ipad-mini", device: "iPad Mini", note: "between breakpoints" },
  { name: "boundary-800", viewport: { width: 800, height: 1000 }, note: "top of the 800px block" },
  // Above every breakpoint. Without it a rule that only ever hides something
  // inside a media query looks correct everywhere the matrix can see.
  { name: "desktop-1024", viewport: { width: 1024, height: 900 }, desktop: true, note: "no media query applies" },
];

// Each state leaves the page in the shape its name describes. Anything that
// needs a settled layout awaits its own visible marker rather than a timeout.
const STATES = [
  {
    name: "idle",
    note: "default load",
    async prepare() {},
  },
  {
    name: "playing",
    note: "transport running, playhead lit",
    async prepare(page) {
      await page.getByRole("button", { name: "Play metronome" }).click();
      await page.getByRole("button", { name: "Stop metronome" }).waitFor();
    },
  },
  {
    name: "help",
    note: "help panel open",
    async prepare(page) {
      await page.getByRole("button", { name: "Help" }).click();
      await page.locator("#help-panel").waitFor();
    },
  },
  {
    name: "presets",
    note: "preset panel open",
    async prepare(page) {
      await page.getByRole("button", { name: "Presets" }).click();
      await page.locator("#preset-panel").waitFor();
    },
  },
  {
    name: "rhythm-settings",
    note: "one rhythm expanded",
    async prepare(page) {
      await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
      await page.locator(".rhythm-settings").first().waitFor();
    },
  },
  {
    name: "wide-pattern",
    note: "7/8 at maximum subdivision — the widest rhythm grid",
    async prepare(page) {
      await page.getByRole("button", { name: "Edit 4/4", exact: true }).click();
      const settings = page.locator(".rhythm-settings").first();
      const signatureCount = settings.locator('[data-field="signature-count"]');
      await signatureCount.fill("7");
      await signatureCount.press("Tab");
      await page.locator(".rhythm-card .step").nth(6).waitFor();
      await settings.locator('[data-field="signature-unit"]').selectOption("8");
      await page.getByRole("button", { name: "Edit 7/8", exact: true }).waitFor();
      await settings.locator('[data-action="toggle-subdivision-menu"]').click();
      await page.locator(".subdivision-option").last().click();
      await page.locator(".rhythm-card .step").nth(34).waitFor();
    },
  },
  {
    name: "dense",
    note: "two cycles, extra rhythm, settings open — a representative tall layout",
    async prepare(page) {
      await page.getByRole("button", { name: "+ Cycle", exact: true }).click();
      await page.locator(".cycle-group").nth(1).waitFor();
      await page.getByRole("button", { name: "+ Rhythm" }).first().click();
      await page.locator(".rhythm-card").nth(1).waitFor();
    },
  },
];

function parseArguments(argv) {
  const options = {};
  for (const entry of argv) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(entry);
    if (!match) throw new Error(`Unrecognised argument: ${entry}`);
    options[match[1]] = match[2] ?? "true";
  }
  return options;
}

function selectBy(items, filter, label) {
  if (!filter) return items;
  const wanted = filter.split(",").map((value) => value.trim());
  const unknown = wanted.filter((value) => !items.some((item) => item.name === value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ${label}: ${unknown.join(", ")}. Available: ${items.map((item) => item.name).join(", ")}`,
    );
  }
  return items.filter((item) => wanted.includes(item.name));
}

async function waitForServer(url, signal) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (signal.exited) throw new Error("Server exited before it began serving");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error(`Server did not respond at ${url} within 10s`);
}

async function startServer(port) {
  const signal = { exited: false };
  const child = spawn("node", ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.on("exit", () => {
    signal.exited = true;
  });
  // `settle`, not `resolve`: this module imports `resolve` from node:path, and
  // shadowing it here would hand any later path work in this scope the wrong
  // binding without a word of complaint.
  const stop = () =>
    new Promise((settle) => {
      if (signal.exited) return settle();
      child.on("exit", settle);
      child.kill("SIGTERM");
    });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, signal);
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

function contextOptions(profile) {
  if (profile.device) return { ...devices[profile.device] };
  return {
    viewport: profile.viewport,
    deviceScaleFactor: 2,
    isMobile: !profile.desktop,
    hasTouch: !profile.desktop,
  };
}

// A filtered run re-shoots part of the matrix, so it keeps the shots it did not
// regenerate and folds the new ones in. Only a full run starts from empty.
async function priorShots(directory, regenerated) {
  try {
    const previous = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
    return previous.shots.filter((shot) => !regenerated.has(`${shot.state}__${shot.profile}`));
  } catch {
    return [];
  }
}

function inMatrixOrder(shots) {
  const rank = (shot) =>
    STATES.findIndex((state) => state.name === shot.state) * PROFILES.length +
    PROFILES.findIndex((profile) => profile.name === shot.profile);
  return [...shots].sort((left, right) => rank(left) - rank(right));
}

function contactSheet(shots, states, profiles) {
  const card = (shot) => `
        <figure${shot.overflows ? ' class="overflows"' : ""}>
          <a href="./${shot.file}">
            <div class="frame" style="--fold: ${(shot.foldRatio * 100).toFixed(3)}%">
              <img src="./${shot.file}" alt="${shot.state} on ${shot.profile}" loading="lazy" />
            </div>
          </a>
          <figcaption>
            <strong>${shot.profile}</strong>
            <span>${shot.viewport.width}×${shot.viewport.height} · page ${shot.pageHeight}px</span>
            ${shot.overflows ? `<em>horizontal overflow: ${shot.scrollWidth}px &gt; ${shot.viewport.width}px</em>` : ""}
          </figcaption>
        </figure>`;

  const sections = states
    .map((state) => {
      const group = shots.filter((shot) => shot.state === state.name);
      if (group.length === 0) return "";
      return `
      <section>
        <h2>${state.name}<small>${state.note}</small></h2>
        <div class="row">${group.map(card).join("")}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Polynome layout shots</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; padding: 32px; background: #0c0c0d; color: #e8e8ea;
             font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
      h1 { font-size: 1.4rem; margin: 0 0 4px; }
      .lede { margin: 0 0 32px; color: #9a9aa2; }
      h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em;
           border-bottom: 1px solid #26262b; padding-bottom: 8px; margin: 40px 0 16px; }
      h2 small { text-transform: none; letter-spacing: 0; color: #9a9aa2; margin-left: 12px; font-weight: 400; }
      .row { display: flex; gap: 20px; overflow-x: auto; align-items: flex-start; padding-bottom: 12px; }
      figure { margin: 0; flex: 0 0 auto; width: 260px; }
      .frame { position: relative; border: 1px solid #26262b; border-radius: 8px; overflow: hidden; background: #000; }
      /* The dashed line marks where the viewport ends and scrolling begins. */
      .frame::after { content: ""; position: absolute; left: 0; right: 0; top: var(--fold);
                      border-top: 1px dashed #f0b429; pointer-events: none; }
      .frame img { display: block; width: 100%; }
      figure.overflows .frame { border-color: #e5484d; }
      figcaption { display: grid; gap: 2px; padding-top: 8px; font-size: 12px; color: #9a9aa2; }
      figcaption strong { color: #e8e8ea; font-size: 13px; }
      figcaption em { color: #e5484d; font-style: normal; }
      a { text-decoration: none; }
    </style>
  </head>
  <body>
    <h1>Polynome layout shots</h1>
    <p class="lede">
      ${shots.length} shots · ${profiles.length} viewports · ${states.length} states.
      Full-page renders; the dashed line is the fold. Red borders mark horizontal overflow.
    </p>
    ${sections}
  </body>
</html>
`;
}

const options = parseArguments(process.argv.slice(2));
const profiles = selectBy(PROFILES, options.device, "device");
const states = selectBy(STATES, options.state, "state");
const outputDirectory = resolve(shotsRoot, options.out || ".");
const outputRelative = relative(shotsRoot, outputDirectory);
if (outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
  throw new Error(`Output must remain inside ${shotsRoot}`);
}

const isFullRun = !options.device && !options.state;
const regenerated = new Set(
  profiles.flatMap((profile) => states.map((state) => `${state.name}__${profile.name}`)),
);
const kept = isFullRun ? [] : await priorShots(outputDirectory, regenerated);

let stopServer = null;
let browser = null;
const shots = [];

try {
  stopServer = options.url ? null : await startServer(Number(options.port || 4175));
  const baseUrl = options.url || `http://127.0.0.1:${options.port || 4175}`;

  await mkdir(outputDirectory, { recursive: true });
  if (isFullRun) {
    const generatedFiles = [
      "index.html",
      "manifest.json",
      ...STATES.flatMap((state) => (
        PROFILES.map((profile) => `${state.name}__${profile.name}.png`)
      )),
    ];
    await Promise.all(generatedFiles.map((file) => (
      rm(resolve(outputDirectory, file), { force: true })
    )));
  }

  browser = await chromium.launch();
  for (const profile of profiles) {
    for (const state of states) {
      // A fresh context per shot keeps localStorage from leaking one state into
      // the next; the app persists its configuration.
      const context = await browser.newContext(contextOptions(profile));
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.locator(".rhythm-card").first().waitFor();
      await state.prepare(page);

      const file = `${state.name}__${profile.name}.png`;
      await page.screenshot({
        path: `${outputDirectory}/${file}`,
        fullPage: true,
        animations: "disabled",
      });

      const metrics = await page.evaluate(() => ({
        pageHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      const viewport = page.viewportSize();

      shots.push({
        file,
        state: state.name,
        profile: profile.name,
        note: profile.note ?? null,
        viewport,
        pageHeight: metrics.pageHeight,
        scrollWidth: metrics.scrollWidth,
        foldRatio: Math.min(1, viewport.height / metrics.pageHeight),
        overflows: metrics.scrollWidth > metrics.clientWidth,
      });

      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (stopServer) await stopServer();
}

// The sheet always shows everything on disk, so re-shooting one device still
// leaves a comparable set to flip through.
const all = inMatrixOrder([...kept, ...shots]);
const shownStates = STATES.filter((state) => all.some((shot) => shot.state === state.name));
const shownProfiles = PROFILES.filter((profile) => all.some((shot) => shot.profile === profile.name));

await writeFile(`${outputDirectory}/manifest.json`, `${JSON.stringify({ shots: all }, null, 2)}\n`);
await writeFile(`${outputDirectory}/index.html`, contactSheet(all, shownStates, shownProfiles));

const overflowing = all.filter((shot) => shot.overflows);
console.log(`Wrote ${shots.length} shots to ${outputDirectory}${kept.length > 0 ? ` (kept ${kept.length})` : ""}`);
console.log(`Open ${outputDirectory}/index.html`);
if (overflowing.length > 0) {
  console.log(`\nHorizontal overflow in ${overflowing.length}:`);
  for (const shot of overflowing) {
    console.log(`  ${shot.state} @ ${shot.profile}: ${shot.scrollWidth}px > ${shot.viewport.width}px`);
  }
}
