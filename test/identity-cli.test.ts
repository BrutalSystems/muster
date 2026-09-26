import { chmod, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  describeIdentities,
  interactiveSetup,
  setupIdentity,
} from "../src/identity-cli.js";
import { identityPath, readIdentity } from "../src/identity-store.js";
import { redactToken } from "../src/identity-login.js";

const home = () => mkdtemp(join(tmpdir(), "mu-icli-"));
test("it creates the identity and prints that agent's login", async () => {
  const h = await home();
  const r = await setupIdentity({
    home: h,
    name: "claude-work",
    agent: "claude",
  });
  expect(r.created).toBe(true);
  expect(r.path).toBe(identityPath(h, "claude-work"));
  expect(r.login).toContain("CLAUDE_CONFIG_DIR=" + r.path);
  expect(r.login).toContain("claude");
  expect((await readIdentity(h, "claude-work")).agent).toBe("claude");
});

test("each agent gets its own login command", async () => {
  const h = await home();
  expect(
    (await setupIdentity({ home: h, name: "cx", agent: "codex" })).login,
  ).toContain("CODEX_HOME=");
  expect(
    (await setupIdentity({ home: h, name: "oc", agent: "opencode" })).login,
  ).toContain("OPENCODE_CONFIG_DIR=");
});

test("re-running for the same agent is idempotent", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  const again = await setupIdentity({ home: h, name: "cx", agent: "codex" });
  expect(again.created).toBe(false);
});

test("re-running with no --token-env leaves a recorded one untouched", async () => {
  const h = await home();
  await setupIdentity({
    home: h,
    name: "cl",
    agent: "claude",
    tokenEnv: "TOK",
  });
  const again = await setupIdentity({ home: h, name: "cl", agent: "claude" });
  expect(again.created).toBe(false);
  expect((await readIdentity(h, "cl")).token_env).toBe("TOK");
});

test("--token-env on an existing identity records it, even when one was already set", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cl", agent: "claude" });
  expect((await readIdentity(h, "cl")).token_env).toBeUndefined();
  // First time: no token recorded yet -> gets set.
  const first = await setupIdentity({
    home: h,
    name: "cl",
    agent: "claude",
    tokenEnv: "TOK",
  });
  expect(first.created).toBe(false); // the directory already existed
  expect((await readIdentity(h, "cl")).token_env).toBe("TOK");
  // A different value is accepted and replaces it, honestly reporting
  // created: false since only the metadata changed.
  const second = await setupIdentity({
    home: h,
    name: "cl",
    agent: "claude",
    tokenEnv: "OTHER_TOK",
  });
  expect(second.created).toBe(false);
  expect((await readIdentity(h, "cl")).token_env).toBe("OTHER_TOK");
});

test("a present but unusable identity is refused, never silently repurposed", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  // Its credential is still there; overwriting the metadata would hand a Claude
  // identity a Codex account's auth file.
  await writeFile(join(identityPath(h, "cx"), "auth.json"), "{}");
  await writeFile(join(identityPath(h, "cx"), "identity.json"), "{not json");
  await expect(
    setupIdentity({ home: h, name: "cx", agent: "claude" }),
  ).rejects.toThrow(/unusable|identity cx/);
});

test("re-running with a different agent is refused", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  await expect(
    setupIdentity({ home: h, name: "cx", agent: "claude" }),
  ).rejects.toThrow(/codex/);
});

test("it reports authentication state rather than assuming it", async () => {
  const h = await home();
  const before = await setupIdentity({ home: h, name: "cx", agent: "codex" });
  expect(before.auth.state).toBe("not-configured");
  await writeFile(join(identityPath(h, "cx"), "auth.json"), "{}");
  const after = await setupIdentity({ home: h, name: "cx", agent: "codex" });
  expect(after.auth.state).toBe("configured");
});

test("the listing reports every identity with its agent and state", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  await setupIdentity({
    home: h,
    name: "cl",
    agent: "claude",
    tokenEnv: "TOK",
  });
  const { identities } = await describeIdentities(h, { TOK: "x" });
  expect(identities.map((r) => r.name)).toEqual(["cl", "cx"]);
  expect(identities.find((r) => r.name === "cl")!.auth.state).toBe(
    "configured",
  );
  expect(identities.find((r) => r.name === "cx")!.auth.state).toBe(
    "not-configured",
  );
});

