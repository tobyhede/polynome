import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "site");
const version = (process.env.GITHUB_SHA || "local").slice(0, 12);
const names = {
  app: `app-${version}.js`,
  configuration: `configuration-${version}.js`,
  metronome: `metronome-${version}.js`,
  model: `model-${version}.js`,
  sharedTransport: `shared-transport-${version}.js`,
  styles: `styles-${version}.css`,
  jetBrainsMono: `jetbrains-mono-latin-${version}.woff2`,
  majorMonoDisplay: `major-mono-display-latin-${version}.woff2`,
};

const [html, stylesSource, jetBrainsMono, majorMonoDisplay, model, configuration, sharedTransport, metronome, app] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "fonts", "jetbrains-mono-latin.woff2")),
  readFile(join(root, "fonts", "major-mono-display-latin.woff2")),
  readFile(join(root, "model.js"), "utf8"),
  readFile(join(root, "configuration.js"), "utf8"),
  readFile(join(root, "shared-transport.js"), "utf8"),
  readFile(join(root, "metronome.js"), "utf8"),
  readFile(join(root, "app.js"), "utf8"),
]);

const styles = stylesSource
  .replaceAll("./fonts/jetbrains-mono-latin.woff2", `./${names.jetBrainsMono}`)
  .replaceAll("./fonts/major-mono-display-latin.woff2", `./${names.majorMonoDisplay}`);

const siteHtml = html
  .replace("./styles.css", `./${names.styles}`)
  .replace("./app.js", `./${names.app}`);
const siteSharedTransport = sharedTransport.replace(
  "./model.js",
  `./${names.model}`,
);
const siteMetronome = metronome
  .replace("./model.js", `./${names.model}`)
  .replace("./shared-transport.js", `./${names.sharedTransport}`);
const siteApp = app
  .replace("./metronome.js", `./${names.metronome}`)
  .replace("./configuration.js", `./${names.configuration}`)
  .replace("./model.js", `./${names.model}`);

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, "index.html"), siteHtml),
  writeFile(join(output, names.styles), styles),
  writeFile(join(output, names.jetBrainsMono), jetBrainsMono),
  writeFile(join(output, names.majorMonoDisplay), majorMonoDisplay),
  writeFile(join(output, names.model), model),
  writeFile(join(output, names.configuration), configuration),
  writeFile(join(output, names.sharedTransport), siteSharedTransport),
  writeFile(join(output, names.metronome), siteMetronome),
  writeFile(join(output, names.app), siteApp),
  writeFile(join(output, ".nojekyll"), ""),
]);

console.log(`Created cache-safe site assets (${version})`);
