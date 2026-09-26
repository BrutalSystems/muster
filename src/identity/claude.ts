/** Registry-reading mechanics vendored from Tin Can src/claude/discover.ts at
 * fbaaea5842fd4a5c86849d7f51c8e16b8683b058 (MIT). Only captured descendants are
 * read, rather than scanning and diffing live sessions. */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { descendants } from "./processes.js";
export type ClaudeIdentity = {
  id: string;
  pid: number;
  rawName: string | null;
  cwd: string;
  state: "idle" | "busy";
  socketPath: string;
};
/**
 * Where Claude Code records its sessions. `CLAUDE_CONFIG_DIR` relocates the whole
 * configuration directory, sessions included, so discovery must follow it —
 * otherwise a launch whose configuration was relocated records its session
 * somewhere Muster never looks, and resolution fails at the deadline rather than
 * reporting anything useful.
 */
export function claudeSessionsDir(env: NodeJS.ProcessEnv): string {
  return join(claudeConfigDir(env), "sessions");
}
/** The configuration directory itself, which `claudeSessionsDir` and the
 * workspace-trust read below both hang off. Split out so the two cannot drift:
 * a trust decision read from a different directory than the one the launch
 * records its session in would describe a profile nobody is launching. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured.length) return configured;
  return join(env.HOME ?? homedir(), ".claude");
}
/**
 * Whether Claude Code has recorded an accepted workspace-trust dialog for one
 * directory, in the profile a launch would use. Trust is per-directory and is
 * NOT inherited from a parent: a trusted `/Source/arm` says nothing about
 * `/Source/arm/centrumx`, and the child still stops at the dialog.
 *
 * This only ever READS. Muster does not accept the dialog on the operator's
 * behalf — `setWorkspaceTrust` writes that flag into an identity copy Muster
 * itself created, never into the live `~/.claude.json`, and this must not
 * become a way around that.
 *
 * Every failure answers `false`, because the only caller is a diagnostic on a
 * launch that has already failed. A missing, unreadable or malformed file
 * means Muster cannot say trust was accepted, which is exactly what `false`
 * reports here; throwing would replace a useful message with a worse one.
 */
export async function claudeWorkspaceTrusted(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(claudeConfigDir(env), ".claude.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(raw) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    return data.projects?.[cwd]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}
/**
 * The message a Claude launch dies with when no session ever registered.
 *
 * A session sitting on a consent screen has no registry record at all, so the
 * timeout looks identical to a hung or crashed launch. Several unrelated
 * screens can produce it, and the old message guessed at two of them together.
 * Trust is the one Muster can actually check, so it is either named or ruled
 * out. Nothing else is named: a first-use bypass-permissions confirmation was
 * a plausible account of one report, but no profile on this machine carries a
 * key for it the way they carry `hasSeenAutoModeEntryWarning` and its
 * siblings, so this says "another one-time confirmation" rather than sending
 * the reader after a screen nobody has demonstrated.
 *
 * A `--kind task` launch into the same directory is the cheap discriminator:
 * it runs headless and never sees the dialog, so it succeeds where a session
 * hangs.
 */
export function claudeRegistryDiagnostic(
  trusted: boolean,
  cwd: string,
  configDir: string,
): string {
  if (!trusted)
    return (
      `no Claude session registry found: workspace trust has not been ` +
      `accepted for ${cwd} in ${configDir} — accept it once with ` +
      `\`cd ${cwd} && claude\`, then retry (trust is per-directory and is ` +
      `not inherited from a parent directory)`
    );
  return (
    `no Claude session registry found (${cwd} is trusted for this profile, ` +
    `so the session is stopped on something else — check the terminal for a ` +
    `login prompt or another one-time confirmation)`
  );
}
export async function resolveClaude(
  root: number,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<ClaudeIdentity | undefined> {
  const dir = claudeSessionsDir(env);
  const matches: ClaudeIdentity[] = [];
  for (const pid of await descendants(root, deadline)) {
    if (Date.now() >= deadline)
      throw new Error("Claude identity deadline elapsed");
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(
        await readFile(join(dir, pid + ".json"), {
          encoding: "utf8",
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        }),
      );
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === "ENOENT" ||
        e instanceof SyntaxError
      )
        continue;
      throw e;
    }
    if (rec.pid !== undefined && rec.pid !== pid) continue;
    if (typeof rec.sessionId !== "string" || !rec.sessionId) continue;
    let socketPath =
      typeof rec.messagingSocketPath === "string"
        ? rec.messagingSocketPath
        : undefined;
    if (!socketPath) {
      for (const base of [
        env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "cc-socks") : undefined,
        "/tmp/cc-socks",
        `/tmp/cc-socks-${process.getuid?.() ?? 0}`,
      ]) {
        if (!base) continue;
        const candidate = join(base, pid + ".sock");
        try {
          await access(candidate);
          socketPath = candidate;
          break;
        } catch {}
      }
    }
    if (socketPath)
      matches.push({
        id: rec.sessionId,
        pid,
        rawName:
          typeof rec.name === "string" && rec.name !== "" ? rec.name : null,
        cwd: typeof rec.cwd === "string" ? rec.cwd : "",
        state: rec.status === "idle" ? "idle" : "busy",
        socketPath,
      });
  }
  if (matches.length > 1)
    throw new Error(
      "Multiple Claude sessions registered by launched descendants",
    );
  return matches[0];
}
