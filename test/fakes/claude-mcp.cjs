#!/usr/bin/env node
// A stand-in for `claude mcp add|remove --scope user`, for the install tests.
// It records every call and applies it to $CLAUDE_CONFIG_DIR/.claude.json —
// always a test's temporary directory, never a real profile.
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) {
  process.stderr.write("fake claude: CLAUDE_CONFIG_DIR is required\n");
  process.exit(2);
}
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\n");
const file = path.join(dir, ".claude.json");
const config = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {};
config.mcpServers ??= {};
const [group, verb] = args;
if (group !== "mcp" || args[2] !== "--scope" || args[3] !== "user") {
  process.stderr.write(`fake claude: unexpected ${args.join(" ")}\n`);
  process.exit(2);
}
const name = args[4];
if (verb === "add") {
  if (config.mcpServers[name]) {
    process.stderr.write(`MCP server ${name} already exists in user config\n`);
    process.exit(1);
  }
  const rest = args.slice(args.indexOf("--") + 1);
  config.mcpServers[name] = {
    type: "stdio",
    command: rest[0],
    args: rest.slice(1),
    env: {},
  };
} else if (verb === "remove") {
  if (!config.mcpServers[name]) {
    process.stderr.write(`No MCP server named ${name}\n`);
    process.exit(1);
  }
  delete config.mcpServers[name];
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(config, null, 2));
