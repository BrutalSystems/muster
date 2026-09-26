#!/usr/bin/env node
// Turns the `## Unreleased` section of RELEASE_NOTES.md into
// `## <version> — <date>` during `npm version`, so cutting a release is one
// command rather than two.
//
// Runs from the `version` lifecycle hook: npm has already written the new
// version into package.json and exposes it as npm_new_version, and whatever
// this script git-adds lands in the version commit alongside it.
//
// It refuses rather than inventing content. extract-release-notes.mjs rejects
// a missing, placeholder or empty section when publish.yml runs, so failing
// here — before the tag exists — is strictly better than failing in CI after
// it, when the tag has to be deleted and re-pushed.
//
// The stamped heading must satisfy extract-release-notes.mjs: it matches
// `## <version> ` by prefix, and must not match its unreleased/placeholder
// pattern.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_new_version ?? process.argv[2];
if (!version) {
  console.error(
    "no version: run via `npm version`, or pass one as an argument",
  );
  process.exit(1);
}

const path = "RELEASE_NOTES.md";
const lines = readFileSync(path, "utf8").split("\n");

const startIndex = lines.findIndex((line) =>
  /^##\s+(unreleased|prepared, not yet published)\b/i.test(line.trim()),
);
if (startIndex === -1) {
  console.error(
    `${path}: no "## Unreleased" section. Write the notes for ${version} under that heading first.`,
  );
  process.exit(1);
}

const endIndex = lines.findIndex(
  (line, i) => i > startIndex && line.startsWith("## "),
);
const section = lines
  .slice(startIndex + 1, endIndex === -1 ? undefined : endIndex)
  .join("\n")
  .trim();
if (!section) {
  console.error(
    `${path}: the "## Unreleased" section is empty — nothing to release for ${version}.`,
  );
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
lines[startIndex] = `## ${version} — ${date}`;
writeFileSync(path, lines.join("\n"));
console.log(`${path}: stamped "## ${version} — ${date}"`);
