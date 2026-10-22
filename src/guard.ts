import { mcpSelection } from "./mcp-selection.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import TOML from "@iarna/toml";
import type { Config, RequesterProfile } from "./config.js";
import { claudeConfigDir, claudeSessionsDir } from "./identity/claude.js";
import { builtinTerminals } from "./hosts/types.js";
import type { TerminalApp } from "./hosts/types.js";
import { mcpName, type PreparedMcp } from "./mcp.js";
import { claudeMcpConfig } from "./claude-policy.js";
import { pluginName } from "./plugins.js";
import { AGENTS, FORK_FLAG, MODEL_FLAGS, RESUME_FLAGS } from "./agents.js";
import { launchOptionsSchema, assertOptionsSupported } from "./options.js";
import { launchAnnotations } from "./annotations.js";
import type { RequesterId } from "./requester.js";
import { RequesterConfigError } from "./requester-policy.js";
import { parseDuration } from "./duration.js";
import { assertModelDeclared } from "./providers.js";
import { runtimeCommand } from "./executable.js";
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
    terminal: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    permissions: z.enum(["auto", "deny", "bypass"]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
    mcp: z.array(mcpName).optional(),
    plugin: z.array(pluginName).optional(),
    model: z.string().min(1).optional(),
    /** A Claude session id to reopen instead of starting a new one. See `resolveResume`. */
    resume: z.string().min(1).optional(),
    /** With `resume`: continue it under a new session id, leaving the original untouched. */
    forkSession: z.boolean().optional(),
    idleTimeout: z.string().min(1).optional(),
    ttl: z.string().min(1).optional(),
    /** The terminal title of a tmux session. See `resolveTitle`. */
    title: z.string().optional(),
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
    level: z.enum(["read", "work", "normal", "open"]).optional(),
    /**
     * Named behaviors and structured launch annotations. Closed set, unlike the
     * pass-through after `--`: see src/options.ts.
     */
    options: launchOptionsSchema.default([]),
    /**
     * An absolute path to run instead of the runtime found on PATH. See
     * src/executable.ts.
     */
    executable: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
  })
  .strict();
export type RunRequest = z.infer<typeof runSchema>;
/**
 * `normal` on both sides is the one pair muster does not author: the agent is
 * started exactly as a person would start it in that profile and directory,
 * and its own settings decide permissions and sandbox. It is never mixed with
 * a muster-authored half — `normal` + `read-only` would promise a fence that
 * the profile's hooks and allow lists can widen.
 */
export type LaunchPermissions = {
  permissions: "auto" | "deny" | "bypass" | "normal";
  sandbox: "read-only" | "workspace-write" | "full-access" | "normal";
};
/**
 * A level is a spelling of a legal `permissions` + `sandbox` pair, not a second
 * policy path — `test/level.test.ts` asserts the equivalence for every level.
 * The two legal combinations no level names, `deny` + `workspace-write` and
 * `deny` + `full-access`, stay reachable through the flags.
 *
 * The CLI spells them `--read-only`, `--write-here` and `--unrestricted`;
 * `normal` has no flag because it is what a Claude launch naming none gets.
 */
export const LEVELS = {
  read: { permissions: "deny", sandbox: "read-only" },
  work: { permissions: "auto", sandbox: "workspace-write" },
  normal: { permissions: "normal", sandbox: "normal" },
  open: { permissions: "bypass", sandbox: "full-access" },
} as const satisfies Record<string, LaunchPermissions>;
/** The CLI's flag for each level, for messages that tell a caller what to type. */
export const LEVEL_FLAGS = {
  read: "--read-only",
  work: "--write-here",
  open: "--unrestricted",
} as const;
/** Only Claude has a launch muster can leave entirely to the profile so far. */
function assertNormalSupported(runtime: RunRequest["runtime"]): void {
  if (runtime !== "claude")
    throw new Error(
      `a normal launch (the agent's own settings, as if opened by hand) is ` +
        `supported for claude only; for ${runtime} pass --read-only, ` +
        `--write-here or --unrestricted`,
    );
}
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
    if (req.level === "normal") assertNormalSupported(req.runtime);
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
  // Nothing named anywhere: a Claude launch opens as a person would open it.
  // The other runtimes keep the sealed read-only default until they have a
  // normal launch of their own. A config that names either key is an
  // operator's explicit default and is honoured as before.
  if (
    req.permissions === undefined &&
    req.sandbox === undefined &&
    config.permissions === undefined &&
    config.sandbox === undefined &&
    req.runtime === "claude"
  )
    return { ...LEVELS.normal };
  const permissions = req.permissions ?? config.permissions ?? "deny";
  const configuredSandbox = req.sandbox ?? config.sandbox ?? "read-only";
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
 * Where muster keeps its own state when a caller does not say: the same
 * default `Muster.create` uses, so `launchArgs` called on its own protects the
 * home a real launch would.
 */
