#!/usr/bin/env node
// Writes the release version into the Claude Code plugin during `npm version`,
// so the skill shipped from this repo always names the muster release it
// describes, and the MCP server it bundles starts that same release under
// `npx`. Runs from the `version` lifecycle hook beside stamp-release-notes.mjs;
// the hook git-adds both files into the version commit.
// test/plugin-version.test.ts fails if a site disagrees with package.json, is
// not rewritten here, or is not staged by the hook.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_new_version ?? process.argv[2];
if (!version) {
  console.error(
    "no version: run via `npm version`, or pass one as an argument",
  );
  process.exit(1);
}
const { name } = JSON.parse(readFileSync("package.json", "utf8"));

const rewrite = (path, change) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`${path}: version ${version}`);
};

rewrite("plugins/claude-code/.claude-plugin/plugin.json", (manifest) => {
  manifest.version = version;
});
rewrite("plugins/claude-code/.mcp.json", (mcp) => {
  const args = mcp.mcpServers.muster.args;
  const pin = args.findIndex((a) => a.startsWith(`${name}@`));
  if (pin < 0) throw new Error(`.mcp.json: no ${name}@<version> argument`);
  args[pin] = `${name}@${version}`;
});
