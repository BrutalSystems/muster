/**
 * Muster's own home holds the machine's policy — `allow_dangerous_flags`, the
 * requester grants, the MCP server commands muster runs for later launches —
 * so no launched agent may write it, at any level short of `open` (#44).
 * Before this, a `work` launch whose cwd was `~/.muster` or an ancestor of it
 * (such as `~`) wrote it freely, because the cwd write grant covers it.
 */
import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import {
  assertMusterHomeProtectable,
  launchArgs,
  resolvePermissions,
  runSchema,
} from "../src/guard.js";
import { PtyHost } from "../src/hosts/pty.js";
import { Muster } from "../src/run.js";
import { fixture } from "./helpers.js";

const defaults = configSchema.parse({});

/** A fake `$HOME` whose `.muster` is reached through a symlink, so the real
 *  path and the written one differ. */
function homes() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muster-home-")));
  const real = join(root, "real-muster");
  mkdirSync(real);
  const home = join(root, "home");
  mkdirSync(home);
  const link = join(home, ".muster");
  symlinkSync(real, link);
  return { root, home, link, real };
}

const req = (
  runtime: "claude" | "codex" | "opencode",
  cwd: string,
  extra: Record<string, unknown> = { level: "work" },
) => runSchema.parse({ runtime, kind: "task", prompt: "hello", cwd, ...extra });

const claudeSettings = (argv: string[]) =>
  JSON.parse(argv[argv.indexOf("--settings") + 1]!) as {
    permissions: { deny: string[] };
    sandbox: { filesystem: { denyWrite: string[]; allowWrite?: string[] } };
  };

test("a claude work launch cannot write muster's home, by either spelling", () => {
  const h = homes();
  const settings = claudeSettings(
    launchArgs(req("claude", h.home), defaults, [], undefined, {}, h.link),
  );
  // The OS sandbox covers Bash; it compares real paths, but both are named so
  // this does not rest on Claude normalising them.
  expect(settings.sandbox.filesystem.denyWrite).toEqual([h.link, h.real]);
  // The in-process file tools are outside the OS sandbox, so they need their
  // own rules. `//` is Claude's spelling of an absolute path, and an Edit rule
  // covers Write and NotebookEdit too; Claude warns that a `Write(path)` rule
  // is never matched, so none is emitted.
  expect(settings.permissions.deny).toEqual([
    `Edit(/${h.link}/**)`,
    `Edit(/${h.real}/**)`,
  ]);
});

test("a claude workspace-write launch through the flags is protected too", () => {
  const h = homes();
  const settings = claudeSettings(
    launchArgs(
      req("claude", h.home, {
        permissions: "deny",
        sandbox: "workspace-write",
      }),
      defaults,
      [],
      undefined,
      {},
      h.link,
    ),
  );
  expect(settings.sandbox.filesystem.denyWrite).toEqual([h.link, h.real]);
});

test("a claude read launch is unchanged: its cwd is its only deny", () => {
  const h = homes();
  const settings = claudeSettings(
    launchArgs(
      req("claude", h.home, { level: "read" }),
      defaults,
      [],
      undefined,
      {},
      h.link,
    ),
  );
  expect(settings.sandbox.filesystem.denyWrite).toEqual([h.home]);
  expect(settings.permissions.deny).toEqual(["Edit", "Write", "NotebookEdit"]);
});

/** Every `-c key=value` pair codex is handed, as a map. */
function codexConfig(argv: string[]) {
  const out: Record<string, string> = {};
  argv.forEach((arg, i) => {
    if (arg !== "-c") return;
    const pair = argv[i + 1]!;
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  return out;
}

for (const extra of [
  { level: "work" },
  { permissions: "deny", sandbox: "workspace-write" },
] as const)
  test(`a codex ${JSON.stringify(extra)} launch makes muster's home read-only`, () => {
    const h = homes();
    const argv = launchArgs(
      req("codex", h.home, extra),
      defaults,
      [],
      undefined,
      {},
      h.link,
    );
    const c = codexConfig(argv);
    // A permissions profile is the only codex config that can carve a
    // read-only path out of a writable root, and `--sandbox` overrides one, so
    // the profile replaces the flag rather than joining it.
    expect(argv).not.toContain("--sandbox");
    expect(c.default_permissions).toBe('"muster_work"');
    expect(c["permissions.muster_work.extends"]).toBe('":workspace"');
    const fs = c["permissions.muster_work.filesystem"]!;
    expect(fs).toContain(`"${h.link}" = "read"`);
    expect(fs).toContain(`"${h.real}" = "read"`);
  });

test("a codex read launch is unchanged", () => {
  const h = homes();
  const argv = launchArgs(
    req("codex", h.home, { level: "read" }),
    defaults,
    [],
    undefined,
    {},
    h.link,
  );
  expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(argv.join(" ")).not.toContain("default_permissions");
});

/**
 * OpenCode's permissions are tool policy: an `edit` rule can name a path, but a
 * shell command cannot be confined to one, and `bash` is what `work` grants. So
 * the one thing that holds is never to hand it a cwd that contains the home.
 * A cwd elsewhere leaves the home outside it, where `external_directory` is
 * already denied at `work`.
 */
test("an opencode work launch is refused when its cwd overlaps muster's home", () => {
  const h = homes();
  const work = resolvePermissions(req("opencode", h.home), defaults);
  for (const cwd of [h.home, h.link, h.real, join(h.real), h.root])
    expect(() =>
      assertMusterHomeProtectable("opencode", cwd, work, h.link),
    ).toThrow(/muster's own home/);
  // Inside the home, reached through the link.
  mkdirSync(join(h.real, "sub"));
  expect(() =>
    assertMusterHomeProtectable("opencode", join(h.link, "sub"), work, h.link),
  ).toThrow(/muster's own home/);
  // A cwd that only shares a prefix with it, or sits beside it, is fine.
  const beside = join(h.root, "real-muster-other");
  mkdirSync(beside);
  expect(() =>
    assertMusterHomeProtectable("opencode", beside, work, h.link),
  ).not.toThrow();
});

test("a symlink to the home's ancestor does not hide the overlap", () => {
  const h = homes();
  const work = resolvePermissions(req("opencode", h.home), defaults);
  const alias = join(h.root, "alias");
  symlinkSync(h.root, alias);
  expect(() =>
    assertMusterHomeProtectable("opencode", alias, work, h.link),
  ).toThrow(/muster's own home/);
});

test("opencode read, and the runtimes with a path deny, are not refused", () => {
  const h = homes();
  const read = resolvePermissions(
    req("opencode", h.home, { level: "read" }),
    defaults,
  );
  expect(() =>
    assertMusterHomeProtectable("opencode", h.home, read, h.link),
  ).not.toThrow();
  const work = resolvePermissions(req("claude", h.home), defaults);
  for (const runtime of ["claude", "codex"] as const)
    expect(() =>
      assertMusterHomeProtectable(runtime, h.home, work, h.link),
    ).not.toThrow();
});

test("Muster refuses that opencode launch before reserving anything", async () => {
  // The fixture's muster home is `<root>/muster`, so `root` is its ancestor —
  // the `--cwd "$HOME"` case from the issue.
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "opencode",
        prompt: "copy the config",
        cwd: f.root,
        host: "pty",
        level: "work",
      }),
    ).rejects.toThrow(/muster's own home/);
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});
