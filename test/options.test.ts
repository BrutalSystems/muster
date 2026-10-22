import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEVELS, launchArgs, runSchema } from "../src/guard.js";
import { configSchema } from "../src/config.js";
import { AGENTS } from "../src/agents.js";
import { screenWorkspace, assertOptionsSupported } from "../src/options.js";

/**
 * `--options` names something MUSTER does on the caller's behalf, which is what
 * separates it from the pass-through after `--`. A pass-through reaches the
 * runtime verbatim and is refused unless allow-listed; an option is a muster
 * concept each agent expresses in its own way, or cannot express at all.
 */
test("options are named, not free text", () => {
  expect(
    runSchema.parse({
      runtime: "claude",
      prompt: "hello",
      options: ["auto-approve-path"],
    }).options,
  ).toEqual(["auto-approve-path"]);
  expect(
    runSchema.parse({ runtime: "claude", prompt: "hello" }).options,
  ).toEqual([]);
  expect(() =>
    runSchema.parse({
      runtime: "claude",
      prompt: "hello",
      options: ["auto-approve-everything"],
    }),
  ).toThrow();
});

test("an option an agent cannot express is refused, not ignored", () => {
  // OpenCode has no workspace-trust gate at all, so there is nothing for
  // auto-approve-path to do. Silently accepting it would promise something
  // muster cannot deliver.
  expect(() =>
    assertOptionsSupported("opencode", ["auto-approve-path"], LEVELS.read),
  ).toThrow(/auto-approve-path/);
  expect(() =>
    assertOptionsSupported("claude", ["auto-approve-path"], LEVELS.read),
  ).not.toThrow();
  expect(() =>
    assertOptionsSupported("codex", ["auto-approve-path"], LEVELS.read),
  ).not.toThrow();
  expect(AGENTS.opencode.trustWorkspace).toBe(null);
});

test("a workspace that configures the session is named, not waved through", async () => {
  // Trusting a folder lets its own .claude/settings.json configure the session,
  // hooks included, and hooks run without asking. That is the whole reason the
  // dialog exists, so auto-approving it without looking would be answering a
  // question nobody read.
  const clean = await mkdtemp(join(tmpdir(), "muster-opt-"));
  expect(await screenWorkspace(clean)).toEqual([]);

  const hooked = await mkdtemp(join(tmpdir(), "muster-opt-"));
  await mkdir(join(hooked, ".claude"));
  await writeFile(
    join(hooked, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [] } }),
  );
  expect(await screenWorkspace(hooked)).toEqual([
    "hooks in .claude/settings.json",
  ]);

  const mcp = await mkdtemp(join(tmpdir(), "muster-opt-"));
  await writeFile(join(mcp, ".mcp.json"), "{}");
  expect(await screenWorkspace(mcp)).toEqual(["MCP servers in .mcp.json"]);

  // A settings.json without hooks is not a finding: it configures the editor,
  // not the session's ability to run commands.
  const plain = await mkdtemp(join(tmpdir(), "muster-opt-"));
  await mkdir(join(plain, ".claude"));
  await writeFile(
    join(plain, ".claude", "settings.json"),
    JSON.stringify({ theme: "dark" }),
  );
  expect(await screenWorkspace(plain)).toEqual([]);
});

/**
 * `--level open` launches Claude in bypassPermissions mode, and Claude stops on
 * a one-time "Bypass Permissions mode" warning before it registers. Muster
 * launches with `--setting-sources ""`, so an acceptance recorded in the
 * profile's settings.json is never read and the warning returns on every
 * launch (#45). The option accepts it for this launch, explicitly.
 */
const dangerous = configSchema.parse({ allow_dangerous_flags: true });
const claudeReq = (extra: Record<string, unknown>) =>
  runSchema.parse({ runtime: "claude", prompt: "hello", ...extra });
const settingsOf = (argv: string[]) =>
  JSON.parse(argv[argv.indexOf("--settings") + 1]!) as Record<string, unknown>;

test("accept-bypass-warning is a named option", () => {
  expect(
    runSchema.parse({
      runtime: "claude",
      prompt: "hello",
      options: ["accept-bypass-warning"],
    }).options,
  ).toEqual(["accept-bypass-warning"]);
});

