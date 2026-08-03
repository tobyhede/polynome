import { buildDistribution } from "./build.mjs";

const result = await buildDistribution({ target: "site" });
console.log(`Created cache-safe site assets (${result.version})`);
