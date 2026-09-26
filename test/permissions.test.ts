import { test, expect } from "vitest";
import { configSchema } from "../src/config.js";
import { runSchema, launchArgs, resolvePermissions } from "../src/guard.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { claudeConfigDir } from "../src/identity/claude.js";
const defaults = configSchema.parse({});
for (const runtime of ["codex", "claude"] as const)
  for (const kind of ["session", "task"] as const) {
    test(`${runtime} ${kind} translates normalized auto permissions`, () => {
      const request = runSchema.parse({
        runtime,
        kind,
        prompt: "hello",
        permissions: "auto",
        sandbox: "workspace-write",
      });
      expect(resolvePermissions(request, defaults)).toEqual({
        permissions: "auto",
        sandbox: "workspace-write",
      });
      const argv = launchArgs(request, defaults);
      if (runtime === "codex") {
        expect(argv).toContain("--approve-for-me");
        expect(argv).not.toContain("never");
        expect(argv).not.toContain(
          "--dangerously-bypass-approvals-and-sandbox",
        );
      } else {
        expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
        const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
        expect(settings.permissions.defaultMode).toBe("auto");
        expect(settings.sandbox).toMatchObject({
          enabled: true,
          allowUnsandboxedCommands: false,
        });
      }
    });
    test(`${runtime} ${kind} bypass requires config authorization and full access`, () => {
      const request = runSchema.parse({
        runtime,
        kind,
        prompt: "hello",
        permissions: "bypass",
        sandbox: "full-access",
      });
      expect(() => launchArgs(request, defaults)).toThrow(
        /allow_dangerous_flags/,
      );
      const argv = launchArgs(
        request,
        configSchema.parse({ allow_dangerous_flags: true }),
      );
      if (runtime === "codex")
        expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      else {
        expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(
          "bypassPermissions",
        );
        expect(
          JSON.parse(argv[argv.indexOf("--settings") + 1]!).sandbox.enabled,
        ).toBe(false);
      }
    });
  }
test("defaults, overrides and legacy config normalize without mutating config", () => {
  const req = runSchema.parse({ runtime: "codex", prompt: "hello" });
  expect(resolvePermissions(req, defaults)).toEqual({
    permissions: "deny",
    sandbox: "read-only",
  });
  const configured = configSchema.parse({
    permissions: "auto",
    sandbox: "workspace-write",
  });
  expect(resolvePermissions(req, configured)).toEqual({
    permissions: "auto",
    sandbox: "workspace-write",
  });
  expect(
    resolvePermissions(
      { ...req, permissions: "deny", sandbox: "read-only" },
      configured,
    ),
  ).toEqual({ permissions: "deny", sandbox: "read-only" });
  expect(configured.permissions).toBe("auto");
  expect(
    resolvePermissions(
      req,
      configSchema.parse({
        sandbox: "danger-full-access",
        allow_dangerous_flags: true,
      }),
    ),
  ).toEqual({ permissions: "deny", sandbox: "full-access" });
});
test("invalid combinations and raw policy overrides are refused", () => {
  for (const permissions of ["auto", "bypass"] as const)
    expect(() =>
      launchArgs(
        runSchema.parse({ runtime: "codex", prompt: "x", permissions }),
        defaults,
      ),
    ).toThrow();
  expect(() =>
    launchArgs(
      runSchema.parse({
        runtime: "claude",
        prompt: "x",
        sandbox: "full-access",
      }),
      defaults,
    ),
  ).toThrow(/allow_dangerous_flags/);
  const config = configSchema.parse({ allow_dangerous_flags: true });
  for (const flag of [
    "--approve-for-me",
    "--yolo",
    "--dangerously-skip-permissions",
    "--permission-mode=auto",
    "--sandbox=full-access",
  ])
    expect(() =>
      launchArgs(
        runSchema.parse({ runtime: "codex", prompt: "x", args: [flag] }),
        config,
      ),
    ).toThrow();
});

/**
 * A mustered session's own memory lives under $CLAUDE_CONFIG_DIR, which is not
 * the cwd and so is not in the sandbox's write root: every Bash write to it
 * failed with EPERM while the in-process file tools succeeded, so from inside
 * the session it read as a path bug rather than a boundary (#80). muster never
 * excluded the dir — it named no write roots at all and left Claude Code to
 * default to cwd plus $TMPDIR — so the fix is to say which dir it means.
 */
const claudeSettings = (argv: string[]) =>
  JSON.parse(argv[argv.indexOf("--settings") + 1]!) as {
    disableAllHooks?: boolean;
    enabledPlugins?: unknown;
    extraKnownMarketplaces?: unknown;
    permissions: { allow: string[] };
    sandbox: {
      enabled: boolean;
      filesystem: { denyWrite: string[]; allowWrite?: string[] };
    };
  };
const claudeReq = (level: "read" | "work" | "open") =>
  runSchema.parse({ runtime: "claude", kind: "task", prompt: "hello", level });

