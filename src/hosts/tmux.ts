import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command, processRef, stopTree } from "../identity/processes.js";
import type { TerminalHost, LaunchOptions, TerminalApp } from "./types.js";
import { terminalAvailable, tmuxExecutable, openTerminal } from "./terminal.js";
/** tmux rewrites every control character in `-F` output to an underscore when
 * it runs without a UTF-8 locale — LANG, LC_ALL and LC_CTYPE all unset, which is
 * ordinary for a launchd job, a bare `ssh host cmd`, or an agent harness. A tab
 * delimiter then arrives as `@0_11657` and nothing parses. That is #21, filed as
 * a tmux 3.7c bug on two Macs; it is neither version nor machine specific —
 * `env -u LANG -u LC_ALL -u LC_CTYPE` reproduces it anywhere, and exporting a
 * UTF-8 locale makes it vanish on the machines that "had" it.
 *
 * So no format here may contain a character tmux is willing to rewrite.
 * Printable ASCII passes through untouched, and a pipe cannot occur in
 * #{window_id} (@N), #{pane_pid} (digits), or a session name muster generates.
 * The one free-text field is read last and keeps whatever it splits into. */
const FIELD = "|";
export const LAUNCH_FORMAT = `#{window_id}${FIELD}#{pane_pid}`;
export const LIST_FORMAT = `#{window_id}${FIELD}#{pane_pid}${FIELD}#{session_name}${FIELD}#{window_name}`;
export const CLEANUP_FORMAT = `#{window_id}${FIELD}#{pane_start_command}`;
/** `window_activity`, never `session_activity`: the latter does not advance for
 *  a detached session, and every muster session is detached. */
export const SESSION_STATE_FORMAT = `#{window_activity}${FIELD}#{session_created}${FIELD}#{session_attached}${FIELD}#{session_last_attached}`;
export type SessionState = { idle: number; age: number; attached: boolean };
export function parseSessionState(
  row: string,
  now: number,
): SessionState | null {
  const [activity, created, attached, lastAttached] = row.trim().split(FIELD);
  if (!/^\d+$/.test(activity ?? "") || !/^\d+$/.test(created ?? ""))
    return null;
  // Attaching and detaching does not advance `window_activity`, so a session
  // someone read for ten minutes and left would be reaped on the next poll.
  // tmux reports 0 for never-attached, which must not read as 1970.
  const seen = Math.max(
    Number(activity),
    /^\d+$/.test(lastAttached ?? "") ? Number(lastAttached) : 0,
  );
  return {
    idle: now - seen,
    age: now - Number(created),
    attached: Number(attached ?? 0) > 0,
  };
}
export function parseWindowRow(output: string): {
  hostRef: string;
  pid: number;
} {
  const [hostRef, pid] = output.trim().split(FIELD);
  if (!hostRef || !/^@\d+$/.test(hostRef) || !Number(pid))
    throw new Error(
      "tmux returned an invalid window identity: " +
        JSON.stringify(
          output.length > 200 ? output.slice(0, 200) + "\u2026" : output,
        ),
    );
  return { hostRef, pid: Number(pid) };
}
export function parseWindowList(output: string) {
  return output
    .trim()
    .split("\n")
    .map((row) => row.split(FIELD))
    .filter(
      ([, , session]) =>
        session === "muster" || /^muster-[0-9a-f-]{36}$/.test(session ?? ""),
    )
    .map(([hostRef, pid, , ...label]) => ({
      hostRef: hostRef!,
      pid: Number(pid),
      label: label.join(FIELD),
    }));
}
/**
 * One shell command line for `run-shell`.
 *
 * Two escapes, not one. POSIX single-quoting keeps the shell from splitting an
 * argument, and `#` is doubled because tmux expands the command as a FORMAT
 * before any shell sees it: an unescaped `#{pane_pid}` inside a path is
 * silently replaced, and quoting cannot prevent that.
 */
