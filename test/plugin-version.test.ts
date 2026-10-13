import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
