import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config, RequesterProfile } from "./config.js";
import { claudeConfigDir } from "./identity/claude.js";
import type { TerminalApp } from "./hosts/types.js";
import { mcpName, type PreparedMcp } from "./mcp.js";
import { claudeMcpConfig } from "./claude-policy.js";
import { pluginName } from "./plugins.js";
import { AGENTS, MODEL_FLAGS } from "./agents.js";
import { LAUNCH_OPTIONS } from "./options.js";
import type { RequesterId } from "./requester.js";
import { RequesterConfigError } from "./requester-policy.js";
import { parseDuration } from "./duration.js";
export const runSchema = z
  .object({
    runtime: z.enum(["codex", "claude", "opencode"]),
    prompt: z
      .string()
      .refine((s) => s.trim().length > 0, "prompt must not be blank"),
    cwd: z
      .string()
      .min(1)
      .default(process.cwd())
      .transform((s) => resolve(s)),
    kind: z.enum(["session", "task"]).default("session"),
    host: z.enum(["auto", "tmux", "pty", "macos-terminal"]).optional(),
    open: z.boolean().optional(),
    terminal: z.enum(["auto", "terminal", "iterm2", "ghostty"]).optional(),
    permissions: z.enum(["auto", "deny", "bypass"]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
    mcp: z.array(mcpName).optional(),
    plugin: z.array(pluginName).optional(),
    model: z.string().min(1).optional(),
    idleTimeout: z.string().min(1).optional(),
    ttl: z.string().min(1).optional(),
    project: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    /** Name of a stored identity to launch under. See src/identity-store.ts. */
    identity: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    requestKey: z.string().min(1).max(200).optional(),
    level: z.enum(["read", "work", "open"]).optional(),
    /**
     * Named things muster does on the caller's behalf. Closed set, unlike the
     * pass-through after `--`: see src/options.ts.
     */
    options: z.array(z.enum(LAUNCH_OPTIONS)).default([]),
    args: z.array(z.string()).default([]),
  })
  .strict();
export type RunRequest = z.infer<typeof runSchema>;
export type LaunchPermissions = {
  permissions: "auto" | "deny" | "bypass";
  sandbox: "read-only" | "workspace-write" | "full-access";
};
/**
 * A level is a spelling of a legal `permissions` + `sandbox` pair, not a second
 * policy path — `test/level.test.ts` asserts the equivalence for all three.
 * The two legal combinations no level names, `deny` + `workspace-write` and
 * `deny` + `full-access`, stay reachable through the flags.
 */
export const LEVELS = {
  read: { permissions: "deny", sandbox: "read-only" },
  work: { permissions: "auto", sandbox: "workspace-write" },
  open: { permissions: "bypass", sandbox: "full-access" },
} as const satisfies Record<string, LaunchPermissions>;
export type Level = keyof typeof LEVELS;
/**
 * Checked against raw input before parsing, like `project` and `cwd`: once
 * defaults have been applied a caller's value is indistinguishable from one
 * Muster chose.
 */
export function assertLevelExclusive(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  const o = input as Record<string, unknown>;
  if (
    o.level !== undefined &&
    (o.permissions !== undefined || o.sandbox !== undefined)
  )
    throw new Error("use level or permissions/sandbox, not both");
}
export function resolvePermissions(
  req: RunRequest,
  config: Config,
): LaunchPermissions {
  if (req.level) {
    const pair: LaunchPermissions = { ...LEVELS[req.level] };
    if (
      (pair.permissions === "bypass" || pair.sandbox === "full-access") &&
      !config.allow_dangerous_flags
    )
      throw new Error(
        "bypass or full-access requires allow_dangerous_flags=true in config.toml",
      );
    return pair;
  }
  const permissions = req.permissions ?? config.permissions;
  const configuredSandbox = req.sandbox ?? config.sandbox;
  const sandbox =
    configuredSandbox === "danger-full-access"
      ? "full-access"
      : configuredSandbox;
  if (
    (permissions === "bypass" || sandbox === "full-access") &&
    !config.allow_dangerous_flags
  )
    throw new Error(
      "bypass or full-access requires allow_dangerous_flags=true in config.toml",
    );
  if (permissions === "auto" && sandbox !== "workspace-write")
    throw new Error(
      "--permissions auto requires --sandbox workspace-write; no sandbox is widened automatically",
    );
  if (permissions === "bypass" && sandbox !== "full-access")
    throw new Error("--permissions bypass requires --sandbox full-access");
  return { permissions, sandbox };
}
/**
 * Where a launch is allowed to run.
 *
 * Two properties do the work, and a prefix comparison has neither:
 *
 * - **Symlinks are resolved first.** A link inside an allowed root pointing
 *   anywhere else would otherwise be a way out of the root, and the path as
 *   written says nothing about where it lands.
 * - **Containment is path-relative.** `/work/project-other` is not inside
 *   `/work/project`, though it shares every character of it.
 *
 * Configured project paths are roots in their own right: naming a directory as
 * a project is the grant.
 *
 * With nothing configured this permits anything the account can reach, which is
 * the behaviour Muster has always had. That is a choice, and the README says so
 * — it is not a safe default inherited by accident.
 */
export async function assertAllowedWorkspace(
  cwd: string,
  config: Pick<Config, "allowed_roots" | "projects">,
): Promise<void> {
  const roots = [...config.allowed_roots, ...Object.values(config.projects)];
  if (!roots.length) return;
  const real = await realpath(cwd);
  for (const root of roots) {
    const resolved = await realpath(resolve(root)).catch(() => null);
    if (!resolved) continue;
    const rel = relative(resolved, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  }
  throw new Error(
    `cwd is outside every configured allowed root: ${cwd}. ` +
      `Add a root or a project to config.toml, or launch somewhere already permitted.`,
  );
}
/**
 * What a request key is bound to, so the same key arriving with different
 * parameters can be refused rather than silently answered with the wrong
 * session.
 *
 * Computed here, after validation and after defaults are resolved, rather than
 * accepted from the caller: a sender and a receiver canonicalize a path
 * differently (symlinks, /private, a different home directory), and a
 * fingerprint computed before validation would disagree with itself across
 * machines.
 *
 * Covers what changes *what gets launched*. Excludes anything cosmetic or
 * derived at launch — timestamps, the key itself, pids, ports, tmux targets —
 * because changing those should not make this a different request.
 */
export function paramsFingerprint(
  req: RunRequest,
  permissions: LaunchPermissions,
  mcp: string[],
  plugins: string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        req.runtime,
        req.kind,
        req.cwd,
        createHash("sha256").update(req.prompt).digest("hex"),
        permissions.permissions,
        permissions.sandbox,
        [...mcp].sort(),
        [...plugins].sort(),
        req.model ?? null,
        // Hashed because it selects which account's credentials the agent
        // holds. Without it, one request key reused across two identities
        // dedupes: the caller asks for account-b and is handed the launch
        // already running under account-a, reported as success. A reused key
        // with different parameters must be refused, not answered.
        req.identity ?? null,
        // A reused key whose lifecycle differs must be refused, not answered:
        // handing back a 30m session to a caller that asked for `off` gives it
        // a session that dies underneath it.
        req.idleTimeout ?? null,
        req.ttl ?? null,
        req.args,
      ]),
    )
    .digest("hex");
}
export type ResolvedModel = {
  model: string;
  /** What the run record reports: who chose this model. */
  source: "request" | "config";
  /**
   * WHERE it was named, which `source` cannot express because `--model` and a
   * model inside `args` are both a request. OpenCode needs the distinction: it
   * already forwards an `args`-named model onto the child's argv, so putting
   * that same value into the verified config overlay would deliver it twice by
   * two different routes and change a tested delivery path.
   */
  origin: "flag" | "args" | "config";
};