test("a profile granting an identity that does not exist is reported as stale", async () => {
  const h = await home();
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  const { staleGrants } = await describeIdentities(
    h,
    {},
    { research: ["cx", "deleted-one"] },
  );
  expect(staleGrants).toEqual([
    { profile: "research", identity: "deleted-one" },
  ]);
});

test("--token-env is refused for a non-claude identity", async () => {
  // Its only consumer is identityEnv's Claude branch, and identityAuthState
  // ignores it for the others — but the launch path refuses when the named
  // variable is unset. On codex or opencode it is a new way to fail and nothing
  // else, so it is refused where the operator types it.
  const h = await home();
  for (const agent of ["codex", "opencode"] as const)
    await expect(
      setupIdentity({ home: h, name: "x" + agent, agent, tokenEnv: "TOK" }),
    ).rejects.toThrow(/--token-env applies only to a claude identity/);
  // Nothing was created by the refusal.
  expect((await describeIdentities(h, {})).identities).toHaveLength(0);
  // And it is still accepted for claude.
  const ok = await setupIdentity({
    home: h,
    name: "cl",
    agent: "claude",
    tokenEnv: "TOK",
  });
  expect(ok.created).toBe(true);
});

import { readStoredToken } from "../src/identity-token.js";
import { storeIdentityToken } from "../src/identity-cli.js";

test("storing a token clears a declared token_env", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({
    home: h,
    name: "id1",
    agent: "claude",
    tokenEnv: "TOKV",
  });
  const result = await storeIdentityToken({
    home: h,
    name: "id1",
    token: "sk-new",
  });
  expect(await readStoredToken(h, "id1")).toBe("sk-new");
  expect((await readIdentity(h, "id1")).token_env).toBeUndefined();
  // Reported, not silent: the operator must know the variable stopped mattering.
  expect(result.clearedRoute).toMatch(/TOKV/);
});

test("passing --token-env deletes a stored token", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({ home: h, name: "id1", agent: "claude" });
  await storeIdentityToken({ home: h, name: "id1", token: "sk-new" });
  const result = await setupIdentity({
    home: h,
    name: "id1",
    agent: "claude",
    tokenEnv: "TOKV",
  });
  // Leaving it would be a secret at rest that nothing reads.
  expect(await readStoredToken(h, "id1")).toBeUndefined();
  expect(result.clearedRoute).toMatch(/stored token/i);
});

test("an identity never ends with both routes", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({
    home: h,
    name: "id1",
    agent: "claude",
    tokenEnv: "TOKV",
  });
  await storeIdentityToken({ home: h, name: "id1", token: "sk-new" });
  await setupIdentity({
    home: h,
    name: "id1",
    agent: "claude",
    tokenEnv: "OTHER",
  });
  const meta = await readIdentity(h, "id1");
  const stored = await readStoredToken(h, "id1");
  expect(Boolean(meta.token_env) && Boolean(stored)).toBe(false);
});

test("if token removal fails, setup-identity aborts before recording token_env", async () => {
  // Verify the ordering: remove BEFORE write. If removal fails, neither route
  // is recorded and the identity reports not-configured (operator re-runs and
  // succeeds). Writing first would leave both routes on the failure path.
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({ home: h, name: "id1", agent: "claude" });
  await storeIdentityToken({ home: h, name: "id1", token: "sk-new" });
  // Make the token path a directory so rm will fail with EISDIR.
  const { rm, mkdir } = await import("node:fs/promises");
  const tokenPath = join(h, "identities", "id1", "token");
  await rm(tokenPath);
  await mkdir(tokenPath, { mode: 0o700 });
  // Try to set token_env; it should fail and abort without recording the route.
  await expect(
    setupIdentity({ home: h, name: "id1", agent: "claude", tokenEnv: "TOKV" }),
  ).rejects.toThrow(/could not be removed/);
  // The identity must NOT have recorded token_env, proving the write happened
  // after the removal and thus the command aborted.
  expect((await readIdentity(h, "id1")).token_env).toBeUndefined();
});

test("re-running setup-identity without --token-env disturbs neither route", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({ home: h, name: "id1", agent: "claude" });
  await storeIdentityToken({ home: h, name: "id1", token: "sk-new" });
  const result = await setupIdentity({ home: h, name: "id1", agent: "claude" });
  expect(await readStoredToken(h, "id1")).toBe("sk-new");
  expect(result.clearedRoute).toBeUndefined();
});

