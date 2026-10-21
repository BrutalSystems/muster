import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The Claude Code plugin's skill describes one muster release, so its manifest
 * carries that release's version. `npm version` stamps it through
 * scripts/stamp-plugin-version.mjs; this catches a hand bump of either file
 * that forgot the other.
 */
const repoJson = (rel: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", rel), "utf8"));

test("the Claude Code plugin is versioned with the package", () => {
  const pkg = repoJson("package.json");
  const plugin = repoJson("plugins/claude-code/.claude-plugin/plugin.json");
  expect(plugin.name).toBe("muster");
  expect(plugin.version).toBe(pkg.version);
});

test("the marketplace points at the plugin", () => {
  const market = repoJson(".claude-plugin/marketplace.json");
  expect(market.plugins).toHaveLength(1);
  expect(market.plugins[0].name).toBe("muster");
  expect(market.plugins[0].source).toBe("./plugins/claude-code");
});

/**
 * The plugin also bundles the MCP server, started with `npx` at a pinned
 * release. A stale pin would hand every plugin user the previous server, so
 * the pin is a version site like the manifest.
 */
const mcpArgs = (json: any): string[] => json.mcpServers.muster.args;

test("the plugin's bundled server is pinned to the package version, read-only", () => {
  const pkg = repoJson("package.json");
  const mcp = repoJson("plugins/claude-code/.mcp.json");
  expect(mcp.mcpServers.muster.command).toBe("npx");
  expect(mcpArgs(mcp)).toEqual(["-y", `${pkg.name}@${pkg.version}`, "mcp"]);
  // Installing a plugin is not the deliberate launch grant.
  expect(mcpArgs(mcp)).not.toContain("--allow-launch");
});

const MANIFEST = "plugins/claude-code/.claude-plugin/plugin.json";
const MCP = "plugins/claude-code/.mcp.json";
const SITES = [MANIFEST, MCP];

test("the stamp script rewrites every version site", async () => {
  const root = join(import.meta.dirname, "..");
  const dir = await mkdtemp(join(tmpdir(), "muster-stamp-"));
  try {
    await cp(join(root, "plugins"), join(dir, "plugins"), { recursive: true });
    await cp(join(root, "package.json"), join(dir, "package.json"));
    execFileSync(
      process.execPath,
      [join(root, "scripts/stamp-plugin-version.mjs"), "99.0.0"],
      { cwd: dir, stdio: "pipe" },
    );
    const at = async (rel: string) =>
      JSON.parse(await readFile(join(dir, rel), "utf8"));
    expect((await at(MANIFEST)).version).toBe("99.0.0");
    expect(mcpArgs(await at(MCP))).toEqual([
      "-y",
      "@brutalsystems/muster@99.0.0",
      "mcp",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the version hook stages every site the stamp script rewrites", () => {
  // A site rewritten but not `git add`ed is left out of the version commit,
  // so the tag ships the old pin while the working tree shows the new one.
  const hook: string = repoJson("package.json").scripts.version;
  const added = hook.slice(hook.indexOf("git add") + "git add".length);
  for (const site of SITES) expect(added.split(/\s+/)).toContain(site);
});
