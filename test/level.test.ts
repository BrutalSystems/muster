import { expect, test } from "vitest";
import { configSchema } from "../src/config.js";
import {
  LEVELS,
  assertLevelExclusive,
  resolvePermissions,
  normalizeOpenFlag,
  resolveTerminal,
  usesTerminalFlag,
  runSchema,
} from "../src/guard.js";

const defaults = configSchema.parse({});
// The pair this config resolves to (deny + workspace-write) must match no
// level's pair, so that every level's equivalence case below can only pass
// if the level branch actually dispatches rather than falling through to
// config. deny + workspace-write is legal without allow_dangerous_flags, is
// not read (differs in sandbox), not work (differs in permissions), and not
// open (differs in both).
const unmatched = configSchema.parse({
  permissions: "deny",
  sandbox: "workspace-write",
});
const unmatchedDangerous = configSchema.parse({
  permissions: "deny",
  sandbox: "workspace-write",
  allow_dangerous_flags: true,
});
const req = (extra: Record<string, unknown>) =>
  runSchema.parse({ runtime: "codex", prompt: "hello", ...extra });

test("each level resolves to exactly the pair it spells", () => {
  for (const [level, pair] of Object.entries(LEVELS)) {
    const config = level === "open" ? unmatchedDangerous : unmatched;
    expect(resolvePermissions(req({ level }), config)).toEqual(pair);
    expect(resolvePermissions(req(pair), config)).toEqual(
      resolvePermissions(req({ level }), config),
    );
  }
});

test("the baseline config matches no level, which is what makes the cases above discriminate", () => {
  const baseline = {
    permissions: unmatched.permissions,
    sandbox: unmatched.sandbox,
  };
  for (const [name, pair] of Object.entries(LEVELS))
    expect(baseline, `baseline must not equal LEVELS.${name}`).not.toEqual(
      pair,
    );
});

test("a level overrides the machine's configured defaults rather than deferring to them", () => {
  // `unmatched` resolves to deny + workspace-write with no level named.
  expect(resolvePermissions(req({}), unmatched)).toEqual({
    permissions: "deny",
    sandbox: "workspace-write",
  });
  // Naming read must win over those defaults. This is the assertion that
  // fails if the level branch is removed.
  expect(resolvePermissions(req({ level: "read" }), unmatched)).toEqual({
    permissions: "deny",
    sandbox: "read-only",
  });
});

test("open is still gated on local config authorization", () => {
  expect(() => resolvePermissions(req({ level: "open" }), defaults)).toThrow(
    /allow_dangerous_flags/,
  );
});

test("naming a level and a flag is a contradiction, not a precedence rule", () => {
  for (const clash of [
    { level: "read", permissions: "deny" },
    { level: "read", sandbox: "read-only" },
  ])
    expect(() => assertLevelExclusive(clash)).toThrow(/level or permissions/);
  expect(() => assertLevelExclusive({ level: "read" })).not.toThrow();
  expect(() => assertLevelExclusive({ permissions: "deny" })).not.toThrow();
  expect(() => assertLevelExclusive("not an object")).not.toThrow();
});

test("the flags keep working with no level named", () => {
  expect(
    resolvePermissions(
      req({ permissions: "deny", sandbox: "workspace-write" }),
      defaults,
    ),
  ).toEqual({ permissions: "deny", sandbox: "workspace-write" });
});

/**
 * `--open` used to mean Terminal.app and nothing else: the app was hardcoded in
 * `launch`, so a developer on Ghostty or iTerm2 passed `--terminal` on every
 * launch with nowhere to state it once. The request still wins where it names
 * one; config is what `--open` alone now means.
 */
test("the terminal for --open comes from config when the launch names none", () => {
  const ghostty = configSchema.parse({ terminal: "ghostty" });
  expect(resolveTerminal({}, ghostty)).toBe("ghostty");
  expect(resolveTerminal({ terminal: "iterm2" }, ghostty)).toBe("iterm2");
  // "auto" is a request to decide, not a literal app, and config decides.
  expect(resolveTerminal({ terminal: "auto" }, ghostty)).toBe("ghostty");
  // Terminal.app remains the answer when nothing anywhere names one, since it
  // is the only terminal every macOS is guaranteed to have.
  expect(resolveTerminal({}, defaults)).toBe("terminal");
  expect(resolveTerminal({ terminal: "auto" }, defaults)).toBe("terminal");
});

/**
 * `--open` takes an optional value, which `parseArgs` cannot express: a boolean
 * option refuses `--open=ghostty` in strict mode, and a string option refuses a
 * bare `--open`. So the value is lifted onto `--terminal` before parsing, which
 * reuses the plumbing that already existed rather than adding a second path.
 */
test("--open may name its terminal, and everything after -- is left alone", () => {
  expect(normalizeOpenFlag(["run", "claude", "--open"])).toEqual([
    "run",
    "claude",
    "--open",
  ]);
  expect(normalizeOpenFlag(["run", "claude", "--open", "ghostty"])).toEqual([
    "run",
    "claude",
    "--open",
    "--terminal",
    "ghostty",
  ]);
  expect(normalizeOpenFlag(["--open=iterm2", "--prompt", "hi"])).toEqual([
    "--open",
    "--terminal",
    "iterm2",
    "--prompt",
    "hi",
  ]);
  // A following flag is not a value.
  expect(normalizeOpenFlag(["--open", "--prompt", "hi"])).toEqual([
    "--open",
    "--prompt",
    "hi",
  ]);
  // Runtime options are the runtime's business, including a literal --open.
  expect(
    normalizeOpenFlag(["run", "claude", "--open", "--", "--open", "ghostty"]),
  ).toEqual(["run", "claude", "--open", "--", "--open", "ghostty"]);
  // An unknown app is still lifted, so the schema reports it by name rather
  // than it silently becoming a runtime argument.
  expect(normalizeOpenFlag(["--open", "ghosty"])).toEqual([
    "--open",
    "--terminal",
    "ghosty",
  ]);
});

test("a typed --terminal is deprecated, but the one --open lifts is not", () => {
  // The deprecation notice must not fire for muster's own rewriting: every
  // `--open ghostty` becomes `--terminal ghostty` before parseArgs sees it, so
  // the raw argv is the only place the distinction still exists.
  expect(usesTerminalFlag(["run", "claude", "--terminal", "ghostty"])).toBe(
    true,
  );
  expect(usesTerminalFlag(["run", "claude", "--terminal=ghostty"])).toBe(true);
  expect(usesTerminalFlag(["run", "claude", "--open", "ghostty"])).toBe(false);
  expect(usesTerminalFlag(["run", "claude", "--open"])).toBe(false);
  // Runtime options are the runtime's, and a --terminal after -- is not ours to
  // deprecate.
  expect(usesTerminalFlag(["run", "claude", "--", "--terminal", "x"])).toBe(
    false,
  );
});