/**
 * The flag half of any pass-through arg, lowercased with `_` mapped to `-`.
 * Extracted from `runtimeArgs`, which already normalised this way inline, and
 * now shared with the resolver so the two cannot disagree about whether a
 * given spelling names a model: one deciding a model was named while the other
 * forwards it is exactly how a model reaches the child's argv twice.
 */
export function normaliseFlag(arg: string): string {
  return arg.split("=")[0]!.toLowerCase().replaceAll("_", "-");
}

/** A model named inside the runtime pass-through, if one is there. */
function modelInArgs(args: string[]): string | undefined {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!MODEL_FLAGS.includes(normaliseFlag(arg))) continue;
    if (arg.includes("=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      // `--model=` names a model and supplies none. Accepting it would deliver
      // nothing and record `model: null` — "the child chose" — which is the
      // accepted-and-silently-ignored behaviour this feature exists to remove.
      if (!value) throw new Error(`Missing value for ${arg}`);
      found.push(value);
      continue;
    }
    const value = args[i + 1];
    // A bare flag with no usable value is left alone: `runtimeArgs` raises
    // "Missing value for --model" on the same input and words it well.
    if (value && !value.startsWith("-")) found.push(value);
  }
  // Taking the first would let OpenCode forward both to a child whose last flag
  // wins, leaving the run record naming a model the child did not run.
  if (found.length > 1)
    throw new Error(
      `Model named twice in runtime options: ${found.join(" and ")}. Name it once.`,
    );
  return found[0];
}

