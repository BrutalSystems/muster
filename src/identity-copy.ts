import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { identityPath, type IdentityMeta } from "./identity-store.js";
/**
 * What a copy must contain: enough to start authenticated, onboarded, and
 * trusting the launch directory. Deliberately not the template's cache, plugins
 * or history — copying only this is what keeps retained copies proportional to
 * the transcripts written into them rather than to the template's size.
 *
 * OpenCode entries are settled against the installed 1.18.32 binary, not
 * guessed (see task-4-report.md for the full evidence trail):
 *   - CONFIG resolves as `OPENCODE_CONFIG_DIR ?? XDG_CONFIG_HOME/opencode`,
 *     used as-is with no suffix appended. The real file the binary reads on
 *     this machine is `opencode.jsonc` (confirmed at ~/.config/opencode —
 *     `config.json` and `opencode.json` are also checked, in that order, but
 *     neither exists here; `opencode.jsonc` is the one actually in use).
 *   - DATA always resolves as `XDG_DATA_HOME/opencode` — the "opencode"
 *     suffix is hardcoded in the binary and cannot be overridden
 *     independently (there is no OPENCODE_DATA_DIR). Its auth file is
 *     `<data>/auth.json`, confirmed against the string join(e.Path.data,
 *     "auth.json") in the binary and against the real file at
 *     ~/.local/share/opencode/auth.json on this machine.
 * So the copy reproduces that shape under a `data/` subdirectory, and
 * `identityEnv` points XDG_DATA_HOME at it (see below). This was NOT
 * verified end to end against an authenticated OpenCode identity — no one
 * has run the one-time login for one on this machine, so there is no
 * template to copy from and launch. The config/data path resolution above is
 * verified from the binary's own logic and the real on-disk layout; whether a
 * copy built this way actually leaves OpenCode believing itself logged in on
 * first launch is unverified.
 */
export const IDENTITY_FILES: Record<IdentityMeta["agent"], string[]> = {
  claude: [".claude.json", "settings.json"],
  codex: ["auth.json", "config.toml"],
  opencode: ["opencode.jsonc", join("data", "opencode", "auth.json")],
};
export const identityLiveDir = (home: string, launchId: string) =>
  join(home, "identities-live", launchId);
export async function copyIdentity(
  home: string,
  name: string,
  meta: IdentityMeta,
  launchId: string,
): Promise<string> {
  const from = identityPath(home, name);
  const to = identityLiveDir(home, launchId);
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const file of IDENTITY_FILES[meta.agent]) {
    const dest = join(to, file);
    // A declared file may nest inside a subdirectory (opencode's data/opencode/
    // auth.json) — the destination directory needs to exist before copyFile can
    // write into it. Not swallowed: if the parent cannot be created, that must
    // surface rather than leave the file silently absent from the copy.
    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(join(from, file), dest);
    } catch (e) {
      // A template legitimately lacks a file until the agent writes one — a new
      // identity has no settings.json yet. Anything else is a real failure, and
      // hiding it would launch an agent that cannot authenticate with no signal.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return to;
}
/**
 * The variables the AGENT receives. Muster's own subprocesses never get these:
 * a version probe pointed at a per-launch copy answers the wrong question.
 */
export function identityEnv(
  meta: IdentityMeta,
  copyPath: string,
  sourceEnv: NodeJS.ProcessEnv,
  /**
   * The already-resolved token. Resolved by the caller rather than here, because
   * the file route needs async IO and because resolving it against the TEMPLATE
   * keeps the number of on-disk copies of the secret at one — the per-launch
   * copy never carries it.
   */
  credential?: string,
): Record<string, string> {
  if (meta.agent === "codex") return { CODEX_HOME: copyPath };
  if (meta.agent === "opencode")
    // OPENCODE_CONFIG_DIR replaces the config root outright, so it is set to
    // copyPath directly. XDG_DATA_HOME is different: the binary hardcodes an
    // "opencode" suffix onto whatever XDG_DATA_HOME is, so XDG_DATA_HOME must be
    // set one level ABOVE where the files actually land (copyPath/data, not
    // copyPath/data/opencode) for that suffix to land back on the copy.
    return {
      OPENCODE_CONFIG_DIR: copyPath,
      XDG_DATA_HOME: join(copyPath, "data"),
    };
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: copyPath };
  // Absence is the caller's problem to report before spawning; see run.ts.
  if (credential) env.CLAUDE_CODE_OAUTH_TOKEN = credential;
  return env;
}
/**
 * Set Claude Code's workspace-trust flag for one directory, inside a copy Muster
 * just created. The live `~/.claude.json` is never touched — that file is written
 * continuously by every running session, and Muster cannot coordinate with it.
 */
