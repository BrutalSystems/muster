import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  claudeSessionsDir,
  claudeWorkspaceTrusted,
  claudeRegistryDiagnostic,
} from "../src/identity/claude.js";
import { assertClaudePolicy } from "../src/claude-policy.js";
import { NEUTRALISED, fixture } from "./helpers.js";

test("sessions are found under CLAUDE_CONFIG_DIR when it is set", () => {
  expect(claudeSessionsDir({ HOME: "/home/u" })).toBe(
    "/home/u/.claude/sessions",
  );
  expect(
    claudeSessionsDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "/copy/cfg" }),
  ).toBe("/copy/cfg/sessions");
});

test("an empty CLAUDE_CONFIG_DIR falls back to HOME rather than resolving to /sessions", () => {
  expect(claudeSessionsDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "" })).toBe(
    "/home/u/.claude/sessions",
  );
});

test("a custom CLAUDE_CONFIG_DIR is no longer refused, because discovery follows it", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-disc-"));
  const cfg = join(home, "cfg");
  await mkdir(cfg, { recursive: true });
  // assertClaudePolicy refuses detected MANAGED policy sources, which is a
  // separate concern it must keep doing. Here there are none.
  await expect(
    assertClaudePolicy({ HOME: home, CLAUDE_CONFIG_DIR: cfg }),
  ).resolves.toBeUndefined();
});

test("managed policy is still refused, with or without a config dir", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-disc-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  // assertClaudePolicy reads ~/.claude/remote-settings.json as a managed source
  // (confirmed against src/claude-policy.ts and the existing coverage in
  // test/policy.test.ts, "Claude refuses detected managed policy..."), not
  // managed-settings.json — that name is only checked under the system-level
  // ClaudeCode directory, not under HOME.
  await writeFile(
    join(home, ".claude", "remote-settings.json"),
    JSON.stringify({ permissions: {} }),
  );
  await expect(assertClaudePolicy({ HOME: home })).rejects.toThrow();
});

test("a fixture never inherits a config-relocating variable from the developer's shell", async () => {
  // Now that the policy refusal is gone and the fake honours CLAUDE_CONFIG_DIR,
  // an inherited value would make fixture launches write session records into
  // the developer's REAL configuration directory. Running a second account by
  // exporting one of these is an ordinary thing to do.
  const before = NEUTRALISED.map((k) => process.env[k]);
  try {
    for (const key of NEUTRALISED) process.env[key] = "/the/developers/own/dir";
    const f = await fixture();
    for (const key of NEUTRALISED) expect(f.env[key]).toBeUndefined();
    // A test that wants one still gets it.
    const chosen = await fixture({ CLAUDE_CONFIG_DIR: "/chosen" });
    expect(chosen.env.CLAUDE_CONFIG_DIR).toBe("/chosen");
  } finally {
    NEUTRALISED.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});

test("a directory the profile has accepted the trust dialog for reads as trusted", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-trust-"));
  const cfg = join(home, "cfg");
  await mkdir(cfg, { recursive: true });
  await writeFile(
    join(cfg, ".claude.json"),
    JSON.stringify({
      projects: { "/work/dir": { hasTrustDialogAccepted: true } },
    }),
  );
  await expect(
    claudeWorkspaceTrusted({ HOME: home, CLAUDE_CONFIG_DIR: cfg }, "/work/dir"),
  ).resolves.toBe(true);
});

test("trust is not inherited from a trusted parent directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-trust-"));
  const cfg = join(home, "cfg");
  await mkdir(cfg, { recursive: true });
  await writeFile(
    join(cfg, ".claude.json"),
    JSON.stringify({
      projects: { "/Source/arm": { hasTrustDialogAccepted: true } },
    }),
  );
  await expect(
    claudeWorkspaceTrusted(
      { HOME: home, CLAUDE_CONFIG_DIR: cfg },
      "/Source/arm/centrumx",
    ),
  ).resolves.toBe(false);
});

test("a profile with no .claude.json at all reads as untrusted, not as an error", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-trust-"));
  const cfg = join(home, "cfg");
  await mkdir(cfg, { recursive: true });
  await expect(
    claudeWorkspaceTrusted({ HOME: home, CLAUDE_CONFIG_DIR: cfg }, "/work/dir"),
  ).resolves.toBe(false);
});

test("a .claude.json that exists but does not parse reads as untrusted", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-trust-"));
  const cfg = join(home, "cfg");
  await mkdir(cfg, { recursive: true });
  await writeFile(join(cfg, ".claude.json"), "{ not json");
  await expect(
    claudeWorkspaceTrusted({ HOME: home, CLAUDE_CONFIG_DIR: cfg }, "/work/dir"),
  ).resolves.toBe(false);
});

test("an untrusted directory is named in the diagnostic, with the one-time fix", () => {
  const msg = claudeRegistryDiagnostic(false, "/Source/arm/centrumx", "/cfg");
  expect(msg).toMatch("/Source/arm/centrumx");
  expect(msg).toMatch("/cfg");
  expect(msg).toMatch("cd /Source/arm/centrumx && claude");
  // The cause the peer report spent two failed launches discovering: a trusted
  // parent says nothing about the child, so the message has to say so.
  expect(msg).toMatch(/not inherited/i);
});

test("a trusted directory points at the terminal without naming a screen nobody has demonstrated", () => {
  const msg = claudeRegistryDiagnostic(true, "/Source/arm", "/cfg");
  // It must NOT accuse trust, which is the failure mode this change exists to
  // remove: a message naming the wrong one of several consent screens costs
  // exactly as much time as the vague one did.
  expect(msg).not.toMatch(/workspace trust has not been accepted/);
  expect(msg).toMatch(/login/i);
  // And it must not name bypass-permissions first use either. That was a
  // plausible guess nobody has demonstrated: four local profiles carry
  // one-time acknowledgement keys (`hasSeenAutoModeEntryWarning` and friends)
  // and not one carries a bypass equivalent. Sending a reader after a screen
  // that may not exist is the same cost as the vague message, paid twice.
  expect(msg).not.toMatch(/bypass/i);
});
