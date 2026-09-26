import type { LaunchPermissions } from "./guard.js";
import type { Runtime } from "./types.js";
import { AGENTS } from "./agents.js";
/**
 * How strongly a launch's containment is actually imposed.
 *
 * The runtimes differ, and the difference is in them rather than in Muster:
 * Codex and Claude Code each have an OS-level sandbox Muster configures, while
 * OpenCode's permissions are tool policy — rules the agent is asked to respect,
 * with no kernel enforcement (README.md: "OpenCode permissions are tool policy,
 * not an OS-level filesystem sandbox").
 *
 * Derived here from the runtime and the resolved sandbox, never supplied by a
 * caller. It keys on the sandbox rather than on a level's name because
 * `full-access` disables the sandbox whatever the permissions say.
 */
export type Enforcement = "kernel" | "tool-policy" | "none";
export function enforcementGrade(
  runtime: Runtime,
  resolved: LaunchPermissions,
): Enforcement {
  if (resolved.sandbox === "full-access") return "none";
  return AGENTS[runtime].enforcement;
}