export function defaultMusterHome(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), ".muster");
}
/**
 * True when a launch at this pair can write under its cwd: every
 * workspace-write launch. Read-only writes nothing, and full-access (`open`)
 * is unrestricted by definition and gated by `allow_dangerous_flags` instead.
 */
function writesWorkspace(policy: LaunchPermissions): boolean {
  return policy.sandbox === "workspace-write";
}
/**
 * Refuses a launch that would hand a runtime write access to muster's own home
 * when that runtime cannot be told to leave the home alone (#44).
 *
 * The home holds the machine's policy: `allow_dangerous_flags`, the requester
 * grants, and the MCP server commands muster runs for every later launch. An
 * agent that can write it can widen the policy that constrains it.
 *
 * Claude and Codex take a path deny in what muster generates for them, so they
 * are protected there and never refused here. OpenCode's permissions are tool
 * policy: an `edit` rule can name a path, but a shell command cannot be
 * confined to one, and `bash` is what `work` grants it. So for OpenCode the
 * one guarantee is a cwd that does not contain the home — the home is then an
 * external directory, which `work` already denies. "Overlaps" means the cwd is
 * the home, inside it, or an ancestor of it (such as `~`), compared as real
 * paths so a symlink on either side cannot hide it.
 */
export function assertMusterHomeProtectable(
  runtime: RunRequest["runtime"],
  cwd: string,
  policy: LaunchPermissions,
  home: string,
): void {
  if (runtime !== "opencode" || !writesWorkspace(policy)) return;
  // `deny` with workspace-write already denies OpenCode's edit and shell
  // tools, so it can write nothing anywhere.
  if (policy.permissions === "deny") return;
  // Both spellings of each side. Real paths alone miss a home reached through
  // a symlink: `~/.muster` linking elsewhere is not inside `~` once resolved,
  // yet writing through `~/.muster` lands in it.
  const cwds = writeRootSpellings(resolve(cwd));
  const homes = writeRootSpellings(resolve(home));
  if (cwds.some((c) => homes.some((h) => contains(h, c) || contains(c, h))))
    throw new Error(
      `refusing an opencode ${policy.sandbox} launch in ${cwd}: it contains or ` +
        `is inside muster's own home (${home}), which holds the config every ` +
        `later launch obeys. OpenCode's permissions are tool policy and cannot ` +
        `keep its shell out of one folder, so launch it in a folder that does ` +
        `not contain muster's home, or with --read-only.`,
    );
}
/** Whether `inner` is `outer` or below it, by path segments, not characters. */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/**
 * The Codex arguments that make muster's home read-only inside a writable
 * workspace. A permissions profile is the only Codex config that can carve a
 * read-only path out of a writable root, and a `--sandbox` flag overrides a
 * profile, so a workspace-write launch selects this profile instead of passing
 * `--sandbox workspace-write`. `:workspace` is the built-in profile that flag
 * names, so everything else about the sandbox is the same.
 */