/**
 * The one place a launch's model is decided. `launchArgs`, the registry write
 * and the OpenCode overlay all call this, so what is recorded on the run and
 * what is handed to the child are one computation rather than two that agree
 * by luck — which is the whole point of recording it at all.
 */
export function resolveModel(
  req: RunRequest,
  config: Config,
): ResolvedModel | null {
  const inArgs = modelInArgs(req.args);
  if (req.model !== undefined && inArgs !== undefined)
    throw new Error(
      `Model named twice: --model ${req.model} and ${inArgs} in runtime options. Name it once.`,
    );
  const named = req.model ?? inArgs;
  if (named !== undefined) {
    // OpenCode's native form IS provider/model; claude and codex take a bare
    // id, and a slash there is a mistake worth catching at this boundary
    // rather than in the child's argument parser.
    if (req.runtime !== "opencode" && named.includes("/"))
      throw new Error(
        `--model for ${req.runtime} takes a bare model id, not PROVIDER/MODEL (got ${named})`,
      );
    return {
      model: named,
      source: "request",
      origin: req.model !== undefined ? "flag" : "args",
    };
  }
  const configured =
    req.runtime === "opencode" ? config.opencode.model : undefined;
  return configured === undefined
    ? null
    : { model: configured, source: "config", origin: "config" };
}

/**
 * Per runtime: which pass-through options ride to the child, and which are
 * recognised but delivered by `resolveModel` instead. A consumed flag must not
 * be refused — naming a model in `args` is still a supported way to ask, and
 * it is the only way that worked before `--model` reached these runtimes.
 * OpenCode is deliberately absent from `consumed`: it already forwards a model
 * from `args` onto its argv and `test/opencode-policy.test.ts` pins that.
 */

export type SessionLifecycle = {
  idleTimeout: number | null;
  ttl: number | null;
};

/** 30 minutes. Long enough that a trust prompt or a coffee does not cost a
 *  session; short enough that an orphan dies within the hour. */
export const DEFAULT_IDLE_TIMEOUT = 1800;

/**
 * Flag, then config, then the built-in default; `off` disables at any level.
 *
 * Only a tmux session can honour a lifecycle: pty and macos-terminal die with
 * their parent and a task is not a session at all. An explicit request there is
 * refused, but a CONFIGURED default is silently skipped — refusing that would
 * break every pty launch the moment someone sets a default.
 *
 * `reapable` comes from the caller, not from `req.host`, because the host that
 * runs is `req.host ?? config.host` with `auto` resolving to whichever driver
 * is available. Deciding from `req.host` here would accept `--idle-timeout`
 * under `host = "pty"` in config and then never arm it.
 */
export function resolveLifecycle(
  req: RunRequest,
  config: Config,
  reapable: boolean,
): SessionLifecycle {
  const one = (
    flag: string | undefined,
    configured: string | undefined,
    label: string,
    configLabel: string,
    fallback: number | null,
  ): number | null => {
    // `off` asks for nothing, so it is accepted even where a lifecycle cannot
    // be honoured: a wrapper that always passes it defensively must still be
    // able to launch a pty session.
    if (flag !== undefined && !reapable && flag.trim().toLowerCase() !== "off")
      throw new Error(
        `${label} applies to tmux sessions, which outlive the process that ` +
          `launched them; this launch is ${req.kind === "task" ? "a task" : `hosted on ${req.host ?? "the configured host"}`}`,
      );
    // Each source names ITSELF in the error: a bad config value reported as
    // "--idle-timeout must be ..." sends the reader looking for a flag they
    // never typed.
    const chosen =
      flag !== undefined
        ? parseDuration(flag, label)
        : configured !== undefined
          ? parseDuration(configured, configLabel)
          : undefined;
    if (!reapable) return null;
    if (chosen === undefined) return fallback;
    return chosen === "off" ? null : chosen;
  };
  return {
    idleTimeout: one(
      req.idleTimeout,
      config.session.idle_timeout,
      "--idle-timeout",
      "[session] idle_timeout",
      DEFAULT_IDLE_TIMEOUT,
    ),
    ttl: one(req.ttl, config.session.ttl, "--ttl", "[session] ttl", null),
  };
}
export function runtimeArgs(req: RunRequest): string[] {
  const result: string[] = [];
  const { forwarded, consumed } = AGENTS[req.runtime].runtimeOptions;
  for (let i = 0; i < req.args.length; i++) {
    const arg = req.args[i]!,
      flag = normaliseFlag(arg);
    const keep = forwarded.includes(flag);
    if (!keep && !consumed.includes(flag))
      throw new Error(`Runtime option refused: ${arg}`);
    if (arg.includes("=")) {
      if (keep) result.push(arg);
    } else {
      // The value is stepped over for a consumed flag exactly as for a
      // forwarded one, so a missing value is still an error and the next
      // option is not mistaken for this one's value.
      const value = req.args[++i];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      if (keep) result.push(arg, value);
    }
  }
  return result;
}
/**
 * The keys of a profile's own settings.json that name its skill set rather than
 * its policy. `--setting-sources ""` is what keeps `permissions`, `sandbox` and
 * `hooks` muster's alone — forwarding those would let a settings file re-widen
 * what `assertClaudePolicy` refuses to take on trust — so only these two are
 * carried across, and muster's keys are spread after them and win regardless.
 */
