import { buildDistribution } from "./build.mjs";

const result = await buildDistribution({ target: "single-file" });
console.log(`Created ${result.output}`);