function codexWorkspaceProfile(home: string): string[] {
  const filesystem = Object.fromEntries(
    writeRootSpellings(home).map((p) => [p, "read"]),
  );
  return [
    "-c",
    'default_permissions="muster_work"',
    "-c",
    'permissions.muster_work.extends=":workspace"',
    "-c",
    `permissions.muster_work.filesystem=${TOML.stringify.value(filesystem)}`,
  ];
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
  guardDigest?: string,
): string {
  const annotations = launchAnnotations(req.options);
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
        // Do not append anything for old-style requests: their persisted
        // fingerprints must remain usable after upgrading.
        ...(Object.keys(annotations).length ? [annotations] : []),
        ...(mcpSelection(req) ? [{ mcp_selection: mcpSelection(req) }] : []),
        ...(guardDigest ? [{ guards: guardDigest }] : []),
        ...(req.options.includes("inherit-profile")
          ? [{ inherit_profile: true }]
          : []),
        ...(req.executable ? [{ executable: req.executable }] : []),
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
  const resolved = nameModel(req, config);
  // Every route to a model — --model, args, [opencode] model — passes here,
  // and this runs before anything is reserved, so an undeclared one leaves no
  // record behind.
  if (resolved !== null && req.runtime === "opencode")
    assertModelDeclared(resolved.model, config);
  return resolved;
}

function nameModel(req: RunRequest, config: Config): ResolvedModel | null {
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

/** What Claude prints as a session id, and the only thing `--resume` is given:
 *  a bare `--resume` or a search term opens Claude's picker, which no muster
 *  launch can answer. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ResolvedResume = { id: string; fork: boolean };
/**
 * The session a launch reopens, from `--resume`/`--fork-session` or the same
 * flags after `--` — consumed like a model, so the child's argv carries them
 * once, from here. Claude only: Codex and OpenCode resume through different
 * commands, which muster does not drive.
 */
export function resolveResume(req: RunRequest): ResolvedResume | null {
  const named: string[] = [];
  let fork = req.forkSession === true;
  for (let i = 0; i < req.args.length; i++) {
    const arg = req.args[i]!,
      flag = normaliseFlag(arg);
    if (flag === FORK_FLAG && !arg.includes("=")) fork = true;
    if (!RESUME_FLAGS.includes(flag)) continue;
    // Case-sensitive like the rest of the pass-through: `-R` is not `-r`.
    if (!arg.startsWith("--") && arg.split("=")[0] !== flag) continue;
    const value = arg.includes("=")
      ? arg.slice(arg.indexOf("=") + 1)
      : req.args[i + 1];
    if (!value || value.startsWith("-"))
      throw new Error(`Missing value for ${arg}`);
    named.push(value);
  }
  if (req.resume !== undefined) named.unshift(req.resume);
  if (named.length > 1)
    throw new Error(
      `Session to resume named twice: ${named.join(" and ")}. Name it once.`,
    );
  const id = named[0];
  if (id === undefined) {
    if (fork) throw new Error("--fork-session applies only with --resume");
    return null;
  }
  if (req.runtime !== "claude")
    throw new Error(
      `--resume is supported for claude only, not ${req.runtime}`,
    );
  if (!SESSION_ID.test(id))
    throw new Error(
      `--resume takes a Claude session id (a UUID), not ${JSON.stringify(id)}`,
    );
  return { id: id.toLowerCase(), fork };
}
/**
 * Refuses a resume Claude would fail on, or one that would put two processes
 * on one conversation. Checked before anything is reserved or spawned.
 *
 * - The transcript must exist in the config dir the launch opens. Claude
 *   reports a missing one only inside its terminal, where a muster launch
 *   would wait out its whole identity deadline before saying so.
 * - The session must not be running. Two Claude processes appending to one
 *   transcript interleave it, and both would register the same session id, so
 *   tincan and the ledger could not say which one a message reaches. A fork
 *   only reads the original, so it may resume a live one.
 */
export function assertResumable(
  resume: ResolvedResume,
  env: NodeJS.ProcessEnv,
  cwd: string,
  alive: (pid: number) => boolean = pidAlive,
): void {
  const configDir = claudeConfigDir(env);
  const projects = join(configDir, "projects");
  let transcript: string | undefined;
  try {
    transcript = readdirSync(projects)
      .map((dir) => join(projects, dir, resume.id + ".jsonl"))
      .find((file) => existsSync(file));
  } catch {}
  if (!transcript)
    throw new Error(
      `No Claude conversation ${resume.id} in ${configDir}; --resume reopens a session recorded in the profile this launch runs in`,
    );
  // Claude 2.1.302 resumes a conversation from any directory, so this is
  // muster's to refuse (#10): the history would describe one tree while the
  // agent works in another. Unknown when the transcript names no cwd.
  const recorded = transcriptCwd(transcript);
  if (recorded !== undefined && realPath(recorded) !== realPath(cwd))
    throw new Error(
      `Claude session ${resume.id} was recorded in ${recorded}, not ${cwd}; resume it with --cwd ${recorded}`,
    );
  if (resume.fork) return;
  const sessions = claudeSessionsDir(env);
  let files: string[] = [];
  try {
    files = readdirSync(sessions).filter((f) => /^\d+\.json$/.test(f));
  } catch {}
  for (const file of files) {
    let rec: { pid?: unknown; sessionId?: unknown };
    try {
      rec = JSON.parse(readFileSync(join(sessions, file), "utf8"));
    } catch {
      continue;
    }
    const pid = Number(file.slice(0, -5));
    if (
      typeof rec.sessionId === "string" &&
      rec.sessionId.toLowerCase() === resume.id &&
      alive(pid)
    )
      throw new Error(
        `Claude session ${resume.id} is running (pid ${pid}); stop it before resuming it, or pass --fork-session to continue it under a new id`,
      );
  }
}
/** The first `cwd` a transcript records, read from its head: a transcript can
 *  run to many megabytes, and the cwd is on its first message. */
function transcriptCwd(file: string): string | undefined {
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(1 << 20);
      head = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const { cwd } = JSON.parse(line) as { cwd?: unknown };
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {}
  }
  return undefined;
}
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to someone else, which is still running.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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

