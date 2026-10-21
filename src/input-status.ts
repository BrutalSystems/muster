import type { Runtime } from "./types.js";
export type InputStatus = {
  state: "waiting" | "unknown";
  reason:
    | "trust"
    | "bypass-warning"
    | "permission"
    | "mcp-approval"
    | "held-message"
    | "plan-approval"
    | "password"
    | "host-key"
    | "login"
    | "question"
    | "unknown";
  source:
    | "codex-status"
    | "opencode-permission"
    | "opencode-question"
    | "tmux-screen"
    | "none";
  observed_at: string;
};
export function unknownInputStatus(): InputStatus {
  return {
    state: "unknown",
    reason: "unknown",
    source: "none",
    observed_at: new Date().toISOString(),
  };
}
/** Only classify a bounded tail of the visible pane, never scrollback or transcripts.
 * Screen matches are heuristics, not authority; only enums leave this function. */
export function classifyScreen(runtime: Runtime, text: string): InputStatus {
  const tail = text
    .slice(-8192)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  while (tail.length && !tail[tail.length - 1]!.trim()) tail.pop();
  const lines = tail.slice(-16);
  const screen = lines.join("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (/^[❯›]\s*$/.test(last)) return unknownInputStatus();
  const choice =
    /(?:^|\n)\s*[❯›>]?(?:\s*\d+[.)])?\s*(?:Yes[, ]|Yes$|No[, ]|No$|Allow once|Allow always|Trust and continue|Cancel)/m.test(
      screen,
    );
  let reason: InputStatus["reason"] | undefined;
  // Held-message bodies can push the heading above the usual 16-line tail.
  // Read only the already-bounded visible pane for the heading, and require
  // both choices plus a selected menu row near the bottom, never prose alone.
  if (
    runtime === "claude" &&
    /^\s*Held message from another\s+session\s*$/m.test(tail.join("\n")) &&
    /^\s*[❯›>]?(?:\s*\d+[.)])?\s*Deny\s*[—–-]\s*drop it and tell the sender it was declined\s*$/m.test(
      screen,
    ) &&
    /^\s*[❯›>]?(?:\s*\d+[.)])?\s*Deliver this message to\s+Claude\s*$/m.test(
      screen,
    ) &&
    /^\s*[❯›>]\s*(?:\d+[.)]\s*)?(?:Deny\s*[—–-]|Deliver this message to)/m.test(
      screen,
    ) &&
    /(?:^|\n)\s*[❯›>]?(?:\s*\d+[.)])?\s*Deliver this message to\s+Claude[ \t]*(?:\n[ \t]*Enter to confirm[ \t]*[·•][ \t]*Esc to cancel)?\s*$/.test(
      screen,
    )
  )
    return {
      state: "waiting",
      reason: "held-message",
      source: "tmux-screen",
      observed_at: new Date().toISOString(),
    };
  if (
    /^(?:\[sudo\]\s*)?(?:password(?: for [^:\n]{1,128})?|passphrase(?: for [^:\n]{1,128})?|Enter passphrase[^:\n]{0,160}):\s*$/i.test(
      last,
    )
  )
    reason = "password";
  else if (
    /^Are you sure you want to continue connecting[^\n]{0,160}\?\s*$/.test(last)
  )
    reason = "host-key";
  else if (choice) {
    if (
      (runtime === "claude" && /Yes, I trust this folder/.test(screen)) ||
      (runtime === "codex" &&
        /Trust this folder\?|Trust and continue/.test(screen))
    )
      reason = "trust";
    else if (
      runtime === "claude" &&
      /Bypass Permissions mode|Yes, I accept/.test(screen)
    )
      reason = "bypass-warning";
    else if (
      /New MCP server|MCP servers? found in this|Use this and all future MCP/.test(
        screen,
      )
    )
      reason = "mcp-approval";
    else if (/Would you like to proceed\?|Ready to code\?/.test(screen))
      reason = "plan-approval";
    else if (
      /Do you want to (proceed|make this edit|create|allow)|Would you like to run the following command|Allow command\?|Approve this|Yes, and don.t ask again/.test(
        screen,
      )
    )
      reason = "permission";
  }
  if (
    !reason &&
    /^(?:[❯›>]\s*)?(?:Select login method|Please run \/login)\s*$/m.test(screen)
  )
    reason = "login";
  return reason
    ? {
        state: "waiting",
        reason,
        source: "tmux-screen",
        observed_at: new Date().toISOString(),
      }
    : unknownInputStatus();
}
/** Codex app-server ThreadStatus.activeFlags (protocol 0.163.0). */
export function codexInputStatus(status: unknown): InputStatus | undefined {
  if (!status || typeof status !== "object") return;
  const value = status as { type?: unknown; activeFlags?: unknown };
  if (value.type !== "active" || !Array.isArray(value.activeFlags)) return;
  const reason = value.activeFlags.includes("waitingOnApproval")
    ? "permission"
    : value.activeFlags.includes("waitingOnUserInput")
      ? "question"
      : undefined;
  return reason
    ? {
        state: "waiting",
        reason,
        source: "codex-status",
        observed_at: new Date().toISOString(),
      }
    : undefined;
}