test("storing a token is refused for a non-claude identity", async () => {
  // Codex and OpenCode keep their credential in an auth file their own login
  // writes. A token here would be a file nothing ever reads.
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({ home: h, name: "cx", agent: "codex" });
  await expect(
    storeIdentityToken({ home: h, name: "cx", token: "sk-new" }),
  ).rejects.toThrow(/claude/);
});

test("interactive setup refuses when stdin is not a TTY", async () => {
  // It must be unreachable from a script or an MCP call: a half-run interactive
  // flow would block forever holding a credential prompt nobody can see.
  const h = await mkdtemp(join(tmpdir(), "mu-cli-"));
  await setupIdentity({ home: h, name: "id1", agent: "claude" });
  await expect(
    interactiveSetup({
      home: h,
      name: "id1",
      agent: "claude",
      isTTY: false,
      stdin: noKeyboard,
    }),
  ).rejects.toThrow(/interactive/i);
});

const TOKEN =
  "sk-ant-oat01-p41NahlJ8bCAJSEdzNOUhzVv24PC31Z-H-wdnlcsZQyWQ1XQvE-w28zZc6ao56HKjEep_dmNKjBHh";

/**
 * An environment whose PATH finds the fake `claude` instead of a real one, so
 * the shipped interactive path runs end to end — capture, storage, note — with
 * no network, no browser and no terminal.
 */
async function claudeOnPath(mode: string): Promise<NodeJS.ProcessEnv> {
  const bin = await mkdtemp(join(tmpdir(), "mu-icli-bin-"));
  const dest = join(bin, "claude");
  await copyFile(new URL("./fakes/claude-login.cjs", import.meta.url), dest);
  await chmod(dest, 0o755);
  return {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    MUSTER_FAKE_LOGIN: mode,
  };
}

/**
 * A stdin that is not a terminal. Passed explicitly so these tests never touch
 * the test runner's own stdin — putting THAT into raw mode is precisely the
 * damage the capture's restore exists to prevent.
 */
const noKeyboard = {
  isTTY: false,
  isRaw: false,
  setRawMode() {},
  on() {},
  off() {},
  resume() {},
  pause() {},
  isPaused: () => true,
};

test("interactive setup stores the captured token and reports it redacted", async () => {
  // The seam between the capture and the store, over the shipped path: the
  // token must reach disk, and must appear nowhere the operator can read it.
  const h = await home();
  let shown = "";
  const r = await interactiveSetup({
    home: h,
    name: "id1",
    agent: "claude",
    isTTY: true,
    write: (t) => (shown += t),
    env: await claudeOnPath("ok"),
    stdin: noKeyboard,
  });
  expect(r.stored).toBe(true);
  expect(await readStoredToken(h, "id1")).toBe(TOKEN);
  expect(r.note).toContain(redactToken(TOKEN));
  // The assertion that matters most: the confirmation is not the credential.
  expect(r.note).not.toContain(TOKEN);
  // Nor is the relayed scrollback — while the rest of the flow still shows.
  expect(shown).not.toContain(TOKEN);
  expect(shown).toContain("Opening browser");
});

test("interactive setup clears a declared token_env and says so", async () => {
  // One route per identity. Storing a token must retire the env route, and the
  // operator has to be told which of their two routes just went away.
  const h = await home();
  await setupIdentity({
    home: h,
    name: "id2",
    agent: "claude",
    tokenEnv: "CLAUDE_TOKEN",
  });
  const r = await interactiveSetup({
    home: h,
    name: "id2",
    agent: "claude",
    isTTY: true,
    write: () => {},
    env: await claudeOnPath("ok"),
    stdin: noKeyboard,
  });
  expect(r.stored).toBe(true);
  expect(r.note).toContain("cleared token_env CLAUDE_TOKEN");
  expect((await readIdentity(h, "id2")).token_env).toBeUndefined();
  expect(await readStoredToken(h, "id2")).toBe(TOKEN);
});

