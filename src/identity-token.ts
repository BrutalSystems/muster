import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { IdentityError, identityPath } from "./identity-store.js";
/**
 * Where an identity's own credential lives, for the agents whose login does not
 * write one into the template itself. Deliberately the same directory Codex and
 * OpenCode identities already hold `auth.json` in, so one statement is true of
 * every agent: deleting an identity's directory revokes its credential.
 */
export const tokenPath = (home: string, name: string) =>
  join(identityPath(home, name), "token");
/**
 * The stored token, or undefined when there is none.
 *
 * Absent and empty are different answers. A missing file is an identity that
 * has not been logged in yet; a file holding nothing is a broken write, and
 * reporting it as "not configured" would send the operator to create a
 * credential they already tried to create.
 */
export async function readStoredToken(
  home: string,
  name: string,
): Promise<string | undefined> {
  const file = tokenPath(home, name);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // EACCES, EISDIR and friends are real failures. Swallowing them would
    // report "no credential" for an identity whose credential is right there.
    throw new IdentityError(
      name,
      `token could not be read (${code ?? String(e)})`,
    );
  }
  const token = raw.trim();
  if (!token)
    throw new IdentityError(
      name,
      "token file is empty — store it again with `setup-identity --interactive`",
    );
  return token;
}
export async function writeStoredToken(
  home: string,
  name: string,
  token: string,
): Promise<void> {
  const value = token.trim();
  if (!value) throw new IdentityError(name, "refusing to store an empty token");
  const dir = identityPath(home, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Written whole or not at all. A truncated credential reads as present and
  // fails at the agent, which is the worst of both outcomes.
  const temp = join(dir, `.token.${randomUUID()}`);
  try {
    await writeFile(temp, value + "\n", { mode: 0o600 });
    await rename(temp, tokenPath(home, name));
  } catch (e) {
    await rm(temp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    throw new IdentityError(
      name,
      `token could not be written (${code ?? String(e)})`,
    );
  }
}
/** True when a token file was there to remove. */
export async function removeStoredToken(
  home: string,
  name: string,
): Promise<boolean> {
  try {
    await rm(tokenPath(home, name));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new IdentityError(
      name,
      `token could not be removed (${code ?? String(e)})`,
    );
  }
}

import type { IdentityMeta } from "./identity-store.js";
/**
 * Which route an identity's credential travels, and its value if present.
 *
 * The two are mutually exclusive by construction, so there is no precedence
 * rule to get wrong: `token_env` declared means the env route, and its absence
 * means the file route.
 */
export type Credential =
  | { route: "env"; variable: string; token?: string }
  | { route: "file"; token?: string };
export async function resolveCredential(
  home: string,
  name: string,
  meta: IdentityMeta,
  env: NodeJS.ProcessEnv,
): Promise<Credential> {
  if (meta.token_env)
    return {
      route: "env",
      variable: meta.token_env,
      token: env[meta.token_env] || undefined,
    };
  // No environment is consulted here, and that is the point. A file-route
  // identity answers identically in every shell, which is what makes
  // `muster identities` mean the same thing wherever it is run.
  return { route: "file", token: await readStoredToken(home, name) };
}
