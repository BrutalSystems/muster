import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { TerminalApp } from "./types.js";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { command } from "../identity/processes.js";

export async function terminalAvailable(
  platform: string = process.platform,
  terminal: TerminalApp = "terminal",
) {
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
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(server) || !/^@\d+$/.test(hostRef))
    throw new Error("Invalid tmux terminal target");
  if (Date.now() >= deadline)
    throw new Error("Launch deadline expired before opening terminal");
  const timeout = Math.max(1, Math.min(10000, deadline - Date.now()));
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
