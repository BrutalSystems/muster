import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS } from "./agents.js";
import type { Runtime } from "./types.js";

/**
 * Options are things MUSTER does on the caller's behalf, which is what
 * separates them from the pass-through after `--`.
 *
 * A pass-through reaches the runtime verbatim and is refused unless the agent's
 * row allow-lists it. An option is a muster concept that each agent expresses
 * in its own way, or cannot express at all — so the set is closed, and naming
 * one an agent has no answer for is an error rather than a silent no-op.
 */
export const LAUNCH_OPTIONS = ["auto-approve-path"] as const;
export type LaunchOption = (typeof LAUNCH_OPTIONS)[number];

/**
 * Refuses an option the runtime cannot honour, before anything is reserved or
 * spawned. `auto-approve-path` records that the launch directory is trusted, so
 * it needs an agent with a trust gate to record it in; OpenCode has none, and
 * accepting the flag there would promise something muster cannot deliver.
 */
export function assertOptionsSupported(
  runtime: Runtime,
  options: readonly LaunchOption[],
): void {
  for (const option of options)
    if (option === "auto-approve-path" && !AGENTS[runtime].trustWorkspace)
      throw new Error(
        `--options auto-approve-path is not supported for ${runtime}: it has no workspace-trust gate`,
      );
}

/**
 * What a directory ships that would configure a session it is trusted by.
 *
 * Trusting a folder lets its own `.claude/settings.json` configure the session,
 * hooks included, and hooks run without asking — which is the reason the trust
 * dialog exists at all. Auto-approving without looking would be answering a
 * question nobody read, so a directory carrying either of these is reported and
 * the launch refuses rather than trusting it quietly.
 *
 * A `settings.json` WITHOUT hooks is not a finding: it configures the editor,
 * not the session's ability to run commands.
 *
 * Any read failure is silence rather than a finding. This decides whether to
 * refuse a launch, and refusing because a file could not be parsed would stop
 * work for a reason that is not about risk.
 */
export async function screenWorkspace(cwd: string): Promise<string[]> {
  const findings: string[] = [];
  try {
    const raw = await readFile(join(cwd, ".claude", "settings.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "hooks" in parsed &&
      Object.keys((parsed as { hooks?: object }).hooks ?? {}).length
    )
      findings.push("hooks in .claude/settings.json");
  } catch {
    // No file, unreadable, or not JSON: nothing established either way.
  }
  try {
    if ((await stat(join(cwd, ".mcp.json"))).isFile())
      findings.push("MCP servers in .mcp.json");
  } catch {
    // Absent is the common case and not a finding.
  }
  return findings;
}