const forwardedSettings = ["enabledPlugins", "extraKnownMarketplaces"] as const;
function profilePluginSettings(configDir: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
  } catch {
    // No settings file, unreadable, or not JSON: a launch with built-in skills
    // only is degraded but correct, and failing here would take the sandbox fix
    // down with it.
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const source = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of forwardedSettings)
    if (source[key] !== undefined) out[key] = source[key];
  return out;
}
/**
 * Whether the caller typed `--terminal` themselves, read from the raw argv
 * BEFORE `normalizeOpenFlag` runs. Every `--open <app>` becomes `--terminal
 * <app>`, so after normalisation the two are indistinguishable and a deprecation
 * notice would fire on the spelling Muster is steering callers towards.
 */
export function usesTerminalFlag(argv: string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some(
    (a) => a === "--terminal" || a.startsWith("--terminal="),
  );
}
/**
 * Lifts `--open <app>` and `--open=<app>` onto `--terminal <app>` before
 * `parseArgs` sees them, so `--open` can carry an optional value at all: in
 * strict mode a boolean option refuses `=value` and a string option refuses a
 * bare flag, and there is no third kind. Everything after `--` belongs to the
 * runtime and is copied through untouched.
 *
 * An unrecognised app is lifted too rather than left behind, so the schema names
 * it in the error instead of it becoming a silent runtime argument.
 */
export function normalizeOpenFlag(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.push(...argv.slice(i));
      return out;
    }
    if (arg.startsWith("--open=")) {
      out.push("--open", "--terminal", arg.slice("--open=".length));
      continue;
    }
    if (arg === "--open") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("-")) {
        out.push("--open", "--terminal", next);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}
/**
 * Which terminal `--open` uses: the launch's own choice, else config's, and
 * Terminal.app only when neither names one — it is the one terminal every macOS
 * is guaranteed to have. `auto` is a request to decide rather than a literal
 * app, so it defers to config exactly as an absent value does.
 */