test("a non-claude identity gets its login instruction and no capture", async () => {
  // Codex and OpenCode log in with their own commands. Nothing may be spawned
  // for them here, which is what the empty relay proves.
  const h = await home();
  let shown = "";
  const r = await interactiveSetup({
    home: h,
    name: "cx",
    agent: "codex",
    isTTY: true,
    write: (t) => (shown += t),
    env: await claudeOnPath("ok"),
    stdin: noKeyboard,
  });
  expect(r.stored).toBe(false);
  expect(r.note).toContain("CODEX_HOME=" + r.path);
  expect(shown).toBe("");
  expect(await readStoredToken(h, "cx")).toBeUndefined();
});

test("a login that exits non-zero is an IdentityError, and stores nothing", async () => {
  // node-pty does not throw for a missing executable: it exits 1 having
  // emitted nothing. That case used to be reported as unparseable output, with
  // no identity name and no hint that nothing had run.
  const h = await home();
  await expect(
    interactiveSetup({
      home: h,
      name: "id3",
      agent: "claude",
      isTTY: true,
      write: () => {},
      env: await claudeOnPath("fail"),
      stdin: noKeyboard,
    }),
  ).rejects.toThrow(/identity id3: .*\(exit 3\)/);
  expect(await readStoredToken(h, "id3")).toBeUndefined();
});

test("a token printed by a login that then fails is not stored", async () => {
  // The spec's table: child exits non-zero -> no token written. A credential
  // from a run that did not finish is not a credential.
  const h = await home();
  await expect(
    interactiveSetup({
      home: h,
      name: "id4",
      agent: "claude",
      isTTY: true,
      write: () => {},
      env: await claudeOnPath("ok-fail"),
      stdin: noKeyboard,
    }),
  ).rejects.toThrow(/identity id4:/);
  expect(await readStoredToken(h, "id4")).toBeUndefined();
});

test("an unrecognised format points at --token-env, never at another --interactive", async () => {
  // Fails open, so the token is on screen in clear. Re-running --interactive
  // would mint a DIFFERENT token and could never store the one the operator is
  // looking at, so the note must not send them there.
  const h = await home();
  let shown = "";
  const r = await interactiveSetup({
    home: h,
    name: "id5",
    agent: "claude",
    isTTY: true,
    write: (t) => (shown += t),
    env: await claudeOnPath("changed"),
    stdin: noKeyboard,
  });
  expect(r.stored).toBe(false);
  expect(await readStoredToken(h, "id5")).toBeUndefined();
  expect(r.note).toContain("--token-env");
  expect(r.note).not.toContain("--interactive");
  expect(shown).toContain("OAT!p41NahlJ8bCAJSEdz");
});

/** #69. `--token-env ""` is falsy, so it slipped past every check that asked
 *  whether one was given and was then dropped rather than refused. */
test("an empty token variable name is refused, not ignored", async () => {
  const h = await home();
  await expect(
    setupIdentity({ home: h, name: "empty", agent: "claude", tokenEnv: "" }),
  ).rejects.toThrow(/name of an environment variable/i);
});

/**
 * #69. One message covered two different events. A login that ran and then
 * failed — or that the operator interrupted — was told to check that `claude`
 * is on PATH, which is a cause that had nothing to do with what happened.
 *
 * The two are distinguishable, but not by the exit code: node-pty does not
 * throw for a missing executable, it exits 1 having emitted nothing, which is
 * the same exit shape as a login that failed on its own. What separates them is
 * whether any output ever arrived.
 */
test("a login that ran and failed is not blamed on PATH", async () => {
  const h = await home();
  const thrown = await interactiveSetup({
    home: h,
    name: "ran",
    agent: "claude",
    isTTY: true,
    write: () => {},
    env: await claudeOnPath("fail"),
    stdin: noKeyboard,
  }).catch((e: Error) => e);
  expect((thrown as Error).message).toMatch(/exit 3/);
  expect((thrown as Error).message).not.toMatch(/PATH/);
});

test("a login that never started says so, and names PATH", async () => {
  const h = await home();
  // No fake and no real `claude` reachable: the genuine missing-executable
  // case, not a simulation of one.
  const empty = await mkdtemp(join(tmpdir(), "mu-nopath-"));
  const thrown = await interactiveSetup({
    home: h,
    name: "gone",
    agent: "claude",
    isTTY: true,
    write: () => {},
    env: { ...process.env, PATH: empty },
    stdin: noKeyboard,
  }).catch((e: Error) => e);
  expect((thrown as Error).message).toMatch(/PATH/);
  expect((thrown as Error).message).toMatch(/could not be started|never ran/i);
});
