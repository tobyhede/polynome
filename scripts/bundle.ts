import { buildDistribution } from "./build.ts";

const result = await buildDistribution({ target: "single-file" });
console.log(`Created ${result.output}`);
