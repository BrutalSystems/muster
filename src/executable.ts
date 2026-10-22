import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Runtime } from "./types.js";

const exec = promisify(execFile);

/**
 * The program every spawn of a runtime runs: the launch itself and each probe
 * Muster makes of it. One answer for all of them, because a probe that asks a
 * different copy than the one launched checks the wrong program — a session
 * pinned to an old Codex inspected by whatever `codex` is newest on PATH.
 */
export function runtimeCommand(
  runtime: Runtime,
  executable: string | undefined,
): string {
  return executable ?? runtime;
}

/**
 * What each runtime prints for `--version`. Matching it catches a path that
 * names the wrong program — a Claude binary handed to a Codex launch — not a
 * hostile one: anything can print a version string.
 */
const VERSION_FORMATS: Record<Runtime, RegExp> = {
  codex: /^codex-cli (\d+\.\d+\.\d+\S*)$/,
  claude: /^(\d+\.\d+\.\d+\S*) \(Claude Code\)$/,
  opencode: /^v?(\d+\.\d+\.\d+\S*)$/,
};

/** What a launch records about the binary it ran. */
export type LaunchExecutable = { path: string; version: string };

export type RuntimeExecutable = LaunchExecutable & {
  /**
   * Whether this Codex can be kept off the shared app-server daemon. A daemon
   * started by another Codex runs that copy's version, so a pinned session that
   * attached to it would not be running the version it named. A Codex without
   * the flag predates the daemon and cannot attach to one.
   */
  noDaemon: boolean;
};

/**
 * Validates a caller-named runtime executable before anything is reserved.
 * `env` is the composed launch environment, so the probe sees what the launch
 * will see.
 */
export async function inspectExecutable(
  runtime: Runtime,
  path: string,
  env: NodeJS.ProcessEnv,
  deadline = Date.now() + 8000,
): Promise<RuntimeExecutable> {
  if (!isAbsolute(path))
    throw new Error(`--executable must be an absolute path: ${path}`);
  try {
    if (!(await stat(path)).isFile()) throw new Error();
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`--executable is not an executable file: ${path}`);
  }
  const run = async (args: string[]) =>
    (
      await exec(path, args, {
        env,
        timeout: Math.max(1, Math.min(4000, deadline - Date.now())),
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      })
    ).stdout.trim();
  let printed: string;
  try {
    printed = await run(["--version"]);
  } catch {
    throw new Error(
      `--executable did not answer --version: ${path} (is it ${runtime}?)`,
    );
  }
  const version = VERSION_FORMATS[runtime].exec(printed)?.[1];
  if (!version)
    throw new Error(
      `--executable is not ${runtime}: ${path} printed ${JSON.stringify(printed.slice(0, 80))} for --version`,
    );
  let noDaemon = false;
  if (runtime === "codex")
    try {
      noDaemon = /--no-daemon\b/.test(await run(["--help"]));
    } catch {
      throw new Error(`--executable did not answer --help: ${path}`);
    }
  return { path, version, noDaemon };
}
