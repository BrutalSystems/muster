import { access, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { builtinTerminals } from "./types.js";
import type { OpenerCommand, TerminalApp } from "./types.js";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { command } from "../identity/processes.js";

export async function terminalAvailable(
  platform: string = process.platform,
  terminal: TerminalApp = "terminal",
  opener?: OpenerCommand,
) {
  if (!isBuiltin(terminal)) return opener ? openerAvailable(opener) : false;
  if (platform !== "darwin") return false;
  try {
    if (terminal === "terminal") {
      await access("/System/Applications/Utilities/Terminal.app");
    } else {
      const name = terminal === "ghostty" ? "Ghostty.app" : "iTerm.app";
      const found = await Promise.all(
        ["/Applications", join(homedir(), "Applications")].map(async (dir) => {
          try {
            await access(join(dir, name));
            return true;
          } catch {
            return false;
          }
        }),
      );
      if (!found.some(Boolean)) return false;
    }
    await access(
      terminal === "ghostty" ? "/usr/bin/open" : "/usr/bin/osascript",
      constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}
function isBuiltin(terminal: string) {
  return (builtinTerminals as readonly string[]).includes(terminal);
}
/** The command a configured opener runs: an absolute path, or a name on PATH. */
async function openerExecutable(file: string) {
  const dirs = file.includes("/")
    ? [""]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const path = file.includes("/") ? file : join(dir, file);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
}
async function openerAvailable(opener: OpenerCommand) {
  return (await openerExecutable(opener[0]!)) !== undefined;
}
/**
 * A configured opener's argv with the placeholders filled in. The values are
 * validated by the caller; each argv element stays one element, so nothing here
 * is parsed by a shell.
 */
export function openerArgv(
  opener: OpenerCommand,
  values: { tmux: string; server: string; target: string },
) {
  return opener.map((arg) =>
    arg.replace(
      /\{(tmux|server|target)\}/g,
      (_, key: keyof typeof values) => values[key],
    ),
  );
}
/**
 * Starts a configured opener without waiting for it to finish: a terminal that
 * stays in the foreground (`kitty -e …`) runs until its window closes, so
 * waiting would kill it at the timeout. Success is a clean spawn that has not
 * failed within a short grace; a spawn error or a non-zero exit inside the
 * grace is reported.
 */
function startOpener(
  name: string,
  file: string,
  args: string[],
  timeout: number,
) {
  const grace = Math.min(1500, timeout);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    const fail = (why: string) =>
      reject(new Error(`Opener "${name}" failed: ${why}`));
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, grace);
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else fail(signal ? `killed by ${signal}` : `exit ${code}`);
    });
  });
}
export async function tmuxExecutable() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, "tmux");
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {}
  }
  throw new Error("Cannot locate tmux executable for terminal viewer");
}
export async function openTerminal(
  tmux: string,
  server: string,
  hostRef: string,
  deadline: number,
  terminal: TerminalApp = "terminal",
  opener?: OpenerCommand,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(server) || !/^@\d+$/.test(hostRef))
    throw new Error("Invalid tmux terminal target");
  if (Date.now() >= deadline)
    throw new Error("Launch deadline expired before opening terminal");
  const timeout = Math.max(1, Math.min(10000, deadline - Date.now()));
  if (!isBuiltin(terminal)) {
    if (!opener)
      throw new Error(`No opener configured for terminal "${terminal}"`);
    const [file, ...args] = openerArgv(opener, {
      tmux,
      server,
      target: hostRef,
    });
    const found = await openerExecutable(file!);
    if (!found)
      throw new Error(`Opener "${terminal}": cannot find command "${file}"`);
    await startOpener(terminal, found, args, timeout);
    return;
  }
  if (terminal === "ghostty") {
    await command(
      "/usr/bin/open",
      [
        "-na",
        "Ghostty",
        "--args",
        "--quit-after-last-window-closed=true",
        // A separate instance otherwise restores the user's saved tabs/windows.
        "--window-save-state=never",
        "-e",
        tmux,
        "-L",
        server,
        "attach-session",
        "-t",
        hostRef,
      ],
      timeout,
    );
    return;
  }
  const quoted = "'" + tmux.replaceAll("'", "'\\''") + "'";
  const shellCommand = `${quoted} -L ${server} attach-session -t ${hostRef}`;
  // Terminal must create the requested window before activation. Activating
  // a cold app first also creates its default shell window.
  await command(
    "/usr/bin/osascript",
    [
      "-e",
      terminal === "iterm2"
        ? `on run argv
  tell application "iTerm"
    create window with default profile command (item 1 of argv)
    activate
  end tell
end run`
        : `on run argv
  tell application "Terminal"
    launch
    do script (item 1 of argv)
    activate
  end tell
end run`,
      shellCommand,
    ],
    timeout,
  );
}
