/**
 * Running an `--on-exit` command: what it is told, and where its output goes.
 * Kept out of run.ts so the environment contract can be tested without a
 * launch, since that contract is what every caller's script depends on.
 */
import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { Entry } from "./registry.js";

/**
 * The variables the command receives. Strings only, and an empty string where
 * the fact was not observed — a session's exit status, a session's output —
 * because a shell cannot tell an unset variable from a mistyped one.
 */
export function onExitEnv(
  entry: Pick<Entry, "runtime" | "kind" | "outputPath">,
  record: Record<string, any>,
): Record<string, string> {
  return {
    MUSTER_ID: String(record.id),
    MUSTER_RUNTIME: entry.runtime,
    MUSTER_KIND: entry.kind,
    MUSTER_STATE: String(record.state),
    MUSTER_EXIT_CODE:
      record.exit_code === null || record.exit_code === undefined
        ? ""
        : String(record.exit_code),
    MUSTER_SIGNAL: record.signal ? String(record.signal) : "",
    // A path rather than the text: a task's output can be megabytes, and the
    // environment has a size limit that would fail the command outright.
    MUSTER_OUTPUT:
      entry.kind === "task" && entry.outputPath ? entry.outputPath : "",
    // Why a launch failed before it was ever up (`MUSTER_STATE=failed`).
    MUSTER_ERROR: record.error ? String(record.error) : "",
    MUSTER_RECORD: JSON.stringify(record),
  };
}

/**
 * Where the command will run and where its output will go, settled before the
 * command is claimed, because a claim is spent whether or not it then starts.
 * Neither failure is allowed to cost the signal: a directory removed since the
 * launch falls back to `fallbackCwd`, and a log that cannot be opened leaves
 * the output discarded. Each fallback is reported, for the launch log.
 */
export async function prepareOnExit(opts: {
  cwd: string;
  fallbackCwd: string;
  logPath: string;
}): Promise<{ cwd: string; log?: FileHandle; warnings: string[] }> {
  const warnings: string[] = [];
  let cwd = opts.cwd;
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (e) {
    warnings.push(
      `cwd ${cwd} unusable (${(e as Error).message}); ran in ${opts.fallbackCwd}`,
    );
    cwd = opts.fallbackCwd;
  }
  try {
    await mkdir(dirname(opts.logPath), { recursive: true, mode: 0o700 });
    return { cwd, log: await open(opts.logPath, "a", 0o600), warnings };
  } catch (e) {
    warnings.push(
      `log ${opts.logPath} unusable (${(e as Error).message}); output discarded`,
    );
    return { cwd, warnings };
  }
}

/**
 * Runs `command` through `/bin/sh -c`, resolving to how it ended, or to why it
 * never started. `onSpawn` is called once the shell is running, so whatever it
 * does cannot keep the command from starting.
 */
export async function runOnExitCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entry: Entry;
  record: Record<string, any>;
  log?: FileHandle;
  onSpawn?: () => void;
}): Promise<{
  exit_code: number | null;
  signal: string | null;
  error?: string;
}> {
  const out = opts.log?.fd ?? "ignore";
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", opts.command], {
      cwd: opts.cwd,
      env: { ...opts.env, ...onExitEnv(opts.entry, opts.record) },
      stdio: ["ignore", out, out],
    });
    child.once("spawn", () => opts.onSpawn?.());
    child.once("error", (e) =>
      resolve({ exit_code: null, signal: null, error: e.message }),
    );
    child.once("exit", (code, signal) =>
      resolve({ exit_code: code, signal: signal ?? null }),
    );
  });
}
