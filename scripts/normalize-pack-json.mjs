// `npm pack --json` changed output shape between major versions: npm <= 11
// returns an array of pack results, npm >= 12 returns an object keyed by
// package name. Every consumer of pack output (verify-tarball.mjs, and the
// workflow steps that read `.filename`) wants one array-shaped result and
// shouldn't each have to know both shapes. Run this once, immediately after
// every `npm pack --json`, and everything downstream can assume npm <= 11's
// array shape unconditionally.
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: normalize-pack-json.mjs <input.json> <output.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inputPath, "utf8"));

let entry;
if (Array.isArray(raw)) {
  entry = raw[0];
} else if (raw && typeof raw === "object") {
  entry = Object.values(raw)[0];
}

if (!entry?.files) {
  console.error("Unrecognized `npm pack --json` output shape:");
  console.error(JSON.stringify(raw, null, 2));
  process.exit(1);
}

writeFileSync(outputPath, JSON.stringify([entry]));
