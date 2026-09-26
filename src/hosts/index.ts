import { TmuxHost } from "./tmux.js";
import { PtyHost } from "./pty.js";
import { MacosTerminalHost } from "./macos-terminal.js";
import type { TerminalHost } from "./types.js";
/**
 * There is one Muster tmux server per machine, which is why the name is a
 * default rather than a parameter everywhere. `MUSTER_TMUX_SERVER` overrides it
 * for callers that must not share that server — the suite above all, whose
 * launches would otherwise land beside a developer's real sessions on `-L
 * muster` and stay there, since a tmux launch is meant to survive its parent
 * exiting (#57).
 */
export function hosts(
  env: NodeJS.ProcessEnv = process.env,
  tmuxStatus: "on" | "off" = "off",
): TerminalHost[] {
  return [
    new TmuxHost(env.MUSTER_TMUX_SERVER || undefined, tmuxStatus),
    new PtyHost(),
    new MacosTerminalHost(),
  ];
}
export async function selectHost(
  id: string,
  drivers: TerminalHost[],
): Promise<TerminalHost> {
  for (const driver of drivers)
    if ((id === "auto" || driver.id === id) && (await driver.available()))
      return driver;
  throw new Error(
    `No available terminal host for ${id}; install tmux or node-pty`,
  );
}
