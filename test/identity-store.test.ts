import { mkdtemp, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  IdentityError,
  identitiesDir,
  identityDirExists,
  identityMetaSchema,
  identityNameSchema,
  identityPath,
  listIdentities,
  readIdentity,
  writeIdentity,
} from "../src/identity-store.js";

const home = () => mkdtemp(join(tmpdir(), "mu-ident-"));

test("a name must be a safe single segment", () => {
  for (const ok of ["claude-work", "codex_personal", "a1"])
    expect(identityNameSchema.parse(ok)).toBe(ok);
  for (const bad of ["", "../escape", "has space", "has/slash", "a".repeat(65)])
    expect(() => identityNameSchema.parse(bad)).toThrow();
});

test("a malformed name reaches callers as an IdentityError, not a schema error", () => {
  // The error model promises every identity problem is an IdentityError.
  expect(() => identityPath("/home", "../escape")).toThrow(IdentityError);
});

test("metadata is strict and records the agent", () => {
  const meta = { agent: "claude", created: "2026-09-23T10:00:00.000Z" };
  expect(identityMetaSchema.parse(meta)).toEqual(meta);
  expect(
    identityMetaSchema.parse({ ...meta, token_env: "CLAUDE_TOKEN_ARM" })
      .token_env,
  ).toBe("CLAUDE_TOKEN_ARM");
  expect(() => identityMetaSchema.parse({ ...meta, extra: 1 })).toThrow();
  expect(() => identityMetaSchema.parse({ agent: "elsewhere" })).toThrow();
});

test("paths are derived from the muster home", async () => {
  const h = await home();
  expect(identitiesDir(h)).toBe(join(h, "identities"));
  expect(identityPath(h, "claude-work")).toBe(
    join(h, "identities", "claude-work"),
  );
});

test("writing creates the directory at 0700, because it may hold a credential", async () => {
  const h = await home();
  await writeIdentity(h, "codex-personal", {
    agent: "codex",
    created: "2026-09-23T10:00:00.000Z",
  });
  expect((await stat(identityPath(h, "codex-personal"))).mode & 0o777).toBe(
    0o700,
  );
  expect((await readIdentity(h, "codex-personal")).agent).toBe("codex");
});

test("an unknown identity is an IdentityError naming it", async () => {
  const h = await home();
  await expect(readIdentity(h, "missing")).rejects.toThrow(IdentityError);
  await expect(readIdentity(h, "missing")).rejects.toThrow(/missing/);
});

test("unparseable metadata is an IdentityError, not a raw JSON error", async () => {
  const h = await home();
  await mkdir(identityPath(h, "broken"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(identityPath(h, "broken"), "identity.json"),
    "{not json",
  );
  await expect(readIdentity(h, "broken")).rejects.toThrow(IdentityError);
});

test("listing returns every identity and is empty before any exist", async () => {
  const h = await home();
  expect(await listIdentities(h)).toEqual([]);
  await writeIdentity(h, "b", {
    agent: "codex",
    created: "2026-09-23T00:00:00.000Z",
  });
  await writeIdentity(h, "a", {
    agent: "claude",
    created: "2026-09-23T00:00:00.000Z",
  });
  expect((await listIdentities(h)).map((i) => i.name)).toEqual(["a", "b"]);
});

test("identityDirExists throws IdentityError for malformed names", async () => {
  const h = await home();
  await expect(identityDirExists(h, "../escape")).rejects.toThrow(
    IdentityError,
  );
});

test("readIdentity distinguishes not-found from read errors", async () => {
  const h = await home();
  await mkdir(identityPath(h, "permerr"), { recursive: true, mode: 0o700 });
  // Make identity.json a directory to trigger EISDIR instead of ENOENT
  await mkdir(join(identityPath(h, "permerr"), "identity.json"), {
    mode: 0o700,
  });
  try {
    await readIdentity(h, "permerr");
    throw new Error("should have thrown IdentityError");
  } catch (e) {
    expect(e).toBeInstanceOf(IdentityError);
    expect(String(e)).not.toMatch(/not found/);
  }
});

test("listIdentities returns empty for non-existent store", async () => {
  const h = await home();
  // identities directory never created
  expect(await listIdentities(h)).toEqual([]);
});
