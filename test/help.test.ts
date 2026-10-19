import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, topLevelHelp, commandHelp } from "../src/help.js";
import { asksForHelp } from "../src/cli-options.js";

const source = readFileSync(
  join(import.meta.dirname, "..", "src", "muster.ts"),
  "utf8",
);

/**
 * The drift this guards is a command shipped without an entry: `--help` is the
 * only place a person finds out a command exists, and nothing else fails when
 * one is missing from it.
 */
test("every command the CLI dispatches appears in the table", () => {
  const dispatched = new Set(
    [...source.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]!),
  );
  // Reached by its own branch rather than the dispatch chain, so the regex
  // above cannot see it.
  dispatched.add("mcp");
  // Armed by muster itself as a tmux job and never typed by a person, so it is
  // deliberately absent from the help table. See `reapCheck` in src/reap.ts.
  dispatched.delete("reap-check");
  // Started detached by `run --on-exit`, never typed. See `runOnExit`.
  dispatched.delete("on-exit-watch");
  const documented = new Set(COMMANDS.map((c) => c.name));
  expect([...dispatched].filter((name) => !documented.has(name))).toEqual([]);
});

/**
 * The complaint that started this: the old help's usage line was 140 characters
 * and wrapped into unreadability at any ordinary width.
 */
test("no help line is wider than eighty columns", () => {
  const wide = [topLevelHelp(), ...COMMANDS.map((c) => commandHelp(c.name)!)]
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.length > 80);
  expect(wide).toEqual([]);
});

test("a command's help names the flags that command requires", () => {
  expect(commandHelp("setup-identity")).toContain("--identity");
  expect(commandHelp("setup-identity")).toContain("--agent");
  expect(commandHelp("run")).toContain("--prompt");
  expect(commandHelp("stop")).toContain("<id>");
});

test("the top level lists every command and points at per-command help", () => {
  const top = topLevelHelp();
  for (const command of COMMANDS) expect(top).toContain(command.name);
  expect(top).toContain("muster <command> --help");
});

test("an unknown command has no help", () => {
  expect(commandHelp("nope")).toBeUndefined();
});

/**
 * A caller probes `muster run claude --help` for `--plugin-dir` before passing
 * it, so the flag must be named there, not only in docs/cli.md.
 */
test("run's help names --plugin-dir, and that a sealed launch refuses it", () => {
  expect(asksForHelp(["claude", "--help"])).toBe(true);
  const help = commandHelp("run")!;
  expect(help).toContain("--plugin-dir");
  expect(help).toMatch(/--plugin-dir[^\n]*\n?[^\n]*sealed/);
});