export async function setWorkspaceTrust(
  copyPath: string,
  cwd: string,
): Promise<void> {
  const file = join(copyPath, ".claude.json");
  let data: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    // The same rule identity-store.ts and copyIdentity settled on: a template
    // that has never been logged into legitimately has no .claude.json, and a
    // file containing only `projects` is valid. Anything else — EACCES, EISDIR —
    // is a real failure, and swallowing it here discarded every onboarding flag
    // the template's own login produced and wrote a file that had lost them.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== undefined)
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      // A file that EXISTS and does not parse is not "no file yet". Overwriting
      // it would silently drop the copied template's onboarding state and leave
      // an agent that re-onboards, or does not start at all, with no signal.
      throw new Error(`${file} exists but is not valid JSON: ${String(e)}`);
    }
  const projects = (data.projects ?? {}) as Record<string, unknown>;
  const existing = (projects[cwd] ?? {}) as Record<string, unknown>;
  projects[cwd] = { ...existing, hasTrustDialogAccepted: true };
  data.projects = projects;
  await writeFile(file, JSON.stringify(data), { mode: 0o600 });
}
/**
 * Set Codex's directory-trust flag for one directory, inside a copy Muster just
 * created. Codex has its own gate, unrelated to Claude's: without a
 * `[projects."<dir>"] trust_level = "trusted"` entry in the config.toml it
 * reads, the TUI stops on "Do you trust the contents of this directory?" before
 * it ever opens a thread. No thread is opened, so no thread-writer lock is
 * written, so `resolveCodex` finds nothing and the launch burns its whole
 * deadline reporting `no descendant runtime identity found`.
 *
 * A fresh identity copy has no `projects` table at all, which made EVERY Codex
 * identity launch fail exactly that way — measured, not inferred: the pane was
 * captured mid-launch sitting on the prompt while the copy filled with Codex's
 * own sqlite state and never grew a `thread-writer-locks/` directory.
 *
 * `-c projects."<dir>".trust_level="trusted"` does NOT satisfy the gate. It
 * parses and is accepted, and the prompt still appears: the check reads
 * persisted config, so the entry has to be in the file.
 *
 * The user's real `~/.codex/config.toml` is never touched, for the same reason
 * `setWorkspaceTrust` leaves the live `~/.claude.json` alone.
 */
export async function setCodexWorkspaceTrust(
  copyPath: string,
  cwd: string,
): Promise<void> {
  const file = join(copyPath, "config.toml");
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    // A template that has never been logged into has no config.toml; Codex
    // runs on defaults. Anything else — EACCES, EISDIR — is a real failure,
    // and swallowing it would hand the agent a config missing every setting
    // the template's own login wrote.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let data: Record<string, unknown> = {};
  if (raw !== undefined)
    try {
      data = TOML.parse(raw) as Record<string, unknown>;
    } catch (e) {
      // A file that EXISTS and does not parse is not "no file yet". Codex would
      // refuse it too, so writing over it trades one clear failure for a silent
      // loss of the template's settings.
      throw new Error(`${file} exists but is not valid TOML: ${String(e)}`);
    }
  const projects = (data.projects ?? {}) as Record<string, unknown>;
  const existing = (projects[cwd] ?? {}) as Record<string, unknown>;
  if (existing.trust_level === "trusted") return;
  projects[cwd] = { ...existing, trust_level: "trusted" };
  data.projects = projects;
  // Re-serialised rather than appended, so an entry the template already
  // carries with a different trust_level is corrected instead of duplicated —
  // a duplicate table is a TOML error and Codex would refuse the whole file.
  // Comments and key order in the copy are lost; the copy is per-launch and
  // machine-read, and the template it came from is untouched.
  await writeFile(file, TOML.stringify(data as TOML.JsonMap), { mode: 0o600 });
}
