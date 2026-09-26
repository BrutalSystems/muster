import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { expect, test } from "vitest";
import {
  IDENTITY_FILES,
  copyIdentity,
  identityEnv,
  identityLiveDir,
  setCodexWorkspaceTrust,
  setWorkspaceTrust,
} from "../src/identity-copy.js";
import { identityPath, writeIdentity } from "../src/identity-store.js";

const created = "2026-09-23T10:00:00.000Z";
async function template(agent: "claude" | "codex" | "opencode") {
  const home = await mkdtemp(join(tmpdir(), "mu-icopy-"));
  const meta = { agent, created } as const;
  await writeIdentity(home, "id1", meta);
  const dir = identityPath(home, "id1");
  for (const f of IDENTITY_FILES[agent]) {
    // Some agents (opencode) declare a nested path, e.g. data/opencode/auth.json.
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), f.endsWith(".json") ? "{}" : "# toml\n");
  }
  await writeFile(join(dir, "should-not-be-copied.bin"), "x".repeat(1024));
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(join(dir, "cache", "big"), "y".repeat(1024));
  return { home, meta, dir };
}

test("only the declared subset is copied, never the bulk", async () => {
  const { home, meta } = await template("claude");
  const copy = await copyIdentity(home, "id1", meta, "launch-1");
  expect(copy).toBe(identityLiveDir(home, "launch-1"));
  for (const f of IDENTITY_FILES.claude)
    expect((await stat(join(copy, f))).isFile()).toBe(true);
  await expect(stat(join(copy, "should-not-be-copied.bin"))).rejects.toThrow();
  await expect(stat(join(copy, "cache"))).rejects.toThrow();
  await expect(stat(join(copy, "identity.json"))).rejects.toThrow();
});

test("the copy is 0700 because it may hold a credential", async () => {
  const { home, meta } = await template("codex");
  const copy = await copyIdentity(home, "id1", meta, "launch-2");
  expect((await stat(copy)).mode & 0o777).toBe(0o700);
});

test("a real copy failure is not swallowed like a missing file", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-icopy-"));
  const meta = { agent: "codex" as const, created };
  await writeIdentity(home, "id1", meta);
  const dir = identityPath(home, "id1");
  // auth.json is a directory, not a file: copyFile against it fails with
  // EISDIR, not ENOENT — a real failure that must surface, not be tolerated.
  await mkdir(join(dir, "auth.json"), { recursive: true });
  await expect(
    copyIdentity(home, "id1", meta, "launch-eisdir"),
  ).rejects.toThrow();
});

test("a missing declared file is tolerated, not fatal", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-icopy-"));
  const meta = { agent: "codex" as const, created };
  await writeIdentity(home, "bare", meta);
  const copy = await copyIdentity(home, "bare", meta, "launch-3");
  expect((await stat(copy)).isDirectory()).toBe(true);
});

test("each agent gets its own config variable pointed at the copy", () => {
  expect(identityEnv({ agent: "claude", created }, "/copy", {})).toMatchObject({
    CLAUDE_CONFIG_DIR: "/copy",
  });
  expect(identityEnv({ agent: "codex", created }, "/copy", {})).toMatchObject({
    CODEX_HOME: "/copy",
  });
  expect(
    identityEnv({ agent: "opencode", created }, "/copy", {}),
  ).toMatchObject({ OPENCODE_CONFIG_DIR: "/copy" });
});

test("a resolved credential becomes CLAUDE_CODE_OAUTH_TOKEN", () => {
  const meta = { agent: "claude" as const, created, token_env: "TOK" };
  expect(identityEnv(meta, "/copy", {}, "sk-x")).toMatchObject({
    CLAUDE_CODE_OAUTH_TOKEN: "sk-x",
  });
  // ANTHROPIC_API_KEY would move the account onto API billing.
  expect(Object.keys(identityEnv(meta, "/copy", {}, "sk-x"))).not.toContain(
    "ANTHROPIC_API_KEY",
  );
});

