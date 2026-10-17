/**
 * Running an `--on-exit` command: what it is told, and where its output goes.
 * Kept out of run.ts so the environment contract can be tested without a
 * launch, since that contract is what every caller's script depends on.
 */
import { mkdir, open } from "node:fs/promises";
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
    MUSTER_RECORD: JSON.stringify(record),
  };
}

/** Runs `command` through `/bin/sh -c`, resolving to its exit code. */
export async function runOnExitCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entry: Entry;
  record: Record<string, any>;
  logPath: string;
}): Promise<number | null> {
  await mkdir(dirname(opts.logPath), { recursive: true, mode: 0o700 });
  const log = await open(opts.logPath, "a", 0o600);
  try {
    return await new Promise<number | null>((resolve) => {
      const child = spawn("/bin/sh", ["-c", opts.command], {
        cwd: opts.cwd,
        env: { ...opts.env, ...onExitEnv(opts.entry, opts.record) },
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code));
    });
  } finally {
    await log.close();
  }
}