export function tmuxCommand(argv: string[]): string {
  return argv
    .map((a) => `'${a.replaceAll("'", `'\\''`).replaceAll("#", "##")}'`)
    .join(" ");
}
export class TmuxHost implements TerminalHost {
  readonly id = "tmux" as const;
  /**
   * `status` is set explicitly on every session rather than left to tmux's
   * default, so the bar's state is what Muster asked for whatever version of
   * tmux is installed. Off by default: Muster's server is its own (`-L`, with
   * `-f /dev/null`), so the bar here is never the developer's configured one,
   * and a session is one window running one agent — the bar reports only what
   * the caller already knows. `tmux_status = "on"` in config.toml restores it.
   */
  constructor(
    readonly server = "muster",
    readonly status: "on" | "off" = "off",
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(server))
      throw new Error("Invalid tmux server");
  }
  private call(args: string[], deadline = Date.now() + 5000) {
    return command(
      "tmux",
      ["-L", this.server, "-f", "/dev/null", ...args],
      Math.max(1, Math.min(5000, deadline - Date.now())),
    );
  }
  async available() {
    try {
      await command("tmux", ["-V"]);
      return true;
    } catch {
      return false;
    }
  }
  openAvailable(terminal: TerminalApp = "terminal") {
    return terminalAvailable(process.platform, terminal);
  }
  async open(
    hostRef: string,
    deadline: number,
    terminal: TerminalApp = "terminal",
  ) {
    await openTerminal(
      await tmuxExecutable(),
      this.server,
      hostRef,
      deadline,
      terminal,
    );
  }
  capabilities() {
    return { watchable: true, attachable: true, survivesParentExit: true };
  }
  /** The tmux server this host talks to, so a caller needing it in an armed
   *  command does not reach in with a structural cast. */
  socketName() {
    return this.server;
  }
  /** Null when the window is gone — the caller stops rather than guesses. */
  async sessionState(hostRef: string): Promise<SessionState | null> {
    try {
      const row = await this.call([
        "display-message",
        "-p",
        "-t",
        hostRef,
        SESSION_STATE_FORMAT,
      ]);
      return parseSessionState(row, Math.floor(Date.now() / 1000));
    } catch {
      return null;
    }
  }
  /**
   * Run `argv` in the background after `seconds`, scheduled by the tmux server
   * itself. This is what lets a lifecycle outlive every muster process: nothing
   * of ours is running between the call and the job.
   */
  async schedule(seconds: number, argv: string[]): Promise<void> {
    await this.call([
      "run-shell",
      "-b",
      "-d",
      String(Math.max(1, Math.round(seconds))),
      tmuxCommand(argv),
    ]);
  }
  async launch(opts: LaunchOptions) {
    const dir = await mkdtemp(join(tmpdir(), "muster-host-"));
    const file = join(dir, "launch.json");
    await writeFile(file, JSON.stringify(opts), { mode: 0o600 });
    const worker = fileURLToPath(
      new URL("../../dist/hosts/bootstrap.js", import.meta.url),
    );
    const common = [
      "-d",
      "-P",
      "-F",
      LAUNCH_FORMAT,
      "-n",
      opts.label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "agent",
      "-c",
      opts.cwd,
      process.execPath,
      worker,
      file,
    ];
    try {
      // Window selection is session-wide: sharing a session makes every
      // attached terminal follow whichever agent was opened most recently.
      const session = `muster-${randomUUID()}`;
      // One tmux invocation, not two: a second round trip would leave the bar
      // visible for as long as it took, and `;` keeps set-option in the same
      // command list. Targeted by session name rather than relying on "current",
      // which is not meaningful for a detached session.
      const output = await this.call(
        [
          "new-session",
          "-s",
          session,
          ...common,
          ";",
          "set-option",
          "-t",
          session,
          "status",
          this.status,
        ],
        opts.deadline,
      );
      return parseWindowRow(output);
    } catch (e) {
      // The client can time out just after tmux creates the window.
      try {
        const windows = await this.call([
          "list-windows",
          "-a",
          "-F",
          CLEANUP_FORMAT,
        ]);
        for (const row of windows.split("\n"))
          if (row.includes(file)) await this.stop(row.split(FIELD)[0]!);
      } catch {}
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async list() {
    try {
      return parseWindowList(
        await this.call(["list-windows", "-a", "-F", LIST_FORMAT]),
      );
    } catch {
      return [];
    }
  }
  async stop(hostRef: string) {
    const entry = (await this.list()).find((x) => x.hostRef === hostRef);
    if (entry) {
      const ref = await processRef(entry.pid);
      if (ref) await stopTree(ref);
      try {
        await this.call(["kill-window", "-t", hostRef]);
      } catch {}
    }
  }
  attachHint(hostRef: string) {
    return `tmux -L ${this.server} attach-session -t ${hostRef}`;
  }
}
