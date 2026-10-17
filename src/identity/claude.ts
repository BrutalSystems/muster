/** Registry-reading mechanics vendored from Tin Can src/claude/discover.ts at
 * fbaaea5842fd4a5c86849d7f51c8e16b8683b058 (MIT). Only captured descendants are
 * read, rather than scanning and diffing live sessions. */
import { readFile, access, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { command, descendants } from "./processes.js";
import { workspaceTrustKey } from "./workspace-key.js";
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
/** The configuration directory itself, which `claudeSessionsDir` and
 * `claudeTrustFile` both follow. Resolved from the same CLAUDE_CONFIG_DIR so
 * the two cannot drift: a trust decision read from a different profile than
 * the one the launch records its session in would describe a profile nobody
 * is launching. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured.length) return configured;
  return join(env.HOME ?? homedir(), ".claude");
}
/**
 * The file Claude Code keeps workspace trust in. Not inside the configuration
 * directory by default: with no CLAUDE_CONFIG_DIR it is `~/.claude.json`,
 * beside `~/.claude`, and only a relocated profile keeps it inside.
 */
export function claudeTrustFile(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return typeof configured === "string" && configured.length
    ? join(configured, ".claude.json")
    : join(env.HOME ?? homedir(), ".claude.json");
}
/**
 * Every key whose accepted dialog lets a launch in `cwd` past Claude's trust
 * dialog. The dialog gate walks up from the launch directory and stops at the
 * git repo's top level, or walks to `/` outside a repository — so a trusted
 * parent counts inside its own repo and never across a repo boundary. The
 * repo's own trust key (the main checkout, for a linked worktree) is what
 * Muster writes, so it counts too. See `workspaceTrustKey`.
 */
async function trustKeys(cwd: string): Promise<string[]> {
  const resolved = await realpath(cwd).catch(() => cwd);
  let top: string | undefined;
  try {
    const shown = (
      await command(
        "git",
        ["-C", resolved, "rev-parse", "--show-toplevel"],
        2000,
      )
    ).trim();
    if (shown) top = await realpath(shown).catch(() => shown);
  } catch {}
  const keys = new Set([cwd]);
  for (let dir = resolved; ; dir = dirname(dir)) {
    keys.add(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  keys.add(await workspaceTrustKey(resolved));
  return [...keys];
}
/**
 * Whether Claude Code would let a session in `cwd` past its workspace-trust
 * dialog, in the profile a launch would use: an accepted dialog on the
 * directory, on an ancestor inside the same git repo, or on the repo's trust
 * key. Checking the exact directory alone called every worktree and every
 * subdirectory of a trusted repo untrusted, and blamed trust for a launch that
 * had simply timed out (#68).
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
    raw = await readFile(claudeTrustFile(env), "utf8");
  } catch {
    return false;
  }
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }>;
  try {
    projects =
      (JSON.parse(raw) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return false;
  }
  return (await trustKeys(cwd)).some(
    (key) => projects[key]?.hasTrustDialogAccepted === true,
  );
}
/**
 * The message a Claude launch dies with when no session ever registered.
 *
 * A session sitting on a consent screen has no registry record at all, so the
 * timeout looks identical to a hung or crashed launch. Several unrelated
 * screens can produce it, and the old message guessed at two of them together.
 * Trust is the one Muster can actually check, so it is either named or ruled
 * out. The bypass-permissions warning is named only for a launch that ran in
 * bypass without `accept-bypass-warning`: demonstrated in #45, and that launch
 * is the only one it can stop. Anything else says "another one-time
 * confirmation" rather than sending the reader after a screen nobody has
 * demonstrated.
 *
 * A `--kind task` launch into the same directory is the cheap discriminator:
 * it runs headless and never sees the dialog, so it succeeds where a session
 * hangs.
 */
export function claudeRegistryDiagnostic(
  trusted: boolean,
  cwd: string,
  trustFile: string,
  opts: { bypassWarningPending?: boolean } = {},
): string {
  if (!trusted)
    return (
      `no Claude session registry found: workspace trust has not been ` +
      `accepted for ${cwd} in ${trustFile} — accept it once with ` +
      `\`cd ${cwd} && claude\`, then retry (a trusted parent directory ` +
      `counts only inside the same git repository)`
    );
  if (opts.bypassWarningPending)
    return (
      `no Claude session registry found (${cwd} is trusted for this profile): ` +
      `this launch runs in bypass permissions, and Claude stops on its ` +
      `one-time "Bypass Permissions mode" warning until someone answers it — ` +
      `relaunch with --options accept-bypass-warning to accept it for the launch`
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
