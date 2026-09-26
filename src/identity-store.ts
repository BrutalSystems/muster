import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
/**
 * A named, pre-authenticated template configuration for one agent.
 *
 * The directory is 0700 because a Codex or OpenCode template contains that
 * account's own auth file — written there by that agent's login, not by Muster,
 * but on disk under `~/.muster` all the same. Deleting an identity deletes a
 * credential.
 */
export const identityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "must be letters, digits, dash or underscore");
export const identityMetaSchema = z
  .object({
    agent: z.enum(["codex", "claude", "opencode"]),
    created: z.string().min(1),
    /** Name of the variable holding this identity's token. Never the token. */
    token_env: z.string().min(1).optional(),
  })
  .strict();
export type IdentityMeta = z.infer<typeof identityMetaSchema>;
/** A local problem with an identity: unknown, malformed, or unusable. */
export class IdentityError extends Error {
  constructor(
    readonly identity: string,
    message: string,
  ) {
    super(`identity ${identity}: ${message}`);
    this.name = "IdentityError";
  }
}
export const identitiesDir = (home: string) => join(home, "identities");
export const identityPath = (home: string, name: string) => {
  // Wrapped so every identity problem is an IdentityError, as the error model
  // promises — a raw schema error here would escape that contract and reach a
  // caller as an unrecognisable shape.
  const parsed = identityNameSchema.safeParse(name);
  if (!parsed.success)
    throw new IdentityError(
      name,
      "name must be letters, digits, dash or underscore",
    );
  return join(identitiesDir(home), parsed.data);
};
/** Whether the directory exists, regardless of whether its metadata is usable. */
export async function identityDirExists(
  home: string,
  name: string,
): Promise<boolean> {
  const dir = identityPath(home, name); // throws IdentityError for a bad name
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
export async function writeIdentity(
  home: string,
  name: string,
  meta: IdentityMeta,
): Promise<void> {
  const dir = identityPath(home, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, "identity.json"),
    JSON.stringify(identityMetaSchema.parse(meta), null, 2) + "\n",
    { mode: 0o600 },
  );
}
export async function readIdentity(
  home: string,
  name: string,
): Promise<IdentityMeta> {
  const file = join(identityPath(home, name), "identity.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new IdentityError(
        name,
        "not found — create it with setup-identity",
      );
    throw new IdentityError(
      name,
      `metadata could not be read (${code ?? String(e)})`,
    );
  }
  try {
    return identityMetaSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new IdentityError(name, `metadata is unusable (${String(e)})`);
  }
}
export async function listIdentities(
  home: string,
): Promise<{ name: string; meta: IdentityMeta }[]> {
  let names: string[];
  try {
    names = (await readdir(identitiesDir(home), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: { name: string; meta: IdentityMeta }[] = [];
  for (const name of names)
    try {
      out.push({ name, meta: await readIdentity(home, name) });
    } catch {
      // A directory without usable metadata is not an identity. `identities`
      // reports store contents, and a half-made directory is not one.
    }
  return out;
}