/**
 * Flag, then config; `off` disables at any level. Defaults to off.
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
      null,
    ),
    ttl: one(req.ttl, config.session.ttl, "--ttl", "[session] ttl", null),
  };
}
/** Longer than any tab shows, short enough that a pasted prompt is not a title. */
const TITLE_MAX = 100;
/**
 * A title reaches the outer terminal inside an OSC escape that tmux writes, so a
 * control character in it is not cosmetic: ESC or BEL ends that sequence and
 * whatever follows is read by the terminal as a command of its own. C0, DEL and
 * C1 all go, and what is left must still say something.
 */
export function sanitiseTitle(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
  if (!text) throw new Error("--title must contain printable text");
  return text;
}
/**
 * The launch's explicit title, or undefined when the launch should be titled by
 * default once its name is known. Refused where nothing will carry it, on the
 * same terms as `resolveLifecycle`: only a tmux session has a window muster
 * owns, and `titleable` comes from the selected driver, not from `req.host`.
 */
export function resolveTitle(
  req: RunRequest,
  titleable: boolean,
): string | undefined {
  if (req.title === undefined) return undefined;
  if (!titleable)
    throw new Error(
      `--title applies to tmux sessions; this launch is ${req.kind === "task" ? "a task" : `hosted on ${req.host ?? "the configured host"}`}`,
    );
  return sanitiseTitle(req.title);
}
/**
 * `--sandbox` and `-c` are passed to Codex, so they must not be a way round the
 * policy Muster sets: no full-access sandbox, and no config override of the
 * sandbox or the approval policy.
 */
