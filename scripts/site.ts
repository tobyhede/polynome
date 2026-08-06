import { buildDistribution } from "./build.ts";

const result = await buildDistribution({ target: "site" });
console.log(`Created cache-safe site assets (${result.version})`);