export function resolveTerminal(
  req: { terminal?: TerminalApp | "auto" },
  config: Pick<Config, "terminal">,
): TerminalApp {
  if (req.terminal && req.terminal !== "auto") return req.terminal;
  return config.terminal === "auto" ? "terminal" : config.terminal;
}
export function launchArgs(
  req: RunRequest,
  config: Config,
  mcp: PreparedMcp[] = [],
  bridgePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Before `runtimeArgs`, so this function owns every model error on its own
  // rather than by its caller's discipline: `Muster.launch` happens to resolve
  // first, but `launchArgs` is exported and an input carrying both a model
  // conflict and a refused option must report the model conflict.
  const resolved = resolveModel(req, config);
  const extra = runtimeArgs(req);
  // OpenCode never reaches here — `run.ts` branches it to the OpenCode launch
  // builders, which carry the model in their config overlay.
  const model = resolved ? ["--model", resolved.model] : [];
  const policy = resolvePermissions(req, config);
  if (req.runtime === "codex")
    return [
      "codex",
      ...(req.kind === "task"
        ? ["exec", "--ignore-user-config", "--skip-git-repo-check"]
        : []),
      ...(policy.permissions === "auto"
        ? ["--approve-for-me"]
        : policy.permissions === "bypass"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : [
              "--sandbox",
              policy.sandbox === "full-access"
                ? "danger-full-access"
                : policy.sandbox,
              ...(req.kind === "session"
                ? ["--ask-for-approval", "never"]
                : ["-c", 'approval_policy="never"']),
            ]),
      ...model,
      ...extra,
      "--",
      req.prompt,
    ];
  const readonly = policy.sandbox === "read-only";
  const mode =
    policy.permissions === "auto"
      ? "auto"
      : policy.permissions === "bypass"
        ? "bypassPermissions"
        : "dontAsk";
  // The dir the launched agent will actually open: `launchEnv`'s blocklist is
  // /^(CLAUDECODE|CLAUDE_CODE_|...)/, which does not match CLAUDE_CONFIG_DIR, so
  // the child inherits whatever the caller set. Shared with the trust read and
  // the sessions dir rather than restated — a second copy here drifted from that
  // one already (it resolve()d, and read a blank value as unset), which is how a
  // write root ends up naming a directory nobody is launching in.
  const configDir = claudeConfigDir(env);
  const settings = {
    ...profilePluginSettings(configDir),
    disableAllHooks: true,
    permissions: {
      defaultMode: mode,
      allow: mcp.flatMap((s) =>
        s.config.tools.map((t) => `mcp__${s.name}__${t}`),
      ),
      deny: [
        ...(readonly ? ["Edit", "Write", "NotebookEdit"] : []),
        ...mcp.flatMap((s) =>
          s.excludedTools.map((t) => `mcp__${s.name}__${t}`),
        ),
      ],
      additionalDirectories: [],
    },
    sandbox: {
      enabled: policy.sandbox !== "full-access",
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        denyWrite: readonly ? ["/"] : [],
        // The agent's own memory lives under the config dir, outside the cwd
        // that Claude Code defaults the write root to, so Bash writes to it
        // failed with EPERM while the in-process file tools succeeded (#80).
        // Granted only under workspace-write: read-only must stay read-only,
        // and full-access has no sandbox to grant into.
        // Absolute only here: the sandbox is an OS boundary evaluated against a
        // path, and a relative CLAUDE_CONFIG_DIR would grant whatever the
        // launching process's cwd happened to be. The shared resolver stays
        // as-written so the trust read and the sessions dir keep their
        // behaviour.
        ...(policy.sandbox === "workspace-write"
          ? { allowWrite: [resolve(configDir)] }
          : {}),
      },
    },
  };
  return [
    "claude",
    ...(req.kind === "task" ? ["-p"] : []),
    "--tools",
    "default",
    "--permission-mode",
    mode,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(claudeMcpConfig(mcp, bridgePath)),
    "--settings",
    JSON.stringify(settings),
    ...model,
    ...extra,
    "--",
    req.prompt,
  ];
}
export function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked =
    /^(CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD_ID$|TMUX$|TMUX_PANE$|MCP_)/;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) => typeof v === "string" && !blocked.test(k),
    ),
  ) as Record<string, string>;
}
/**
 * What a composed environment must contain to launch at all. `LANG` is here
 * deliberately: an empty or absent `LANG` has broken every tmux launch on the
 * remote hosts before, and a composed environment is exactly where it goes
 * missing.
 */
export const BASELINE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
] as const;
/**
 * The base environment handed to the launched agent — distinct from the
 * environment Muster's own subprocesses run in, which stays denylist-filtered
 * from the parent because it is Muster's own machinery on its own machine and
 * never reaches an agent.
 *
 * Local requesters keep the denylist: the user's own machine, the user's own
 * credentials, long-standing documented behaviour. Remote requesters get an
 * allowlist composed from nothing, because the alternative hands an agent
 * whatever happened to be in the environment of the process that accepted the
 * request — a set nobody chose.
 */
export function agentBaseEnv(
  requester: RequesterId,
  profile: RequesterProfile | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  if (requester.kind === "local") return launchEnv(sourceEnv);
  if (!profile)
    throw new RequesterConfigError(
      "a remote requester reached environment composition without a profile",
    );
  const env: Record<string, string> = {};
  // Allow-listed variables come from the accepting environment.
  for (const key of profile.env_allow) {
    const value = sourceEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  // The baseline a launch cannot run without, from the profile where it sets one.
  for (const key of BASELINE_ENV) {
    const value = profile.env_defaults[key] ?? sourceEnv[key];
    if (typeof value === "string" && value.length) env[key] = value;
  }
  // `env_defaults` wins over everything above, and is delivered even for a key
  // that is neither baseline nor allow-listed. A profile that sets a value meant
  // the value it chose; dropping it would leave the profile reading as though it
  // supplies something it never delivers, and pinning `PATH` while handing over
  // the accepting shell's raw one is precisely the mismatch this feature exists
  // to remove.
  for (const [key, value] of Object.entries(profile.env_defaults))
    if (typeof value === "string" && value.length) env[key] = value;
  for (const required of ["PATH", "LANG"])
    if (!env[required])
      throw new RequesterConfigError(
        `composed environment for this requester has no ${required}; set it under the profile's [env_defaults] table`,
      );
  return env;
}