test("a workspace-write claude launch can write its own config dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-cfg-"));
  const argv = launchArgs(claudeReq("work"), defaults, [], undefined, {
    CLAUDE_CONFIG_DIR: dir,
  });
  expect(claudeSettings(argv).sandbox.filesystem).toEqual({
    denyWrite: [],
    allowWrite: [dir],
  });
});

test("the config dir falls back to $HOME/.claude when unset", () => {
  // launchEnv does not block CLAUDE_CONFIG_DIR, so the child usually inherits
  // it — but a caller that never set one still gets a real dir rather than an
  // allowWrite entry of "undefined/.claude".
  const argv = launchArgs(claudeReq("work"), defaults, [], undefined, {
    HOME: "/home/nobody",
  });
  expect(claudeSettings(argv).sandbox.filesystem.allowWrite).toEqual([
    "/home/nobody/.claude",
  ]);
});

/**
 * guard.ts carried its own copy of claudeConfigDir, and the two drifted: it
 * resolve()d the value and read a whitespace-only one as unset, while the trust
 * check and the sessions dir take it as written. A write root pointing somewhere
 * other than the dir the launch records its session in is exactly the split that
 * function's doc comment exists to prevent, so the grant is pinned against the
 * one definition instead of restating the rule. resolve() stays on this side of
 * it: only the sandbox needs an absolute path.
 */
test("the write root is the absolute form of the one config dir", () => {
  for (const CLAUDE_CONFIG_DIR of ["relative-cfg", "   "]) {
    const env = { HOME: "/home/nobody", CLAUDE_CONFIG_DIR };
    const allowWrite = claudeSettings(
      launchArgs(claudeReq("work"), defaults, [], undefined, env),
    ).sandbox.filesystem.allowWrite;
    expect(allowWrite).toEqual([resolve(claudeConfigDir(env))]);
    expect(allowWrite!.every((p) => isAbsolute(p))).toBe(true);
  }
});

test("a read-only claude launch grants no write root at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-cfg-"));
  const fs = claudeSettings(
    launchArgs(claudeReq("read"), defaults, [], undefined, {
      CLAUDE_CONFIG_DIR: dir,
    }),
  ).sandbox.filesystem;
  expect(fs).toEqual({ denyWrite: ["/"] });
  expect("allowWrite" in fs).toBe(false);
});

test("full access is unchanged: no sandbox, so no write roots to grant", () => {
  const argv = launchArgs(
    claudeReq("open"),
    configSchema.parse({ allow_dangerous_flags: true }),
    [],
    undefined,
    { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "muster-cfg-")) },
  );
  const settings = claudeSettings(argv);
  expect(settings.sandbox.enabled).toBe(false);
  expect("allowWrite" in settings.sandbox.filesystem).toBe(false);
});

/**
 * `--setting-sources ""` is deliberate — it is what stops a settings file
 * re-widening permissions.allow behind assertClaudePolicy's back — but it also
 * drops enabledPlugins, so every mustered session ran with built-in skills
 * only and none of the profile's plugins (#80, defect B). Forward the two keys
 * that name the skill set, and nothing that names policy.
 */
test("the profile's plugins are forwarded, its policy is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-cfg-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      enabledPlugins: { "conventions@example-marketplace": true },
      extraKnownMarketplaces: {
        "example-marketplace": {
          source: { source: "github", repo: "example-org/plugins" },
        },
      },
      permissions: { allow: ["Bash"], additionalDirectories: ["/etc"] },
      hooks: { SessionStart: [{ hooks: [{ command: "echo pwned" }] }] },
      sandbox: { enabled: false },
    }),
  );
  const settings = claudeSettings(
    launchArgs(claudeReq("work"), defaults, [], undefined, {
      CLAUDE_CONFIG_DIR: dir,
    }),
  );
  expect(settings.enabledPlugins).toEqual({
    "conventions@example-marketplace": true,
  });
  expect(settings.extraKnownMarketplaces).toEqual({
    "example-marketplace": {
      source: { source: "github", repo: "example-org/plugins" },
    },
  });
  // The policy keys stay muster's, whatever the profile says.
  expect(settings.permissions.allow).toEqual([]);
  expect(settings.disableAllHooks).toBe(true);
  expect(settings.sandbox.enabled).toBe(true);
});

test("an absent or unreadable profile settings file forwards nothing", () => {
  const empty = mkdtempSync(join(tmpdir(), "muster-cfg-"));
  const broken = mkdtempSync(join(tmpdir(), "muster-cfg-"));
  writeFileSync(join(broken, "settings.json"), "{ not json");
  for (const dir of [empty, broken]) {
    const settings = claudeSettings(
      launchArgs(claudeReq("work"), defaults, [], undefined, {
        CLAUDE_CONFIG_DIR: dir,
      }),
    );
    expect(settings.enabledPlugins).toBeUndefined();
    expect(settings.extraKnownMarketplaces).toBeUndefined();
    // Still a usable launch: the sandbox fix does not depend on the file.
    expect(settings.sandbox.filesystem.allowWrite).toEqual([dir]);
  }
});
