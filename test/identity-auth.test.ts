import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  claudeKeychainService,
  identityAuthState,
} from "../src/identity-auth.js";
import { identityPath, writeIdentity } from "../src/identity-store.js";

const home = () => mkdtemp(join(tmpdir(), "mu-iauth-"));
const created = "2026-09-23T10:00:00.000Z";

test("the keychain service name is derived from the config dir path", () => {
  const p = "/Users/someone/.muster/identities/claude-work";
  const expected =
    "Claude Code-credentials-" +
    createHash("sha256").update(p).digest("hex").slice(0, 8);
  expect(claudeKeychainService(p)).toBe(expected);
  expect(claudeKeychainService(p)).not.toBe(claudeKeychainService(p + "x"));
});

test("codex is configured when its template holds an auth file", async () => {
  const h = await home();
  await writeIdentity(h, "cx", { agent: "codex", created });
  expect(
    (await identityAuthState(h, "cx", { agent: "codex", created }, {})).state,
  ).toBe("not-configured");
  await writeFile(join(identityPath(h, "cx"), "auth.json"), '{"ok":true}');
  const s = await identityAuthState(h, "cx", { agent: "codex", created }, {});
  expect(s.state).toBe("configured");
  expect(s.detail).toMatch(/auth\.json/);
});

test("an unparseable codex auth file is not configured", async () => {
  const h = await home();
  await writeIdentity(h, "cx", { agent: "codex", created });
  await writeFile(join(identityPath(h, "cx"), "auth.json"), "{not json");
  expect(
    (await identityAuthState(h, "cx", { agent: "codex", created }, {})).state,
  ).toBe("not-configured");
});

test("claude is configured by a set token variable", async () => {
  const h = await home();
  const meta = { agent: "claude" as const, created, token_env: "TOK" };
  await writeIdentity(h, "cl", meta);
  expect((await identityAuthState(h, "cl", meta, {})).state).toBe(
    "not-configured",
  );
  const s = await identityAuthState(h, "cl", meta, { TOK: "sk-whatever" });
  expect(s.state).toBe("configured");
  expect(s.detail).toMatch(/TOK/);
  expect(s.detail).not.toMatch(/sk-whatever/);
});

test("a claude identity with no token variable is NOT configured, keychain or not", async () => {
  // The keychain item is keyed to the TEMPLATE's path, and a launch runs from a
  // copy whose path hashes to a different service name with no fallback. So a
  // present item proves the template is usable in place, not that a launch can
  // use it — and reporting "configured" promised a launch that dies at its
  // deadline with "no Claude session registry found".
  const h = await home();
  const meta = { agent: "claude" as const, created };
  await writeIdentity(h, "cl", meta);
  const present = async () => true;
  const absent = async () => false;
  const withItem = await identityAuthState(h, "cl", meta, {}, present);
  expect(withItem.state).toBe("not-configured");
  expect(withItem.detail).toMatch(/copy/);
  expect(withItem.detail).toMatch(/setup-identity --interactive/);
  const without = await identityAuthState(h, "cl", meta, {}, absent);
  expect(without.state).toBe("not-configured");
  expect(without.detail).toMatch(/setup-identity --interactive/);
});

test("no state is ever reported as valid", async () => {
  const h = await home();
  await writeIdentity(h, "cx", { agent: "codex", created });
  await writeFile(join(identityPath(h, "cx"), "auth.json"), "{}");
  const s = await identityAuthState(h, "cx", { agent: "codex", created }, {});
  expect(s.state).toBe("configured");
  expect(JSON.stringify(s)).not.toMatch(/valid/i);
});

test("a stored token reports configured regardless of the environment", async () => {
  // The regression test for the defect this whole change exists to fix: the
  // same identity used to read as configured in the shell that exported a
  // variable and not-configured everywhere else.
  const h = await mkdtemp(join(tmpdir(), "mu-auth-"));
  const meta = { agent: "claude" as const, created };
  const { writeStoredToken } = await import("../src/identity-token.js");
  await writeStoredToken(h, "id1", "sk-stored");
  for (const env of [
    {},
    { TOKV: "sk-x" },
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-y" },
  ]) {
    const state = await identityAuthState(h, "id1", meta, env);
    expect(state.state).toBe("configured");
    expect(state.detail).toMatch(/stored/i);
  }
});

test("no stored token and no token_env reports not-configured with the remedy", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-auth-"));
  const meta = { agent: "claude" as const, created };
  const state = await identityAuthState(h, "id1", meta, {}, async () => false);
  expect(state.state).toBe("not-configured");
  expect(state.detail).toMatch(/setup-identity --interactive/);
});

test("the keychain hint still explains an identity with a template keychain item", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-auth-"));
  const meta = { agent: "claude" as const, created };
  const state = await identityAuthState(h, "id1", meta, {}, async () => true);
  expect(state.state).toBe("not-configured");
  expect(state.detail).toMatch(/hashes to a different service name/);
});

test("a broken token file is reported, not thrown, so the listing survives", async () => {
  // describeIdentities has no error handling around identityAuthState, so a
  // throw here makes `muster identities` report nothing at all — including
  // about the identities that are perfectly fine.
  const h = await mkdtemp(join(tmpdir(), "mu-auth-"));
  const meta = { agent: "claude" as const, created };
  await mkdir(join(h, "identities", "id1"), { recursive: true });
  await writeFile(join(h, "identities", "id1", "token"), "\n");
  const state = await identityAuthState(h, "id1", meta, {}, async () => false);
  expect(state.state).toBe("not-configured");
  expect(state.detail).toMatch(/empty/i);
});

test("a declared token_env still reports from the environment", async () => {
  const h = await mkdtemp(join(tmpdir(), "mu-auth-"));
  const meta = {
    agent: "claude" as const,
    created,
    token_env: "TOKV",
  };
  expect((await identityAuthState(h, "id1", meta, { TOKV: "x" })).state).toBe(
    "configured",
  );
  expect((await identityAuthState(h, "id1", meta, {})).state).toBe(
    "not-configured",
  );
});
