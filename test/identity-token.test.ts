import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  readStoredToken,
  removeStoredToken,
  tokenPath,
  writeStoredToken,
} from "../src/identity-token.js";
import { IdentityError } from "../src/identity-store.js";

async function home() {
  return await mkdtemp(join(tmpdir(), "mu-tok-"));
}

test("a token round-trips and is written 0600", async () => {
  const h = await home();
  await writeStoredToken(h, "id1", "sk-ant-oat01-abc");
  expect(await readStoredToken(h, "id1")).toBe("sk-ant-oat01-abc");
  // 0600 asserted, not assumed: this file is a year-long credential.
  expect((await stat(tokenPath(h, "id1"))).mode & 0o777).toBe(0o600);
});

test("an absent token reads as undefined, not an error", async () => {
  const h = await home();
  expect(await readStoredToken(h, "id1")).toBeUndefined();
});

test("a trailing newline is not part of the token", async () => {
  const h = await home();
  await mkdir(join(h, "identities", "id1"), { recursive: true });
  await writeFile(tokenPath(h, "id1"), "sk-ant-oat01-abc\n");
  expect(await readStoredToken(h, "id1")).toBe("sk-ant-oat01-abc");
});

test("an empty token file is an error, not an absent credential", async () => {
  // Empty is a BROKEN state, not a missing one. Reporting it as absent would
  // send the operator to `setup-identity` when the real problem is a truncated
  // write they need to know about.
  const h = await home();
  await mkdir(join(h, "identities", "id1"), { recursive: true });
  await writeFile(tokenPath(h, "id1"), "   \n");
  await expect(readStoredToken(h, "id1")).rejects.toThrow(IdentityError);
});

test("a read failure that is not ENOENT surfaces", async () => {
  const h = await home();
  await mkdir(tokenPath(h, "id1"), { recursive: true }); // EISDIR, not ENOENT
  await expect(readStoredToken(h, "id1")).rejects.toThrow(IdentityError);
});

test("writing refuses an empty token", async () => {
  const h = await home();
  await expect(writeStoredToken(h, "id1", "  ")).rejects.toThrow(IdentityError);
});

test("writing leaves no temporary file behind", async () => {
  const h = await home();
  await writeStoredToken(h, "id1", "sk-ant-oat01-abc");
  const { readdir } = await import("node:fs/promises");
  const items = await readdir(join(h, "identities", "id1"));
  expect(items).toEqual(["token"]);
});

test("remove reports whether there was anything to remove", async () => {
  const h = await home();
  expect(await removeStoredToken(h, "id1")).toBe(false);
  await writeStoredToken(h, "id1", "sk-ant-oat01-abc");
  expect(await removeStoredToken(h, "id1")).toBe(true);
  expect(await readStoredToken(h, "id1")).toBeUndefined();
});

test("a write failure wraps as IdentityError", async () => {
  const h = await home();
  const dir = join(h, "identities", "id1");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Make directory read-only to trigger EACCES on subsequent writes
  await chmod(dir, 0o500);
  try {
    await expect(
      writeStoredToken(h, "id1", "sk-ant-oat01-abc"),
    ).rejects.toThrow(IdentityError);
  } finally {
    // Restore permissions for cleanup
    await chmod(dir, 0o700);
  }
});

test("a remove failure wraps as IdentityError", async () => {
  const h = await home();
  const tokenDir = tokenPath(h, "id1");
  // Create a directory at the token path to trigger EISDIR/ENOTEMPTY on rm
  await mkdir(tokenDir, { recursive: true });
  await expect(removeStoredToken(h, "id1")).rejects.toThrow(IdentityError);
});

import { resolveCredential } from "../src/identity-token.js";

const claude = (token_env?: string) => ({
  agent: "claude" as const,
  created: "2026-09-23T10:00:00.000Z",
  ...(token_env ? { token_env } : {}),
});

test("a declared token_env is the env route, and reads that variable", async () => {
  const h = await home();
  expect(
    await resolveCredential(h, "id1", claude("TOKV"), { TOKV: "sk-x" }),
  ).toEqual({
    route: "env",
    variable: "TOKV",
    token: "sk-x",
  });
});

test("the env route reports an unset variable as no token", async () => {
  const h = await home();
  expect(await resolveCredential(h, "id1", claude("TOKV"), {})).toEqual({
    route: "env",
    variable: "TOKV",
    token: undefined,
  });
});

test("no token_env is the file route", async () => {
  const h = await home();
  await writeStoredToken(h, "id1", "sk-stored");
  expect(await resolveCredential(h, "id1", claude(), {})).toEqual({
    route: "file",
    token: "sk-stored",
  });
});

test("the file route ignores the environment entirely", async () => {
  // The whole point of the design: the same identity answers the same way in
  // every shell. A variable that happens to be set must not change the answer.
  const h = await home();
  await writeStoredToken(h, "id1", "sk-stored");
  const noisy = { TOKV: "sk-ambient", CLAUDE_CODE_OAUTH_TOKEN: "sk-ambient" };
  expect(await resolveCredential(h, "id1", claude(), noisy)).toEqual({
    route: "file",
    token: "sk-stored",
  });
});

test("the file route with nothing stored has no token", async () => {
  const h = await home();
  expect(await resolveCredential(h, "id1", claude(), {})).toEqual({
    route: "file",
    token: undefined,
  });
});