test("identityEnv uses the resolved credential, not the environment", async () => {
  const meta = { agent: "claude" as const, created, token_env: "TOKV" };
  // The resolved value wins: run.ts has already decided which route applies.
  expect(
    identityEnv(meta, "/copy", { TOKV: "sk-env" }, "sk-resolved"),
  ).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-resolved" });
});

test("identityEnv omits the token variable when there is no credential", async () => {
  const meta = { agent: "claude" as const, created };
  expect(Object.keys(identityEnv(meta, "/copy", {}, undefined))).toEqual([
    "CLAUDE_CONFIG_DIR",
  ]);
});

test("trust is set for exactly the launch directory, preserving other entries", async () => {
  const { home, meta } = await template("claude");
  const copy = await copyIdentity(home, "id1", meta, "launch-4");
  await writeFile(
    join(copy, ".claude.json"),
    JSON.stringify({ projects: { "/other": { keep: true } }, top: 1 }),
  );
  await setWorkspaceTrust(copy, "/work/dir");
  const d = JSON.parse(await readFile(join(copy, ".claude.json"), "utf8"));
  expect(d.projects["/work/dir"].hasTrustDialogAccepted).toBe(true);
  expect(d.projects["/other"].keep).toBe(true);
  expect(d.top).toBe(1);
});

test("trust can be set on a copy with no .claude.json yet", async () => {
  const home = await mkdtemp(join(tmpdir(), "mu-icopy-"));
  const meta = { agent: "claude" as const, created };
  await writeIdentity(home, "bare", meta);
  const copy = await copyIdentity(home, "bare", meta, "launch-5");
  await setWorkspaceTrust(copy, "/work/dir");
  const d = JSON.parse(await readFile(join(copy, ".claude.json"), "utf8"));
  expect(d.projects["/work/dir"].hasTrustDialogAccepted).toBe(true);
});

// --- Step 6: OpenCode's declared subset, settled against the real runtime ---
//
// Investigation (see task-4-report.md for the full evidence trail): the
// installed opencode 1.18.32 binary resolves its DATA root as always
// `XDG_DATA_HOME/opencode` (the "opencode" suffix is hardcoded and cannot be
// overridden independently — there is no OPENCODE_DATA_DIR), and its auth
// file as `<data>/auth.json`. Its CONFIG root is `OPENCODE_CONFIG_DIR ??
// XDG_CONFIG_HOME/opencode`, used as-is with no suffix. The real config file
// present on this machine at ~/.config/opencode is `opencode.jsonc`, not
// `opencode.json` or `config.json`. This confirms candidate (1) from the
// brief: point OPENCODE_CONFIG_DIR at the copy directly, and XDG_DATA_HOME at
// a data/ subdirectory of the copy whose "opencode/auth.json" is where the
// binary itself will look.
test("opencode gets OPENCODE_CONFIG_DIR and XDG_DATA_HOME pointed at the copy", () => {
  expect(
    identityEnv({ agent: "opencode", created }, "/copy", {}),
  ).toMatchObject({
    OPENCODE_CONFIG_DIR: "/copy",
    XDG_DATA_HOME: join("/copy", "data"),
  });
});

test("the opencode auth file lands beneath data/opencode, where XDG_DATA_HOME resolves it", async () => {
  const { home, meta } = await template("opencode");
  const copy = await copyIdentity(home, "id1", meta, "launch-6");
  expect(
    (await stat(join(copy, "data", "opencode", "auth.json"))).isFile(),
  ).toBe(true);
  expect((await stat(join(copy, "opencode.jsonc"))).isFile()).toBe(true);
});

test("setWorkspaceTrust keeps a copied .claude.json's other keys", async () => {
  // The template's own login writes onboarding flags into .claude.json, and a
  // blanket catch that treated any failure as "no file yet" wrote a file holding
  // only `projects` — dropping every one of them.
  const dir = await mkdtemp(join(tmpdir(), "mu-trust-"));
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      userID: "u1",
      projects: { "/other": { hasTrustDialogAccepted: true } },
    }),
  );
  await setWorkspaceTrust(dir, "/work/thing");
  const data = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
  expect(data.hasCompletedOnboarding).toBe(true);
  expect(data.userID).toBe("u1");
  expect(data.projects["/other"].hasTrustDialogAccepted).toBe(true);
  expect(data.projects["/work/thing"].hasTrustDialogAccepted).toBe(true);
});

