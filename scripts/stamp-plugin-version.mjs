#!/usr/bin/env node
// Writes the release version into the Claude Code plugin's manifest during
// `npm version`, so the skill shipped from this repo always names the muster
// release it describes. Runs from the `version` lifecycle hook beside
// stamp-release-notes.mjs, which git-adds what it changes into the version
// commit. test/plugin-version.test.ts fails if the two ever disagree.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_new_version ?? process.argv[2];
if (!version) {
  console.error(
    "no version: run via `npm version`, or pass one as an argument",
  );
  process.exit(1);
}

const path = "plugins/claude-code/.claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.version = version;
writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${path}: version ${version}`);
