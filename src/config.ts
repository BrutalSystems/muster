import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";
import { mcpName, mcpServerSchema } from "./mcp.js";
import { pluginName, pluginSchema } from "./plugins.js";
import { openCodeSectionSchema } from "./providers.js";
import { identityNameSchema } from "./identity-store.js";
import { authoritySchema, subjectSchema } from "./requester.js";
import { RequesterConfigError } from "./requester-policy.js";
/**
 * What a remote requester is permitted here. Every default is the narrowest
 * value, so the shortest profile is the most restrictive one.
 *
 * `allowed_roots` is the one key with no safe default: the global
 * `allowed_roots` defaults to empty, which `assertAllowedWorkspace` reads as
 * permitting anything the account can reach, so inheriting it would hand an
 * unconfigured profile the whole filesystem.
 *
 * `level` excludes `open` deliberately — no remote request may disable the
 * sandbox, and a config naming it should fail loudly rather than be checked for
 * at launch.
 *
 * `min_enforcement` is the one key whose default excludes a runtime rather than
 * narrowing a permission: `kernel` admits Codex and Claude Code, and
 * `tool-policy` is what admits OpenCode.
 */
export const requesterProfileSchema = z
  .object({
    allowed_roots: z.array(z.string().min(1)).min(1),
    level: z.enum(["read", "work"]).default("read"),
    min_enforcement: z.enum(["kernel", "tool-policy"]).default("kernel"),
    env_allow: z.array(z.string().min(1)).default([]),
    /**
     * Baseline overrides, e.g. a PATH that does not depend on the accepting
     * shell. It wins over the source environment for every key it sets,
     * `env_allow` entries included: a profile that pins a value and also allows
     * the key meant the value it pinned.
     */
    env_defaults: z.record(z.string().min(1), z.string()).default({}),
    /** Which identities this requester may launch under. Empty refuses any. */
    identities: z.array(identityNameSchema).default([]),
  })
  .strict();
export type RequesterProfile = z.infer<typeof requesterProfileSchema>;
/** Binding an authenticated `(authority, subject)` to a profile. The grant. */
export const requesterEnrolmentSchema = z
  .object({
    authority: authoritySchema,
    subject: subjectSchema,
    label: z.string().min(1).max(200).optional(),
    profile: z.string().min(1),
  })
  .strict();
export type RequesterEnrolment = z.infer<typeof requesterEnrolmentSchema>;
/** Raw strings, not parsed durations: a bad value in config.toml must fail with
 *  the same message a bad flag does, and that parser lives in one place. */
const sessionSectionSchema = z
  .object({
    idle_timeout: z.string().min(1).optional(),
    ttl: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export const configSchema = z
  .object({
    host: z.enum(["auto", "tmux", "pty", "macos-terminal"]).default("auto"),
    /**
     * Off by default. Muster's tmux runs on its own server with `-f /dev/null`,
     * so this bar is never the developer's configured one, and a Muster session
     * is one window running one agent.
     */
    tmux_status: z.enum(["on", "off"]).default("off"),
    /**
     * Which terminal `--open` uses when the launch does not name one. Was
     * hardcoded to Terminal.app, so a developer on Ghostty or iTerm2 had to pass
     * `--terminal` on every launch with no way to state it once.
     */
    terminal: z
      .enum(["auto", "terminal", "iterm2", "ghostty"])
      .default("terminal"),
    launch_timeout_sec: z.number().finite().positive().max(600).default(30),
    max_concurrent: z.number().int().positive().max(1000).default(4),
    allowed_roots: z.array(z.string().min(1)).default([]),
    projects: z
      .record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string().min(1))
      .default({}),
    permissions: z.enum(["auto", "deny", "bypass"]).default("deny"),
    sandbox: z
      .enum([
        "read-only",
        "workspace-write",
        "full-access",
        "danger-full-access",
      ])
      .default("read-only"),
    default_mcp: z.array(mcpName).default([]),
    mcp_servers: z.record(mcpName, mcpServerSchema).default({}),
    default_plugins: z.array(pluginName).default([]),
    plugins: z.record(pluginName, pluginSchema).default({}),
    opencode: openCodeSectionSchema,
    session: sessionSectionSchema,
    allow_dangerous_flags: z.boolean().default(false),
    requester_profiles: z
      .record(z.string().regex(/^[a-zA-Z0-9_-]+$/), requesterProfileSchema)
      .default({}),
    requesters: z.array(requesterEnrolmentSchema).default([]),
  })
  // Deliberately NOT strict, unlike the nested schemas above. A config written
  // for a newer Muster must not brick an older one: when `terminal` arrived in
  // 0.11.0 a strict top level made EVERY command on 0.10.0 fail with
  // `unrecognized_keys` — not a warning, a dead CLI, `list` and `stop`
  // included. Unknown keys here are reported by `unknownConfigKeys` and
  // dropped.
  //
  // Values are still validated, which is the half that matters for safety: a
  // silently ignored `sandbox = "workspce-write"` would launch under the
  // default rather than the pair the operator wrote. The nested policy tables
  // stay strict for the same reason — an unknown key inside a requester
  // profile is a policy statement that would not apply.
  .strip();
export type Config = z.infer<typeof configSchema>;
const knownConfigKeys = new Set(Object.keys(configSchema.shape));
/**
 * Top-level keys this build does not know, sorted. Reported rather than
 * refused, so a newer config degrades to "this Muster ignores that" instead of
 * refusing to run at all.
 */
export function unknownConfigKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>)
    .filter((k) => !knownConfigKeys.has(k))
    .sort();
}
export const musterHome = () => join(homedir(), ".muster");
export async function loadConfig(home = musterHome()): Promise<Config> {
  let value: unknown = {};
  try {
    value = TOML.parse(await readFile(join(home, "config.toml"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const ignored = unknownConfigKeys(value);
  if (ignored.length)
    process.stderr.write(
      `[muster] ignoring unknown config key${ignored.length > 1 ? "s" : ""}: ` +
        `${ignored.join(", ")} — written for a different version of muster?\n`,
    );
  const result = configSchema.parse(value);
  const seen = new Set<string>();
  for (const e of result.requesters) {
    // The spec lists both of these under RequesterConfigError, and the error
    // model exists so a transport maps to stable codes without matching on
    // message text. A plain Error is indistinguishable from a parse failure.
    if (!result.requester_profiles[e.profile])
      throw new RequesterConfigError(
        `Requester ${e.authority}/${e.subject} names unknown profile ${e.profile}. Configured: ${
          Object.keys(result.requester_profiles).join(", ") || "none"
        }`,
      );
    const key = [e.authority, e.subject].join("\0");
    if (seen.has(key))
      throw new RequesterConfigError(
        `Duplicate requester enrolment for ${e.authority}/${e.subject}`,
      );
    seen.add(key);
  }
  if (
    (["danger-full-access", "full-access"].includes(result.sandbox) ||
      result.permissions === "bypass") &&
    !result.allow_dangerous_flags
  )
    throw new Error(
      "full-access or bypass requires allow_dangerous_flags in config.toml",
    );
  return result;
}