function refuseWidening(flag: string, value: string): void {
  if (flag === "--sandbox" && /full-access/i.test(value))
    throw new Error(`Runtime option refused: --sandbox ${value}`);
  if (flag === "-c" && /^\s*(sandbox|approval_policy)/i.test(value))
    throw new Error(`Runtime option refused: -c ${value}`);
}
export function runtimeArgs(req: RunRequest): string[] {
  const result: string[] = [];
  const { forwarded, consumed } = AGENTS[req.runtime].runtimeOptions;
  for (let i = 0; i < req.args.length; i++) {
    const arg = req.args[i]!,
      flag = normaliseFlag(arg);
    // A single-dash flag is case-sensitive: codex's `-C` (working directory)
    // must not pass as `-c` (config override) just because `flag` is lowercased.
    const caseChanged = !arg.startsWith("--") && arg.split("=")[0] !== flag;
    const keep = !caseChanged && forwarded.includes(flag);
    if (caseChanged || (!keep && !consumed.includes(flag)))
      throw new Error(`Runtime option refused: ${arg}`);
    // The one consumed switch: it takes no value, so there is none to step over.
    if (flag === FORK_FLAG) {
      if (arg.includes("=")) throw new Error(`${FORK_FLAG} takes no value`);
      continue;
    }
    if (arg.includes("=")) {
      if (keep) {
        refuseWidening(flag, arg.slice(arg.indexOf("=") + 1));
        result.push(arg);
      }
    } else {
      // The value is stepped over for a consumed flag exactly as for a
      // forwarded one, so a missing value is still an error and the next
      // option is not mistaken for this one's value.
      const value = req.args[++i];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      if (keep) {
        refuseWidening(flag, value);
        result.push(arg, value);
      }
    }
  }
  return result;
}
/**
 * The keys of a profile's own settings.json that name its skill set or its
 * layout rather than its policy. `--setting-sources ""` is what keeps
 * `permissions`, `sandbox` and `hooks` muster's alone — forwarding those would
 * let a settings file re-widen what `assertClaudePolicy` refuses to take on
 * trust — so only these are carried across, and muster's keys are spread after
 * them and win regardless. `tui` is how a watched session is drawn (#58).
 * `statusLine` is deliberately absent: Claude Code runs no status line while
 * `disableAllHooks` is true, so it would be inert until that changes.
 */
const forwardedSettings = [
  "enabledPlugins",
  "extraKnownMarketplaces",
  "tui",
] as const;
function profileForwardedSettings(configDir: string): Record<string, unknown> {
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
  config: Pick<Config, "terminal" | "open">,
): TerminalApp {
  const name =
    req.terminal && req.terminal !== "auto"
      ? req.terminal
      : config.terminal === "auto"
        ? "terminal"
        : config.terminal;
  if (
    !(builtinTerminals as readonly string[]).includes(name) &&
    !config.open.apps[name]
  )
    throw new Error(
      `Unknown terminal "${name}": use ${builtinTerminals.join(", ")}, or define it under [open.apps.${name}] in config.toml`,
    );
  return name;
}
/**
 * Each `--plugin-dir` value names a directory, found from the launch's cwd as
 * the child will find it: the path as given, `..` walked by the system. A typo, a file or an empty value is refused here,
 * before anything is reserved or spawned, rather than left for Claude to skip.
 */
function assertPluginDirs(extra: string[], cwd: string): void {
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i]!;
    if (normaliseFlag(arg) !== "--plugin-dir") continue;
    const value = arg.includes("=")
      ? arg.slice(arg.indexOf("=") + 1)
      : (extra[++i] ?? "");
    let dir = false;
    try {
      // Joined, never normalised: `resolve` would drop `a/..` lexically, where the
      // system walks it, through a file, a missing dir or a link's real parent.
      const path = isAbsolute(value) ? value : `${cwd}/${value}`;
      dir = value !== "" && statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir)
      throw new Error(
        `Runtime option refused: --plugin-dir ${value === "" ? "needs a directory" : `${value} is not a directory`}`,
      );
  }
}

