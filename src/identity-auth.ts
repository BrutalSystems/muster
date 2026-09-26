import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  identityPath,
  type IdentityMeta,
  IdentityError,
} from "./identity-store.js";
import { resolveCredential, type Credential } from "./identity-token.js";
const run = promisify(execFile);
/**
 * Claude Code stores its credential in the macOS keychain under a service name
 * derived from the configuration directory's PATH, which is why a copied
 * directory cannot authenticate: it hashes to a name that does not exist.
 */
export function claudeKeychainService(configDir: string): string {
  return (
    "Claude Code-credentials-" +
    createHash("sha256").update(configDir).digest("hex").slice(0, 8)
  );
}
/**
 * Whether a credential is CONFIGURED — never whether it works. A keychain item,
 * a parseable auth file and a set variable all prove something exists; none
 * proves it has not expired or been revoked. Reporting "valid" would be worse
 * than reporting nothing, because a caller would act on it.
 */
export type AuthState = "configured" | "not-configured";
async function keychainHas(service: string): Promise<boolean> {
  try {
    await run("security", ["find-generic-password", "-s", service]);
    return true;
  } catch {
    return false;
  }
}
async function readsAsJson(file: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(file, "utf8"));
    return true;
  } catch {
    return false;
  }
}
export async function identityAuthState(
  home: string,
  name: string,
  meta: IdentityMeta,
  env: NodeJS.ProcessEnv,
  probe: (service: string) => Promise<boolean> = keychainHas,
): Promise<{ state: AuthState; detail: string }> {
  const dir = identityPath(home, name);
  const no = (detail: string) => ({ state: "not-configured" as const, detail });
  const yes = (detail: string) => ({ state: "configured" as const, detail });
  if (meta.agent === "claude") {
    // A broken credential must not take the whole listing down with it.
    // `describeIdentities` calls this once per identity with no error handling
    // of its own, so an IdentityError thrown here — an empty token file, an
    // unreadable one — would make `muster identities` fail outright and report
    // nothing about the identities that are fine. That is the same hazard the
    // stale-grant comment in identity-cli.ts already names: a local problem
    // turning into a total outage. Reported as a state, not raised.
    let credential: Credential;
    try {
      credential = await resolveCredential(home, name, meta, env);
    } catch (e) {
      return no(e instanceof IdentityError ? e.message : String(e));
    }
    if (credential.route === "env")
      return credential.token
        ? yes(`token variable ${credential.variable} is set`)
        : no(`token variable ${credential.variable} is not set`);
    if (credential.token) return yes("a stored token is present");
    // A keychain item for the TEMPLATE's path proves the template is usable
    // where it sits, and nothing more. A launch never points Claude at the
    // template: it copies it, and the copy's path hashes to a DIFFERENT service
    // name with no fallback (see claudeKeychainService above). So the keychain
    // route cannot produce a launch, and reporting "configured" for it would
    // promise one that dies at its deadline.
    return no(
      (await probe(claudeKeychainService(dir)))
        ? "a keychain item exists for this identity's template path, but a launch runs from a copy whose path hashes to a different service name — run `setup-identity --interactive` to store a token instead"
        : "no credential for a launch — run `setup-identity --interactive` to log in and store a token",
    );
  }
  // Codex keeps a flat JSON auth file. OpenCode splits config from data: its
  // auth file lives under a data root the binary itself always suffixes with
  // "opencode" (join(XDG_DATA_HOME, "opencode", "auth.json") — confirmed
  // against the installed 1.18.32 binary and the real ~/.local/share/opencode
  // layout; see identity-copy.ts and task-4-report.md). The identity template
  // mirrors that shape under data/opencode/auth.json.
  const file =
    meta.agent === "opencode"
      ? join("data", "opencode", "auth.json")
      : "auth.json";
  return (await readsAsJson(join(dir, file)))
    ? yes(`${file} is present`)
    : no(`${file} is missing or unreadable — log in for this identity`);
}
