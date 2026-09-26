// Extracts the `## <version>` section from RELEASE_NOTES.md for use as a
// GitHub Release body. Fails if the section is missing or still marked as
// unreleased/prepared-but-not-published, so a forgotten pre-tag step is
// caught before publishing rather than after.
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: extract-release-notes.mjs <version>");
  process.exit(1);
}

const notes = readFileSync("RELEASE_NOTES.md", "utf8");
const lines = notes.split("\n");

const startIndex = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
if (startIndex === -1) {
  console.error(`No "## ${version}" section found in RELEASE_NOTES.md.`);
  process.exit(1);
}

const heading = lines[startIndex];
if (/prepared, not yet published|unreleased/i.test(heading)) {
  console.error(`RELEASE_NOTES.md still marks ${version} as unreleased: "${heading}"`);
  console.error("Finalize the heading (date, not a placeholder) before tagging.");
  process.exit(1);
}

const endIndex = lines.findIndex((line, i) => i > startIndex && line.startsWith("## "));
const section = lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex).join("\n").trim();

if (!section) {
  console.error(`Section "## ${version}" in RELEASE_NOTES.md is empty.`);
  process.exit(1);
}

process.stdout.write(`${section}\n`);