export function launchArgs(
  req: RunRequest,
  config: Config,
  mcp: PreparedMcp[] = [],
  bridgePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  /** Muster's own home, write-protected at workspace-write (#44). */
  musterHome: string = defaultMusterHome(env),
): string[] {
  // Before `runtimeArgs`, so this function owns every model error on its own
  // rather than by its caller's discipline: `Muster.launch` happens to resolve
  // first, but `launchArgs` is exported and an input carrying both a model
  // conflict and a refused option must report the model conflict.
  const resolved = resolveModel(req, config);
  const resume = resolveResume(req);
  const extra = [
    ...runtimeArgs(req),
    ...(resume
      ? ["--resume", resume.id, ...(resume.fork ? [FORK_FLAG] : [])]
      : []),
  ];
  // OpenCode never reaches here — `run.ts` branches it to the OpenCode launch
  // builders, which carry the model in their config overlay.
  const model = resolved ? ["--model", resolved.model] : [];
  const policy = resolvePermissions(req, config);
  assertOptionsSupported(req.runtime, req.options, policy);
  mcpSelection(req);
  const inheritProfile = req.options.includes("inherit-profile");
  // A plugin folder brings its own skills, agents, hooks and MCP servers. A
  // sealed launch chose exactly what it loads, so it takes none of them.
  if (
    policy.permissions !== "normal" &&
    !inheritProfile &&
    extra.some((arg) => normaliseFlag(arg) === "--plugin-dir")
  )
    throw new Error(
      "Runtime option refused: --plugin-dir (a sealed launch loads no plugins)",
    );
  assertPluginDirs(extra, req.cwd);
  if (
    policy.permissions === "normal" ||
    (req.runtime === "claude" && inheritProfile)
  ) {
    // `resolvePermissions` refuses this outside claude; restated so the codex
    // branch below can never read `normal` as one of its own modes.
    assertNormalSupported(req.runtime);
    return normalClaudeArgs(req, mcp, bridgePath, env, model, extra);
  }
  if (req.runtime === "codex")
    return [
      runtimeCommand("codex", req.executable),
      // A shared daemon owns threads outside the launch's process tree.
      // Keep inherited-profile sessions local so identity and stop remain scoped.
      ...(inheritProfile && req.kind === "session" ? ["--no-daemon"] : []),
      ...(req.kind === "task"
        ? [
            "exec",
            ...(inheritProfile ? [] : ["--ignore-user-config"]),
            "--skip-git-repo-check",
          ]
        : []),
      ...(policy.permissions === "auto"
        ? ["--approve-for-me"]
        : policy.permissions === "bypass"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : [
              // Workspace-write is spelled as the profile below instead: the
              // flag would override it.
              ...(writesWorkspace(policy)
                ? []
                : [
                    "--sandbox",
                    policy.sandbox === "full-access"
                      ? "danger-full-access"
                      : policy.sandbox,
                  ]),
              ...(req.kind === "session"
                ? ["--ask-for-approval", "never"]
                : ["-c", 'approval_policy="never"']),
            ]),
      ...(writesWorkspace(policy) ? codexWorkspaceProfile(musterHome) : []),
      ...model,
      ...extra,
      "--",
      req.prompt,
    ];
  const readonly = policy.sandbox === "read-only";
  // Muster's own home, under both spellings, wherever the launch can write its
  // cwd: the cwd write grant covers the home when the cwd contains it (#44).
  const protectedHome = writesWorkspace(policy)
    ? writeRootSpellings(musterHome)
    : [];
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
    ...profileForwardedSettings(configDir),
    disableAllHooks: true,
    // `--setting-sources ""` means an acceptance recorded in the profile's
    // settings.json is never read, so without this the bypass warning stops
    // every bypass launch before it registers (#45). Only on request, and
    // `assertOptionsSupported` has already refused it outside bypass.
    ...(req.options.includes("accept-bypass-warning") &&
    policy.permissions === "bypass"
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
    ...crossSessionSettings(req),
    permissions: {
      defaultMode: mode,
      allow: mcp.flatMap((s) =>
        s.config.tools.map((t) => `mcp__${s.name}__${t}`),
      ),
      deny: [
        ...(readonly ? ["Edit", "Write", "NotebookEdit"] : []),
        // The in-process file tools run outside the OS sandbox, so the
        // denyWrite below does not reach them. `//` is Claude's spelling of
        // an absolute path, and an `Edit(path)` rule covers every
        // file-editing tool: Claude 2.1.293 warns that `Write(path)` is never
        // matched by its file permission checks.
        ...protectedHome.map((dir) => `Edit(/${dir}/**)`),
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
        // The cwd is the sandbox's only default write root, so denying it
        // is the whole of read-only. Not "/": that also denies Claude Code's
        // own temp dir, which it writes after every Bash call, so every
        // command exited 1 (#41) — and a deny beats an allow, so the temp dir
        // cannot be allowed back. Both spellings of a symlinked cwd, so this
        // does not rest on Claude normalising the path.
        // At workspace-write, muster's own home is denied instead (#44): it
        // holds the policy every later launch obeys, and a cwd that contains
        // it (such as `~`) would otherwise make it writable.
        denyWrite: readonly ? writeRootSpellings(req.cwd) : protectedHome,
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
    runtimeCommand("claude", req.executable),
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
/**
 * `--options accept-cross-session`: deliver inbound cross-session messages
 * instead of holding them for a Deny/Deliver answer nobody is there to give.
 * Unset, Claude holds a message whose sender's permission-mode class differs
 * from the session's, and one whose sender asserts no class while the session
 * bypasses, so an unattended session never takes the turn. `--settings`
 * outranks every profile source but not managed policy, which can still refuse.
 */
function crossSessionSettings(req: RunRequest): Record<string, string> {
  return req.options.includes("accept-cross-session")
    ? { crossSessionInbound: "accept" }
    : {};
}
/**
 * A Claude launch exactly as a person would start it in this profile and
 * directory: every setting source (so rules, CLAUDE.md, the env and autoMode
 * blocks, permissions, hooks, the status line, plugins and the profile's own
 * MCP servers), no permission mode of muster's, no sandbox of muster's.
 *
 * Muster adds only what the caller named: `--mcp` servers ride alongside the
 * profile's (not instead of them — no `--strict-mcp-config`), and configured
 * `default_mcp` is not applied because the profile already brings its own.
 *
 * The one thing it refuses is a profile or project that makes bypass the
 * default: a muster launch never starts in bypass unless `--unrestricted`
 * asked for it.
 */
function normalClaudeArgs(
  req: RunRequest,
  mcp: PreparedMcp[],
  bridgePath: string | undefined,
  env: NodeJS.ProcessEnv,
  model: string[],
  extra: string[],
): string[] {
  const inheritProfile = req.options.includes("inherit-profile");
  const restricted = !!mcpSelection(req);
  if (!inheritProfile) assertNoDefaultBypass(claudeConfigDir(env), req.cwd);
  return [
    runtimeCommand("claude", req.executable),
    ...(req.kind === "task" ? ["-p"] : []),
    ...(inheritProfile
      ? [
          "--permission-mode",
          "bypassPermissions",
          "--settings",
          JSON.stringify({
            sandbox: { enabled: false },
            ...(restricted
              ? {
                  disableClaudeAiConnectors: true,
                  env: {
                    CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
                    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
                  },
                }
              : {}),
            ...(req.options.includes("accept-bypass-warning")
              ? { skipDangerousModePermissionPrompt: true }
              : {}),
            ...crossSessionSettings(req),
          }),
        ]
      : req.options.includes("accept-cross-session")
        ? ["--settings", JSON.stringify(crossSessionSettings(req))]
        : []),
    ...(restricted ? ["--strict-mcp-config", "--no-chrome"] : []),
    ...(mcp.length || restricted
      ? [
          "--mcp-config",
          JSON.stringify(
            claudeMcpConfig(
              mcp,
              bridgePath,
              inheritProfile && !restricted && bridgePath
                ? `muster_${basename(bridgePath, ".json")}`
                : undefined,
            ),
          ),
        ]
      : []),
    ...model,
    ...extra,
    "--",
    req.prompt,
  ];
}
/**
 * The setting files a hand launch reads for `permissions.defaultMode`, lowest
 * precedence first. Managed policy is above all three and is the operator's
 * organisation's to set, so it is not second-guessed here.
 */
export function claudeSettingFiles(configDir: string, cwd: string): string[] {
  return [
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
}
/** Refuses a normal launch whose effective default mode is bypassPermissions. */
export function assertNoDefaultBypass(configDir: string, cwd: string): void {
  let mode: unknown, from: string | undefined;
  for (const file of claudeSettingFiles(configDir, cwd)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Missing or unreadable: Claude skips it too.
      continue;
    }
    const value = (parsed as { permissions?: { defaultMode?: unknown } })
      ?.permissions?.defaultMode;
    if (value !== undefined) [mode, from] = [value, file];
  }
  if (mode === "bypassPermissions")
    throw new Error(
      `${from} sets permissions.defaultMode to bypassPermissions; muster ` +
        `will not start a launch in bypass by default. Pass --unrestricted ` +
        `to ask for it.`,
    );
}
/** A path as given and as resolved, once each. An unresolvable path (it does
 *  not exist yet) is denied as given — nothing can be written through a
 *  missing directory anyway. */
function writeRootSpellings(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  return [...new Set([path, real])];
}
export function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked =
    /^(CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD_ID$|CODEX_MANAGED_|TMUX$|TMUX_PANE$|MCP_)/;
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