test("setWorkspaceTrust tolerates no file but rejects one it cannot read or parse", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "mu-trust-"));
  await setWorkspaceTrust(fresh, "/work/thing");
  expect(
    JSON.parse(await readFile(join(fresh, ".claude.json"), "utf8")).projects[
      "/work/thing"
    ].hasTrustDialogAccepted,
  ).toBe(true);
  const broken = await mkdtemp(join(tmpdir(), "mu-trust-"));
  await writeFile(join(broken, ".claude.json"), "{not json");
  await expect(setWorkspaceTrust(broken, "/work/thing")).rejects.toThrow(
    /not valid JSON/,
  );
  // A directory where the file should be: EISDIR, not ENOENT, and not silence.
  const isdir = await mkdtemp(join(tmpdir(), "mu-trust-"));
  await mkdir(join(isdir, ".claude.json"));
  await expect(setWorkspaceTrust(isdir, "/work/thing")).rejects.toThrow();
});

test("setCodexWorkspaceTrust trusts the launch directory in a fresh copy", async () => {
  // The bug this exists for: a fresh copy has no `projects` table, so Codex
  // stopped on "Do you trust the contents of this directory?" before opening a
  // thread — no thread-writer lock, nothing to discover, and the launch died at
  // its deadline with `no descendant runtime identity found`.
  const fresh = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  await setCodexWorkspaceTrust(fresh, "/work/thing");
  const data = TOML.parse(await readFile(join(fresh, "config.toml"), "utf8"));
  expect((data.projects as any)["/work/thing"].trust_level).toBe("trusted");
});

test("setCodexWorkspaceTrust keeps the template's other settings and projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  await writeFile(
    join(dir, "config.toml"),
    'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n',
  );
  await setCodexWorkspaceTrust(dir, "/work/thing");
  const data: any = TOML.parse(
    await readFile(join(dir, "config.toml"), "utf8"),
  );
  expect(data.model).toBe("gpt-5");
  expect(data.projects["/other"].trust_level).toBe("trusted");
  expect(data.projects["/work/thing"].trust_level).toBe("trusted");
});

test("setCodexWorkspaceTrust corrects a distrusting entry rather than duplicating it", async () => {
  // Appending a second [projects."<dir>"] table would be a TOML error, and Codex
  // refuses the whole file — trading a trust prompt for a config it cannot read.
  const dir = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  await writeFile(
    join(dir, "config.toml"),
    '[projects."/work/thing"]\ntrust_level = "untrusted"\n',
  );
  await setCodexWorkspaceTrust(dir, "/work/thing");
  const raw = await readFile(join(dir, "config.toml"), "utf8");
  expect(raw.match(/trust_level/g)).toHaveLength(1);
  const data: any = TOML.parse(raw);
  expect(data.projects["/work/thing"].trust_level).toBe("trusted");
});

test("setCodexWorkspaceTrust leaves an already-trusted file untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  const original =
    '# keep me\n[projects."/work/thing"]\ntrust_level = "trusted"\n';
  await writeFile(join(dir, "config.toml"), original);
  await setCodexWorkspaceTrust(dir, "/work/thing");
  // Byte-for-byte: no write at all, so the template's comments survive in the
  // common case where its own login already trusted the directory.
  expect(await readFile(join(dir, "config.toml"), "utf8")).toBe(original);
});

test("setCodexWorkspaceTrust rejects a config.toml it cannot read or parse", async () => {
  const broken = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  await writeFile(join(broken, "config.toml"), "not = = toml");
  await expect(setCodexWorkspaceTrust(broken, "/work/thing")).rejects.toThrow(
    /not valid TOML/,
  );
  // A directory where the file should be: EISDIR, not ENOENT, and not silence.
  const isdir = await mkdtemp(join(tmpdir(), "mu-ctrust-"));
  await mkdir(join(isdir, "config.toml"));
  await expect(setCodexWorkspaceTrust(isdir, "/work/thing")).rejects.toThrow();
});