test("accept-bypass-warning skips Claude's bypass warning under bypass permissions", () => {
  const argv = launchArgs(
    claudeReq({ level: "open", options: ["accept-bypass-warning"] }),
    dangerous,
  );
  expect(settingsOf(argv).skipDangerousModePermissionPrompt).toBe(true);
});

test("--level open alone does not accept the warning for the caller", () => {
  // Accepting it must be visible in the command, the way auto-approve-path is
  // for trust: bypass is the one level where that consent means something.
  const argv = launchArgs(claudeReq({ level: "open" }), dangerous);
  expect(settingsOf(argv)).not.toHaveProperty(
    "skipDangerousModePermissionPrompt",
  );
});

test("accept-bypass-warning without bypass permissions is refused, not ignored", () => {
  for (const level of ["read", "work"])
    expect(() =>
      assertOptionsSupported("claude", ["accept-bypass-warning"], {
        ...LEVELS[level as "read" | "work"],
      }),
    ).toThrow(/accept-bypass-warning/);
  expect(() =>
    assertOptionsSupported("claude", ["accept-bypass-warning"], LEVELS.open),
  ).not.toThrow();
});

test("accept-bypass-warning is refused for runtimes with no such warning", () => {
  for (const runtime of ["codex", "opencode"] as const)
    expect(() =>
      assertOptionsSupported(runtime, ["accept-bypass-warning"], LEVELS.open),
    ).toThrow(/accept-bypass-warning/);
});

/**
 * Claude holds an inbound cross-session message behind a Deny/Deliver dialog
 * when the sender's permission-mode class differs from the session's, or when
 * the sender asserts none and the session bypasses. An unattended session has
 * nobody to answer it, so the message never becomes a turn. The option sets
 * `crossSessionInbound: "accept"` in the overlay Muster passes for that launch.
 */
test("accept-cross-session is a named option", () => {
  expect(claudeReq({ options: ["accept-cross-session"] }).options).toEqual([
    "accept-cross-session",
  ]);
});

test("accept-cross-session delivers inbound messages in a sealed launch, at any level", () => {
  for (const level of ["read", "work", "open"])
    expect(
      settingsOf(
        launchArgs(
          claudeReq({ level, options: ["accept-cross-session"] }),
          dangerous,
        ),
      ).crossSessionInbound,
    ).toBe("accept");
});

test("no launch accepts cross-session messages unless it asked to", () => {
  // Accepting lets any local process that reaches the session give it work, so
  // it is never implied: not by bypass, and not by inheriting the profile.
  for (const extra of [
    { level: "open" },
    { level: "open", options: ["inherit-profile"] },
  ])
    expect(
      settingsOf(launchArgs(claudeReq(extra), dangerous)),
    ).not.toHaveProperty("crossSessionInbound");
  expect(launchArgs(claudeReq({ level: "normal" }), dangerous)).not.toContain(
    "--settings",
  );
});

test("accept-cross-session reaches the profile launches through their overlay", () => {
  // A normal-level launch passes no --settings of its own, so the option adds
  // an overlay holding only this; inherit-profile merges it into the one it has.
  const normal = launchArgs(
    claudeReq({ level: "normal", options: ["accept-cross-session"] }),
    dangerous,
  );
  expect(settingsOf(normal)).toEqual({ crossSessionInbound: "accept" });
  expect(normal).not.toContain("--setting-sources");
  const inherited = launchArgs(
    claudeReq({
      level: "open",
      options: [
        "inherit-profile",
        "accept-bypass-warning",
        "accept-cross-session",
      ],
    }),
    dangerous,
  );
  expect(settingsOf(inherited)).toEqual({
    sandbox: { enabled: false },
    skipDangerousModePermissionPrompt: true,
    crossSessionInbound: "accept",
  });
});

test("accept-cross-session is refused for runtimes with no cross-session hold", () => {
  for (const runtime of ["codex", "opencode"] as const)
    expect(() =>
      assertOptionsSupported(runtime, ["accept-cross-session"], LEVELS.open),
    ).toThrow(/accept-cross-session/);
  for (const level of ["read", "work", "open"] as const)
    expect(() =>
      assertOptionsSupported("claude", ["accept-cross-session"], LEVELS[level]),
    ).not.toThrow();
});
