import {
  stat,
  readFile,
  realpath,
  writeFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import {
  runSchema,
  agentBaseEnv,
  assertAllowedWorkspace,
  assertLevelExclusive,
  resolveLifecycle,
  resolveModel,
  launchArgs,
  launchEnv,
  paramsFingerprint,
  resolvePermissions,
  resolveTerminal,
  runtimeArgs,
  type RunRequest,
  type Level,
  type LaunchPermissions,
  type SessionLifecycle,
} from "./guard.js";
import { enforcementGrade, type Enforcement } from "./enforcement.js";
import { LOCAL, type RequesterId } from "./requester.js";
import {
  assertEnforcementMeetsMinimum,
  assertLevelWithinCeiling,
  assertMayAct,
  resolveIdentityForRequest,
  resolveRequesterPolicy,
  RequesterPolicyRefusal,
  type ResolvedRequesterPolicy,
} from "./requester-policy.js";
import {
  IdentityError,
  readIdentity,
  type IdentityMeta,
} from "./identity-store.js";
import { resolveCredential, type Credential } from "./identity-token.js";
import { copyIdentity, identityEnv } from "./identity-copy.js";
import { Registry, type Entry } from "./registry.js";
import { LaunchLog } from "./log.js";
import { hosts, selectHost } from "./hosts/index.js";
import { AGENTS } from "./agents.js";
import { assertOptionsSupported, screenWorkspace } from "./options.js";
import { workspaceTrustKey } from "./identity/workspace-key.js";
import type { TerminalApp } from "./hosts/types.js";
import type { TerminalHost } from "./hosts/types.js";
import {
  processRef,
  isSame,
  stopTree,
  delay,
  descendants,
  ownedGroup,
  type ProcessRef,
} from "./identity/processes.js";
import { resolveCodex } from "./identity/codex.js";
import {
  claudeConfigDir,
  claudeRegistryDiagnostic,
  claudeWorkspaceTrusted,
  resolveClaude,
} from "./identity/claude.js";
import {
  openCodeEndpointOwnedBy,
  resolveOpenCode,
  type OpenCodeIdentity,
} from "./identity/opencode.js";
import { codexReachable, threadRejection } from "./reach/codex.js";
import { claudeReachable } from "./reach/claude.js";
import { openCodeReachable } from "./reach/opencode.js";
import { assertClaudePolicy } from "./claude-policy.js";
import { codexPolicyArgs } from "./codex-policy.js";
import { CodexRpc } from "./codex-rpc.js";
import { allocateLoopbackPort, OpenCodeHttp } from "./opencode-http.js";
import {
  assertOpenCodeVersion,
  openCodeMcpNames,
  openCodeSessionLaunch,
  openCodeTaskLaunch,
} from "./opencode-policy.js";
import {
  assignNames,
  resolvePeer,
  runtimeName,
  suffixOf,
  type NamedPeer,
} from "./naming.js";
import type { Runtime, SessionPeer, TaskHandle, RunResult } from "./types.js";
import {
  selectMcp,
  prepareMcp,
  mcpEnvironment,
  type PreparedMcp,
} from "./mcp.js";
import { pollInterval } from "./reap.js";
import { selectPlugins } from "./plugins.js";
function taskHandle(entry: Entry, pid: number): TaskHandle {
  return {
    kind: "task",
    permissions: entry.permissions!,
    sandbox: entry.sandbox!,
    mcp: entry.mcp ?? [],
    ...(entry.mcp_warnings ? { mcp_warnings: entry.mcp_warnings } : {}),
    ...(entry.enforcement ? { enforcement: entry.enforcement } : {}),
    ...(entry.identity ? { identity: entry.identity } : {}),
    // `run` returns this, while `list` builds its own record: a field added to
    // one and not the other makes the two disagree about the same launch.
    ...(entry.model !== undefined
      ? { model: entry.model, model_source: entry.modelSource ?? null }
      : {}),
    id: entry.id,
    runtime: entry.runtime,
    state: "running",
    cwd: entry.cwd,
    pid,
  };
}
/**
 * The variable that relocates an agent's configuration home — the one place the
 * agent records its session, and therefore the one place resolution may look.
 * OpenCode has none: its resolver uses the per-launch loopback HTTP endpoint
 * rather than a configuration path, so relocating its configuration moves
 * nothing Muster reads.
 */
/**
 * `undefined` rather than the table's `null`, because every caller treats this
 * as "there is no such variable" via `?? entry.identityPath` and an absent
 * value is what that idiom expects.
 */
function configHomeVar(
  runtime: Runtime,
): "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | undefined {
  return AGENTS[runtime].configHomeVar ?? undefined;
}

export class Muster {
  readonly registry: Registry;
  private log: LaunchLog;
  private owned = new Set<string>();
  private closing = false;
  private active = new Set<Promise<unknown>>();
  private constructor(
    readonly config: Config,
    readonly home: string,
    /**
     * Muster's own subprocesses: the version and policy probes. Denylist-filtered
     * from the parent and never handed to an agent — the agent's base comes from
     * `agentBaseEnv` per launch, which a remote requester composes rather than
     * inherits.
     *
     * Not what locates or reads an agent's session: that follows the agent's own
     * configuration directory, which a launch under an identity relocates. See
     * `resolutionEnv`, which is this environment plus that one override.
     */
    private hostEnv: Record<string, string>,
    private drivers: TerminalHost[],
    private sourceEnv: NodeJS.ProcessEnv,
  ) {
    this.registry = new Registry(home);
    this.log = new LaunchLog(home);
  }
  static async create(
    opts: {
      home?: string;
      env?: NodeJS.ProcessEnv;
      drivers?: TerminalHost[];
    } = {},
  ) {
    const env = launchEnv(opts.env ?? process.env),
      home = opts.home ?? join(env.HOME ?? homedir(), ".muster");
    const config = await loadConfig(home);
    return new Muster(
      config,
      home,
      env,
      opts.drivers ?? hosts(opts.env ?? process.env, config.tmux_status),
      { ...(opts.env ?? process.env) },
    );
  }
  run(input: unknown, requester: RequesterId = LOCAL): Promise<RunResult> {
    if (this.closing) return Promise.reject(new Error("Muster is closing"));
    const operation = this.launch(input, requester);
    this.active.add(operation);
    return operation.finally(() => this.active.delete(operation));
  }
  /**
   * Phase 1 of a launch: decide whether this caller may ask for this at all,
   * and settle what "this" is. Everything here refuses BEFORE anything is
   * reserved, spawned or written, which is why it reads the raw input in places
   * rather than the parsed request — once defaults have been applied, a value
   * Muster chose is indistinguishable from one the caller sent.
   */
  private async authorize(
    input: unknown,
    requester: RequesterId,
  ): Promise<{
    req: RunRequest;
    policy: ResolvedRequesterPolicy;
    level?: Level;
  }> {
    // Read before parsing, because cwd defaults during it and a default is then
    // indistinguishable from a directory the caller asked for. Naming both a
    // project and a directory is a contradiction worth reporting rather than
    // resolving by precedence.
    if (
      typeof input === "object" &&
      input !== null &&
      "project" in input &&
      (input as { cwd?: unknown }).cwd !== undefined
    )
      throw new Error("use project or cwd, not both");
    assertLevelExclusive(input);
    // Resolved before the request is parsed, so an unenrolled requester is
    // refused without Muster having interpreted anything it sent.
    const policy = resolveRequesterPolicy(requester, this.config);
    if (
      requester.kind === "remote" &&
      typeof input === "object" &&
      input !== null
    ) {
      const raw = input as Record<string, unknown>;
      if (raw.permissions !== undefined || raw.sandbox !== undefined)
        throw new RequesterPolicyRefusal(
          "not-expressible-remotely",
          "a remote request may name a level, not permissions or sandbox",
        );
      // `env_allow` is not the whole allowlist while a request may choose its
      // own MCP servers: `mcpEnvironment` copies each selected server's
      // declared `env_vars` and `bearer_token_env_var` out of the unfiltered
      // source environment, so naming a server is how a remote request would
      // pull that server's credentials into its agent despite `env_allow = []`.
      // A plugin is the same shape, and an OpenCode launch that selects any
      // plugin additionally admits whatever the target repository ships under
      // .opencode/plugin. The spec's mitigation is to withhold the server
      // rather than the variable, and no profile key can — so the selection
      // itself is not expressible remotely, and a remote launch gets the
      // receiver's configured `default_mcp` / `default_plugins`. Configuration
      // is the grant.
      // `options` joins them for the same reason, and one of its own:
      // auto-approve-path would have this machine trust a directory a remote
      // caller named, and trust is what lets that directory configure the
      // session. Configuration is the grant.
      for (const key of ["mcp", "plugin", "options"] as const)
        if (raw[key] !== undefined)
          throw new RequesterPolicyRefusal(
            "not-expressible-remotely",
            `a remote request may not select ${key}; this receiver's configured defaults apply`,
          );
    }
    const req = runSchema.parse(input);
    if (req.project) {
      const configured = this.config.projects[req.project];
      if (!configured)
        throw new Error(
          `Unknown project ${req.project}. Configured: ${
            Object.keys(this.config.projects).join(", ") || "none"
          }`,
        );
      req.cwd = resolve(configured);
    }
    if (!(await stat(req.cwd)).isDirectory())
      throw new Error("cwd is not a directory");
    await assertAllowedWorkspace(req.cwd, this.config);
    if (policy.profile)
      // Intersection by two independent checks. `projects: {}` matters: a
      // configured project path is a root in its own right, and a remote
      // profile must not inherit those grants.
      await assertAllowedWorkspace(req.cwd, {
        allowed_roots: policy.profile.allowed_roots,
        projects: {},
      });
    // The effective level, and the reason this is not `?? "read"`: a remote
    // request usually names no level, and `resolvePermissions` with no level
    // falls through to `req.permissions ?? config.permissions` and
    // `req.sandbox ?? config.sandbox` — the *receiving machine's* global
    // defaults. So the profile is the floor here as well as the ceiling. A
    // local requester has no `policy.level`, which leaves this undefined and
    // local behaviour untouched.
    const level = req.level ?? policy.level;
    if (level) assertLevelWithinCeiling(level, policy);
    return { req, policy, level };
  }
  /**
   * Phase 2: the read-only half of identity resolution. Validated before
   * anything is reserved or spawned, so a bad identity leaves no registry entry
   * behind. The per-launch COPY cannot be made here — it is named after the
   * launch id, which only `reserve` produces — so that half happens later.
   */
  private async resolveIdentity(
    req: RunRequest,
    policy: ResolvedRequesterPolicy,
  ): Promise<{
    identityName?: string;
    identityMeta?: IdentityMeta;
    credential?: Credential;
  }> {
    // Validated here, before anything is reserved or spawned: a bad identity
    // must leave no registry entry behind. The copy cannot be made yet — it is
    // named after the launch id, which only `reserve` produces — so this is the
    // read-only half, and the copy happens below once that id exists.
    const identityName = resolveIdentityForRequest(req.identity, policy);
    let identityMeta: IdentityMeta | undefined;
    let credential: Credential | undefined;
    if (identityName) {
      identityMeta = await readIdentity(this.home, identityName);
      if (identityMeta.agent !== req.runtime)
        throw new IdentityError(
          identityName,
          `belongs to agent ${identityMeta.agent}, not ${req.runtime}`,
        );
      // Claude is the one runtime whose credential cannot survive the copy. It
      // is keyed by the configuration directory's PATH, and a launch points
      // Claude at the per-launch copy, which hashes to a service name that does
      // not exist — the unsuffixed item is not a fallback. So a token is the
      // only route a Claude identity can launch under.
      //
      // Resolved from the TEMPLATE, which exists now; the copy does not yet.
      if (identityMeta.agent === "claude") {
        credential = await resolveCredential(
          this.home,
          identityName,
          identityMeta,
          // The unfiltered source environment, because that is where the
          // operator set the variable and `hostEnv` filters CLAUDE_CODE_* away.
          this.sourceEnv,
        );
        if (!credential.token)
          throw new IdentityError(
            identityName,
            credential.route === "env"
              ? `needs ${credential.variable} set in the environment`
              : "has no credential — run `setup-identity --interactive` to log in and store a token",
          );
      }
    }
    return { identityName, identityMeta, credential };
  }
  /**
   * Phase 3: everything the launch needs decided, and every refusal that can be
   * made without side effects — host and terminal availability, the runtime's
   * own preflight, the enforcement floor. Nothing here reserves, spawns or
   * writes, so a launch refused at this point leaves no trace.
   */
  private async plan(
    req: RunRequest,
    policy: ResolvedRequesterPolicy,
    requester: RequesterId,
    level?: Level,
  ) {
    /**
     * The one request every permission- and argv-deriving helper is given.
     *
     * `launchArgs`, `openCodeSessionLaunch` and `openCodeTaskLaunch` each call
     * `resolvePermissions` again internally, so resolving the pair here and
     * handing them the raw `req` would put the effective level in the record
     * and the machine's global defaults in the argv — a remote `read` launch
     * whose registry entry says `read-only` while the spawned process was
     * given `--approve-for-me`. Two values where there should be one is how
     * that happens, so there is one: nothing below derives containment from
     * `req`.
     */
    const effective = level ? { ...req, level } : req;
    if (req.kind === "task" && req.host)
      throw new Error("host applies only to session launches");
    if (req.terminal && !req.open)
      throw new Error("--terminal requires --open");
    const terminal = resolveTerminal(req, this.config);
    const requestedHost = req.host ?? this.config.host;
    if (
      req.open &&
      (req.kind !== "session" || !["auto", "tmux"].includes(requestedHost))
    )
      throw new Error("--open requires a tmux session on macOS");
    // Refused here, with the other checks that cost nothing to fail: an option
    // the runtime cannot honour must not leave a registry entry behind.
    assertOptionsSupported(req.runtime, req.options);
    const permissions = resolvePermissions(effective, this.config);
    const enforcement = enforcementGrade(req.runtime, permissions);
    assertEnforcementMeetsMinimum(req.runtime, enforcement, policy);
    // Composed here, before any process of any kind is started — the version
    // probes and host availability checks below all spawn. A profile whose
    // composed environment has no PATH or LANG must refuse the launch rather
    // than leave a half-started one behind.
    const agentBase = agentBaseEnv(requester, policy.profile, this.sourceEnv);
    const selectedMcp = selectMcp(effective, this.config);
    const selectedPlugins =
      req.runtime === "opencode" ? selectPlugins(effective, this.config) : [];
    let argv: string[] = [];
    // Resolved here, at the seam that already exists to refuse a bad launch
    // before anything is reserved: a malformed model must not leave a
    // registry entry behind.
    const model = resolveModel(effective, this.config);
    if (req.runtime === "opencode") runtimeArgs(effective);
    else
      argv = launchArgs(effective, this.config, [], undefined, this.sourceEnv);
    const driver =
      req.kind === "session"
        ? await selectHost(req.open ? "tmux" : requestedHost, this.drivers)
        : undefined;
    if (
      req.open &&
      (!driver?.open || !(await driver.openAvailable?.(terminal)))
    )
      throw new Error(
        `--open requires the selected terminal (${terminal}) installed on macOS and tmux`,
      );
    if (req.runtime === "claude") await assertClaudePolicy(this.hostEnv);
    if (req.runtime === "opencode")
      await assertOpenCodeVersion(this.hostEnv, "1.18.31", Date.now() + 4000);
    // After the driver, not beside resolveModel: the host that runs is
    // `req.host ?? config.host` with `auto` resolving to whatever is available,
    // so only the selected driver knows whether a lifecycle can be honoured.
    // Deciding from `req.host` accepts --idle-timeout under `host = "pty"` in
    // config and then never arms it.
    const lifecycle = resolveLifecycle(
      effective,
      this.config,
      req.kind === "session" && typeof driver?.schedule === "function",
    );
    return {
      effective,
      terminal,
      permissions,
      enforcement,
      agentBase,
      selectedMcp,
      selectedPlugins,
      model,
      driver,
      lifecycle,
      argv,
    };
  }
  /**
   * Phase 4: claim the slot. The first step with a side effect, and the first
   * that can answer "this launch already happened" — a repeated `--request-key`
   * returns the original outcome rather than starting a second agent, so the
   * caller cannot tell a retry from a duplicate.
   */
  private async reserveLaunch(c: {
    req: RunRequest;
    effective: RunRequest;
    policy: ResolvedRequesterPolicy;
    requester: RequesterId;
    permissions: LaunchPermissions;
    enforcement: Enforcement;
    model: ReturnType<typeof resolveModel>;
    lifecycle: SessionLifecycle;
    selectedMcp: ReturnType<typeof selectMcp>;
    selectedPlugins: ReturnType<typeof selectPlugins>;
    identityName?: string;
  }): Promise<{ outcome: RunResult } | { entry: Entry }> {
    const {
      req,
      effective,
      policy,
      requester,
      permissions,
      enforcement,
      model,
      lifecycle,
      selectedMcp,
      selectedPlugins,
      identityName,
    } = c;
    const { entry: reservation, deduped } = await this.registry.reserve(
      {
        runtime: req.runtime,
        kind: req.kind,
        cwd: req.cwd,
        ...permissions,
        enforcement,
        model: model?.model ?? null,
        modelSource: model?.source ?? null,
        idleTimeout: lifecycle.idleTimeout,
        ttl: lifecycle.ttl,
        // Recorded here rather than only at the patch below, because `list`
        // now publishes it: an entry that dies between this line and that one
        // would otherwise report no identity, which reads as "ran on the
        // ambient environment" for a launch that named an account.
        ...(identityName ? { identity: identityName } : {}),
      },
      this.config.max_concurrent,
      req.requestKey
        ? {
            requestKey: req.requestKey,
            paramsFingerprint: paramsFingerprint(
              // The identity that actually determined the account, not the one
              // named in the request: a remote requester granted exactly one
              // identity names none and gets it anyway, and that launch must
              // not share a fingerprint with a request that named something
              // else. `effective` is left alone — nothing else derives from
              // identity.
              { ...effective, identity: identityName },
              permissions,
              selectedMcp.map((s) => s.name),
              selectedPlugins.map((p) => p.name),
            ),
          }
        : undefined,
      requester,
    );
    if (deduped) {
      await this.log.write(
        {
          event: "deduped",
          launch_id: reservation.launchId,
          request_key: req.requestKey,
          status: reservation.status,
          requester,
        },
        policy.logMode,
      );
      return { outcome: this.recordedOutcome(reservation) };
    }
    this.owned.add(reservation.launchId);
    return { entry: reservation };
  }
  /**
   * Phase 5: everything the agent's own environment needs before a process can
   * be started — MCP servers probed, the per-launch identity copy made (the
   * launch id exists now, and the copy is named after it), the configuration
   * home the child will actually open recorded, and Claude's MCP bridge file
   * written.
   *
   * Three of the sixteen per-agent capabilities surface here: workspace trust
   * is written to a different file and key per agent and does not apply to
   * OpenCode, the configuration-home variable differs, and the bridge file is
   * Claude's alone. See AGENT_CAPABILITIES.md.
   */
  private async prepareEnvironment(c: {
    req: RunRequest;
    entry: Entry;
    identityName?: string;
    identityMeta?: IdentityMeta;
    credential?: Credential;
    selectedMcp: ReturnType<typeof selectMcp>;
    agentBase: Record<string, string>;
    deadline: number;
  }) {
    const {
      req,
      identityName,
      identityMeta,
      credential,
      selectedMcp,
      agentBase,
      deadline,
    } = c;
    let entry = c.entry;
    const prepared = await prepareMcp(
      selectedMcp,
      mcpEnvironment(selectedMcp, agentBase, this.sourceEnv),
      req.cwd,
      deadline,
    );
    let runtimeEnv = mcpEnvironment(
      prepared.servers,
      agentBase,
      this.sourceEnv,
    );
    entry = await this.registry.update(entry.launchId, prepared.summary);
    if (identityName && identityMeta) {
      // The launch id exists now, so the copy can be made and named after it.
      const copy = await copyIdentity(
        this.home,
        identityName,
        identityMeta,
        entry.launchId,
      );
      // Keyed on the identity's agent, which `resolveIdentity` has already
      // refused unless it equals req.runtime — so this is the same row either
      // way, and reading it from the identity keeps the check and the use
      // agreed. A fresh copy trusts nothing, so without this every identity
      // launch sat on "Do you trust the contents of this directory?" until the
      // deadline. `realpath` and the reason for it are documented on the slot.
      await AGENTS[identityMeta.agent].trustWorkspace?.(
        copy,
        await workspaceTrustKey(req.cwd),
      );
      runtimeEnv = {
        ...runtimeEnv,
        ...identityEnv(identityMeta, copy, this.sourceEnv, credential?.token),
      };
      entry = await this.registry.update(entry.launchId, {
        identityPath: copy,
        // Recorded alongside the path, because the path outlives the directory
        // it names and never named the account.
        identity: identityName,
      });
    }
    // Where the agent will record its session. Distinct from `hostEnv`, which
    // keeps spawning Muster's own helpers — see `resolutionEnv`.
    //
    // Derived from the COMPOSED agent environment, not from `identityPath`
    // alone: a requester profile's `env_defaults` delivers any key by design,
    // so a profile setting CLAUDE_CONFIG_DIR or CODEX_HOME hands the agent one
    // configuration home while resolution searched the host's — reserve, spawn,
    // dead at the deadline. The identity copy still wins where there is one,
    // because `identityEnv` is merged into `runtimeEnv` above.
    // `--options auto-approve-path`: record the launch directory as trusted in
    // the profile the agent will actually use, so the one-time dialog does not
    // stop the launch. Screened first — a directory that ships hooks or MCP
    // servers configures the session it is trusted by, and those run without
    // asking, so it is named and refused rather than waved through.
    if (req.options.includes("auto-approve-path")) {
      const findings = await screenWorkspace(req.cwd);
      if (findings.length)
        throw new Error(
          `--options auto-approve-path refused: ${req.cwd} ships ${findings.join(" and ")}; trusting it would let that configure the session. Trust it yourself once, or launch without the option.`,
        );
    }
    const configVar = configHomeVar(req.runtime);
    const configHome = configVar
      ? (runtimeEnv[configVar] ?? entry.identityPath)
      : undefined;
    // Persisted only when it differs from the host's, so a launch with neither
    // an identity nor an override writes nothing new and reads exactly as
    // before. `refreshed()` has only the entry in scope and must agree.
    if (configVar && configHome && configHome !== this.hostEnv[configVar])
      entry = await this.registry.update(entry.launchId, { configHome });
    // Written before the agent starts and into the SAME dir the child will open.
    // An identity launch has already had its copy trusted above, so this is a
    // no-op there rather than a second write.
    if (req.options.includes("auto-approve-path") && configHome)
      await AGENTS[req.runtime].trustWorkspace?.(
        configHome,
        await workspaceTrustKey(req.cwd),
      );
    const resolveEnv = this.resolutionEnv(req.runtime, configHome);
    let bridgePath: string | undefined;
    if (req.runtime === "claude" && prepared.servers.length) {
      const dir = join(this.home, "mcp");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      bridgePath = join(dir, entry.launchId + ".json");
      entry = await this.registry.update(entry.launchId, {
        mcpConfigPath: bridgePath,
      });
      await writeFile(
        bridgePath,
        JSON.stringify(
          Object.fromEntries(prepared.servers.map((s) => [s.name, s.config])),
        ),
        { mode: 0o600 },
      );
    }
    return { entry, prepared, runtimeEnv, configHome, resolveEnv, bridgePath };
  }
  /**
   * Phase 6: turn the plan into a command line. This is the widest per-agent
   * split in the launch — Claude and Codex are handed argv and contain
   * themselves from there, while OpenCode is a server Muster starts on an
   * allocated loopback port and then talks to over HTTP, so its "argv" comes
   * back from a builder that also reports the port and an environment patch.
   *
   * Codex's policy overrides are spliced in AFTER launchArgs rather than passed
   * to it, because they are computed from the composed runtime environment that
   * only exists by this point.
   */
  private async buildCommand(c: {
    req: RunRequest;
    effective: RunRequest;
    entry: Entry;
    argv: string[];
    codexPolicy: string[];
    runtimeEnv: Record<string, string>;
    prepared: { servers: PreparedMcp[] };
    bridgePath?: string;
    selectedPlugins: ReturnType<typeof selectPlugins>;
    deadline: number;
  }) {
    const { req, effective, prepared, bridgePath, selectedPlugins, deadline } =
      c;
    let { argv, codexPolicy, runtimeEnv, entry } = c;
    if (req.runtime !== "opencode")
      // `runtimeEnv`, not the host's: an identity launch relocates
      // CLAUDE_CONFIG_DIR to the per-launch copy, and the sandbox must grant
      // the dir the child will actually open, not the one Muster runs under.
      argv = launchArgs(
        effective,
        this.config,
        prepared.servers,
        bridgePath,
        runtimeEnv,
      );
    if (req.runtime === "codex") {
      codexPolicy = await codexPolicyArgs(
        runtimeEnv,
        req.cwd,
        deadline,
        prepared.servers,
        req.kind === "task",
      );
      argv.splice(1, 0, ...codexPolicy);
    } else if (req.runtime === "opencode" && req.kind === "session") {
      const port = await allocateLoopbackPort();
      const inheritedMcpNames = await openCodeMcpNames(
        runtimeEnv,
        req.cwd,
        deadline,
      );
      const launch = await openCodeSessionLaunch(
        effective,
        this.config,
        prepared.servers,
        inheritedMcpNames,
        port,
        runtimeEnv,
        req.cwd,
        deadline,
        selectedPlugins,
        this.sourceEnv,
      );
      argv = launch.argv;
      runtimeEnv = { ...runtimeEnv, ...launch.envPatch };
      entry = await this.registry.update(entry.launchId, {
        server_url: launch.serverUrl!,
        opencode_port: launch.port!,
      });
    } else if (req.runtime === "opencode" && req.kind === "task") {
      const inheritedMcpNames = await openCodeMcpNames(
        runtimeEnv,
        req.cwd,
        deadline,
      );
      const launch = await openCodeTaskLaunch(
        effective,
        this.config,
        prepared.servers,
        inheritedMcpNames,
        runtimeEnv,
        req.cwd,
        deadline,
        selectedPlugins,
        this.sourceEnv,
      );
      argv = launch.argv;
      runtimeEnv = { ...runtimeEnv, ...launch.envPatch };
    }
    return { argv, codexPolicy, runtimeEnv, entry };
  }
  /**
   * Phase 7: start the process. The first point at which a process can exist
   * without the registry knowing about it, which is why `spawning` is recorded
   * before the host is asked to launch anything.
   *
   * A task ends here — `startTask` owns its whole lifetime — so this returns an
   * outcome rather than falling through, and only a session carries on to
   * readiness.
   */
  private async startProcess(c: {
    req: RunRequest;
    entry: Entry;
    argv: string[];
    runtimeEnv: Record<string, string>;
    policy: ResolvedRequesterPolicy;
    driver?: TerminalHost;
    lifecycle: SessionLifecycle;
    deadline: number;
  }): Promise<
    | { outcome: RunResult }
    | {
        entry: Entry;
        root: ProcessRef;
        launched: { hostRef: string; pid: number };
      }
  > {
    const { req, argv, runtimeEnv, policy, driver, lifecycle, deadline } = c;
    let entry = c.entry;
    if (this.closing) throw new Error("Launch cancelled: Muster is closing");
    // From here a process may exist without the registry knowing it. See the
    // recovery branch in Registry.transaction.
    entry = await this.registry.update(entry.launchId, { spawning: true });
    if (req.kind === "task")
      return {
        outcome: await this.startTask(entry, argv, runtimeEnv, policy.logMode),
      };
    const launched = await driver!.launch({
      argv,
      cwd: req.cwd,
      env: runtimeEnv,
      label: req.prompt.slice(0, 48),
      deadline,
    });
    const root = await processRef(launched.pid);
    if (!root) {
      await driver!.stop(launched.hostRef);
      throw new Error("process exited during launch");
    }
    const group = await ownedGroup(launched.pid);
    entry = {
      ...entry,
      root,
      ...(group ? { group } : {}),
      host: driver!.id,
      hostRef: launched.hostRef,
    };
    // Only the fields that changed, not the whole entry: `entry` still
    // carries its recorded `requester`, and update() refuses a patch that
    // mentions that field at all, changed or not.
    await this.registry.update(entry.launchId, {
      root,
      ...(group ? { group } : {}),
      host: driver!.id,
      hostRef: launched.hostRef,
    });
    // Armed only once hostRef exists: the job addresses the window, and a job
    // armed before the window is recorded would poll a target the registry
    // cannot name. `schedule` is optional on the host interface, so pty and
    // macos-terminal opt out by not implementing it.
    if (driver?.schedule && (lifecycle.idleTimeout ?? lifecycle.ttl)) {
      const armed = await driver
        .schedule(pollInterval(lifecycle), [
          process.execPath,
          // ../dist/muster.js, not ./muster.js: this resolves from src/run.ts
          // under vitest as well as from dist/run.js in the package, landing
          // on <root>/dist either way. Same idiom as the tmux bootstrap.
          fileURLToPath(new URL("../dist/muster.js", import.meta.url)),
          "reap-check",
          "--home",
          this.home,
          "--socket",
          driver.socketName?.() ?? "muster",
          entry.launchId,
        ])
        .then(
          () => true,
          () => false,
        );
      // A lifecycle that could not be armed must not fail the launch — the
      // session is up and usable, and the orphan risk is what we had before.
      // But it must not be REPORTED either: a record promising an expiry
      // nothing will honour is worse than one promising none, because there
      // is no way to tell from the outside.
      if (!armed) {
        lifecycle.idleTimeout = null;
        lifecycle.ttl = null;
        entry = await this.registry.update(entry.launchId, {
          idleTimeout: null,
          ttl: null,
        });
      }
    }
    return { entry, root, launched };
  }
  /**
   * Phase 8: wait until the agent has registered a session Muster can address,
   * or until the deadline, whichever comes first. The subtlest phase, and the
   * one where the runtimes differ most: a session record on disk for Claude, a
   * JSON-RPC thread read for Codex, an HTTP endpoint plus a port-ownership
   * check for OpenCode. They share a question, not a mechanism.
   *
   * `diagnostic` is the reason the launch would fail if the deadline arrived
   * now. It is overwritten by anything the loop learns, so a timeout reports
   * the last real explanation rather than "no identity found" — and
   * `neverRegistered` keeps the original, because only that one can be about a
   * consent screen nobody answered.
   *
   * The RPC connection is created by the caller rather than here: `launch`'s
   * `finally` has to close it even when this throws.
   */
  private async awaitReadiness(c: {
    req: RunRequest;
    entry: Entry;
    root: ProcessRef;
    launched: { hostRef: string; pid: number };
    driver?: TerminalHost;
    policy: ResolvedRequesterPolicy;
    requester: RequesterId;
    resolveEnv: NodeJS.ProcessEnv;
    rpc?: CodexRpc;
    enforcement: Enforcement;
    prepared: Awaited<ReturnType<typeof prepareMcp>>;
    identityName?: string;
    model: ReturnType<typeof resolveModel>;
    permissions: LaunchPermissions;
    terminal: TerminalApp;
    lifecycle: SessionLifecycle;
    startedAt: number;
    deadline: number;
  }): Promise<RunResult> {
    const {
      req,
      root,
      launched,
      driver,
      policy,
      requester,
      resolveEnv,
      rpc,
      enforcement,
      prepared,
      identityName,
      model,
      permissions,
      terminal,
      lifecycle,
      startedAt,
      deadline,
    } = c;
    let entry = c.entry;
    let diagnostic =
      req.runtime === "claude"
        ? "no Claude session registry found (check terminal for workspace trust or login prompts)"
        : req.runtime === "opencode"
          ? "no OpenCode session matched the launch endpoint, cwd, and creation window"
          : "no descendant runtime identity found";
    // Kept so the throw below can tell "nothing ever registered" from a
    // diagnosis the loop actually earned. Only the first case can be about a
    // consent screen; anything later means a session existed.
    const neverRegistered = diagnostic;
    // `resolveEnv`, not `hostEnv`: this connection is how the thread
    // `resolveCodex` found gets READ — both its `rejectionOf` screen, where a
    // non-null answer is fatal, and `codexReachable` at readiness. An
    // app-server reading the operator's CODEX_HOME has no rollout for a thread
    // created under the copy, so it answers "no rollout found", every
    // candidate is rejected, and the launch burns its deadline. Pointing
    // discovery at the copy while its reads stay on the host is the same bug
    // one call downstream.
    while (Date.now() < deadline) {
      if (deadline - Date.now() < 25) break;
      if (await isSame(root)) {
        const tracked = (
          await Promise.all(
            (await descendants(root.pid, Date.now() + 1000, entry.group)).map(
              processRef,
            ),
          )
        ).filter((p): p is NonNullable<typeof p> => !!p);
        const refs = [...(entry.descendants ?? [])];
        for (const ref of tracked)
          if (!refs.some((r) => r.pid === ref.pid && r.start === ref.start))
            refs.push(ref);
        if (refs.length !== (entry.descendants ?? []).length) {
          entry = { ...entry, descendants: refs };
          await this.registry.update(entry.launchId, { descendants: refs });
        }
      }
      if (this.closing) throw new Error("Launch cancelled: Muster is closing");
      if (!(await isSame(root)))
        throw new Error(
          `process exited at ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
        );
      let openingTerminal = false;
      try {
        const identity =
          req.runtime === "codex"
            ? await resolveCodex(root.pid, resolveEnv, deadline, async (id) => {
                try {
                  const { thread } = await rpc!.call(
                    "thread/read",
                    { threadId: id },
                    deadline,
                  );
                  return threadRejection(thread, id);
                } catch (e) {
                  return (e as Error).message;
                }
              })
            : req.runtime === "opencode"
              ? await resolveOpenCode(
                  root.pid,
                  entry.server_url!,
                  req.cwd,
                  startedAt,
                  deadline,
                )
              : await resolveClaude(root.pid, resolveEnv, deadline);
        if (identity) {
          diagnostic =
            req.runtime === "codex"
              ? "thread id reserved but no rollout"
              : req.runtime === "opencode"
                ? "OpenCode session exists but its endpoint status is not readable"
                : "registry exists but inbox socket is not accepting connections";
          let metadata: { rawName: string | null; state: "idle" | "busy" };
          if (req.runtime === "codex")
            metadata = await codexReachable(rpc!, identity.id, deadline);
          else if (req.runtime === "opencode")
            metadata = await openCodeReachable(
              new OpenCodeHttp(entry.server_url!),
              identity as OpenCodeIdentity,
              deadline,
            );
          else {
            const claude = identity as Awaited<
              ReturnType<typeof resolveClaude>
            >;
            if (!(await claudeReachable(claude!.socketPath, deadline)))
              throw new Error(diagnostic);
            metadata = claude!;
          }
          if (Date.now() >= deadline)
            throw new Error("readiness completed after launch deadline");
          if (!(await isSame(root)) || !(await processRef(identity.pid)))
            throw new Error("process exited before readiness completed");
          if (
            req.runtime === "opencode" &&
            !(await openCodeEndpointOwnedBy(
              root.pid,
              entry.server_url!,
              deadline,
            ))
          )
            throw new Error(
              "OpenCode endpoint listener is not owned by the launched process tree",
            );
          const runtime = runtimeName(req.runtime);
          const named = assignNames([
            { runtime, uuid: identity.id, rawName: metadata.rawName },
          ])[0]!;
          const peer = {
            kind: "session",
            ...permissions,
            enforcement,
            ...prepared.summary,
            name: named.display,
            canonical_id: named.canonicalId,
            runtime,
            state: metadata.state,
            cwd: req.cwd,
            ...(req.runtime === "codex"
              ? { thread_id: identity.id }
              : req.runtime === "opencode"
                ? {
                    session_id: identity.id,
                    server_url: entry.server_url!,
                  }
                : { session_id: identity.id }),
            pid: identity.pid,
            host: driver!.id,
            capabilities: driver!.capabilities(),
            // The RESOLVED name, matching what the entry records and what
            // `list` projects: a launch result and a listing must not
            // disagree about which account this ran as.
            ...(identityName ? { identity: identityName } : {}),
            // Same reason, for the same pair of records.
            model: model?.model ?? null,
            model_source: model?.source ?? null,
            ...(lifecycle.idleTimeout
              ? { idle_timeout: lifecycle.idleTimeout }
              : {}),
            ...(lifecycle.ttl ? { ttl: lifecycle.ttl } : {}),
            attach_hint: driver!.attachHint(launched.hostRef),
          } as SessionPeer;
          if (req.open) {
            openingTerminal = true;
            await driver!.open!(launched.hostRef, deadline, terminal);
            peer.terminal_opened = true;
            peer.terminal = terminal;
          }
          entry = await this.registry.update(entry.launchId, {
            id: identity.id,
            status: "running",
            peer,
          });
          await this.log.write(
            { event: "ready", launch_id: entry.launchId, peer },
            policy.logMode,
          );
          return peer;
        }
      } catch (e) {
        if (openingTerminal) throw e;
        // An error arriving after the deadline is dropped, because most of
        // them are artifacts of the deadline itself — aborted round trips
        // that would overwrite a real diagnosis with "timed out". The cost is
        // that a genuine answer landing a moment late is lost too, so raise
        // one as early as it is known rather than at readiness (#20).
        if (Date.now() < deadline) diagnostic = (e as Error).message;
      }
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    // Resolved here rather than before the launch: this reads the operator's
    // live `.claude.json`, and a launch that is going to work should not pay
    // for it. Failing closed is also wrong before a launch — `--kind task`
    // runs headless and never sees the dialog, so refusing an untrusted
    // directory up front would break task launches that work today.
    if (req.runtime === "claude" && diagnostic === neverRegistered)
      diagnostic = claudeRegistryDiagnostic(
        await claudeWorkspaceTrusted(resolveEnv, req.cwd),
        req.cwd,
        claudeConfigDir(resolveEnv),
      );
    throw new Error(`${diagnostic} after ${this.config.launch_timeout_sec}s`);
  }
  private async launch(
    input: unknown,
    requester: RequesterId,
  ): Promise<RunResult> {
    const { req, policy, level } = await this.authorize(input, requester);
    const { identityName, identityMeta, credential } =
      await this.resolveIdentity(req, policy);
    const {
      effective,
      terminal,
      permissions,
      enforcement,
      agentBase,
      selectedMcp,
      selectedPlugins,
      model,
      driver,
      lifecycle,
      argv: plannedArgv,
    } = await this.plan(req, policy, requester, level);
    let argv = plannedArgv;
    let codexPolicy: string[] = [];
    const reserved = await this.reserveLaunch({
      req,
      effective,
      policy,
      requester,
      permissions,
      enforcement,
      model,
      lifecycle,
      selectedMcp,
      selectedPlugins,
      identityName,
    });
    if ("outcome" in reserved) return reserved.outcome;
    const reservation = reserved.entry;
    let entry = reservation;
    const startedAt = Date.now();
    const deadline = startedAt + this.config.launch_timeout_sec * 1000;
    let rpc: CodexRpc | undefined;
    try {
      await this.log.write(
        {
          event: "intent",
          launch_id: entry.launchId,
          runtime: req.runtime,
          kind: req.kind,
          cwd: req.cwd,
          prompt: req.prompt,
          host: driver?.id ?? null,
          requester,
          ...(req.open ? { open: true, terminal } : {}),
          args: req.args,
          // The RESOLVED name, not req.identity: a remote requester granted
          // exactly one identity names none and gets it anyway, and the audit
          // trail must state the account that was actually used. Not in
          // METADATA_DROP — a receiver needs this in a metadata-only record
          // more than anywhere else, since it is the account it lent out.
          ...(identityName ? { identity: identityName } : {}),
          mcp: selectedMcp.map((s) => s.name),
          ...(selectedPlugins.length
            ? { plugins: selectedPlugins.map((p) => p.name) }
            : {}),
          ...permissions,
          enforcement,
        },
        policy.logMode,
      );
      const environment = await this.prepareEnvironment({
        req,
        entry,
        identityName,
        identityMeta,
        credential,
        selectedMcp,
        agentBase,
        deadline,
      });
      entry = environment.entry;
      // `runtimeEnv` is still reassigned below — an OpenCode launch patches it
      // with the port its server ended up on — so it stays a `let` here rather
      // than being destructured as a const.
      let runtimeEnv = environment.runtimeEnv;
      const { prepared, configHome, resolveEnv, bridgePath } = environment;
      ({ argv, codexPolicy, runtimeEnv, entry } = await this.buildCommand({
        req,
        effective,
        entry,
        argv,
        codexPolicy,
        runtimeEnv,
        prepared,
        bridgePath,
        selectedPlugins,
        deadline,
      }));
      const started = await this.startProcess({
        req,
        entry,
        argv,
        runtimeEnv,
        policy,
        driver,
        lifecycle,
        deadline,
      });
      if ("outcome" in started) return started.outcome;
      entry = started.entry;
      const { root, launched } = started;
      if (req.runtime === "codex") rpc = new CodexRpc(resolveEnv, req.cwd);
      return await this.awaitReadiness({
        req,
        entry,
        root,
        launched,
        driver,
        policy,
        requester,
        resolveEnv,
        rpc,
        enforcement,
        prepared,
        identityName,
        model,
        permissions,
        terminal,
        lifecycle,
        startedAt,
        deadline,
      });
    } catch (e) {
      await this.stopEntry(entry).catch(() => {});
      const message = (e as Error).message;
      await this.registry.update(entry.launchId, {
        status: "failed",
        error: message,
      });
      await this.log
        .write(
          { event: "failure", launch_id: entry.launchId, error: message },
          policy.logMode,
        )
        .catch(() => {});
      throw e;
    }
  }
  /**
   * The answer to a request we have already seen. Never a new launch: a repeat
   * of a request that succeeded must return what it produced, and a repeat of
   * one that did not must report that rather than quietly trying again.
   *
   * A launch still in flight is refused rather than answered, because there is
   * nothing yet to return and inventing a pending result would let a caller
   * treat it as a session.
   */
  private recordedOutcome(entry: Entry): RunResult {
    const key = entry.requestKey;
    if (entry.status === "starting")
      throw new Error(
        `Request key ${key} is already launching (${entry.launchId}); ask for its status rather than launching again`,
      );
    if (entry.status === "unknown")
      throw new Error(
        `Request key ${key} has an unknown outcome (${entry.launchId}): ${entry.error}. ` +
          `Inspect before launching again — this is not a failure, and retrying it may leave two sessions`,
      );
    if (entry.status !== "running")
      throw new Error(
        `Request key ${key} already resolved as ${entry.status}` +
          (entry.error ? `: ${entry.error}` : "") +
          `; use a different key to launch again`,
      );
    if (entry.kind === "task") {
      if (!entry.root)
        throw new Error(`Request key ${key} has no recorded task process`);
      return taskHandle(entry, entry.root.pid);
    }
    if (!entry.peer)
      throw new Error(`Request key ${key} has no recorded session`);
    return entry.peer as unknown as SessionPeer;
  }
  private async startTask(
    entry: Entry,
    argv: string[],
    env: Record<string, string>,
    logMode: "full" | "metadata",
  ): Promise<TaskHandle> {
    const dir = join(this.home, "tasks", entry.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(dir, "output.txt"),
      exitPath = join(dir, "exit.json"),
      startPath = join(dir, "start"),
      specPath = join(dir, "launch.json");
    await writeFile(
      specPath,
      JSON.stringify({
        argv,
        cwd: entry.cwd,
        env,
        outputPath,
        exitPath,
        startPath,
        logHome: this.home,
        launchId: entry.launchId,
        mcpConfigPath: entry.mcpConfigPath,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/task-worker.js", import.meta.url)),
        specPath,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const root = await processRef(child.pid!);
    if (!root) {
      child.kill();
      throw new Error("task owner exited during launch");
    }
    const group = await ownedGroup(child.pid!);
    try {
      await this.registry.update(entry.launchId, {
        root,
        ...(group ? { group } : {}),
        outputPath,
        exitPath,
        status: "running",
      });
      await writeFile(startPath, "start", { mode: 0o600 });
      child.unref();
      const handle = taskHandle(entry, root.pid);
      await this.log.write(
        { event: "started", launch_id: entry.launchId, run: handle },
        logMode,
      );
      return handle;
    } catch (e) {
      await stopTree(root, group);
      await rm(specPath, { force: true });
      throw e;
    }
  }
  private async stopEntry(entry: Entry) {
    try {
      // One second, and best effort: the kill below is what guarantees the
      // stop, so an agent that will not answer must not delay it. Which agents
      // have anything to say, and every precondition on saying it, lives on
      // the row rather than here.
      await AGENTS[entry.runtime].beforeStop?.(entry, Date.now() + 1000);
      await this.stopEntryProcesses(entry);
    } finally {
      if (entry.mcpConfigPath) await rm(entry.mcpConfigPath, { force: true });
      if (entry.identityPath)
        await rm(entry.identityPath, { recursive: true, force: true });
    }
  }
  private async stopEntryProcesses(entry: Entry) {
    if (!entry.root) return;
    if (!(await isSame(entry.root))) {
      for (const ref of entry.descendants ?? [])
        await stopTree(ref, entry.group);
      return;
    }
    // Validate the persisted process identity before ever using a window reference.
    const driver = this.drivers.find((d) => d.id === entry.host);
    if (
      driver &&
      entry.hostRef &&
      (await driver.list()).some(
        (s) => s.hostRef === entry.hostRef && s.pid === entry.root!.pid,
      )
    )
      await driver.stop(entry.hostRef);
    else await stopTree(entry.root, entry.group);
    for (const ref of entry.descendants ?? []) await stopTree(ref, entry.group);
  }
  private async find(id: string): Promise<Entry> {
    const all = await this.registry.all();
    const exact = all.filter((e) => e.id === id);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1)
      throw new Error(
        `Ambiguous durable id: ${exact.map((e) => e.runtime + ":" + e.id).join(", ")}`,
      );
    const peers = all.filter(
      (e) => e.kind === "session" && e.status === "running" && e.peer,
    );
    const named: NamedPeer[] = peers.map((e) => ({
      runtime: runtimeName(e.runtime),
      uuid: e.id,
      rawName: String(e.peer!.name),
      slug: String(e.peer!.canonical_id)
        .split(":")[1]!
        .replace(/\.[^.]*$/, ""),
      // From the durable id, not from the canonical id's last dot-segment.
      // That segment used to BE the three-hex suffix; since Tin Can 1.0.0 the
      // canonical form carries the whole uuid, so the old surgery yielded the
      // entire id and every qualified `slug.suffix` address stopped resolving.
      // It failed quietly, as "unknown", which is why it needed a test.
      suffix: suffixOf(e.id),
      canonicalId: String(e.peer!.canonical_id),
      display: String(e.peer!.name),
    }));
    const result = resolvePeer(named, id);
    if (!result.ok)
      throw new Error(`${result.reason}: ${result.candidates.join(", ")}`);
    return peers[named.indexOf(result.peer)]!;
  }
  async stop(id: string, requester: RequesterId = LOCAL) {
    const entry = await this.find(id);
    assertMayAct(entry, requester);
    await this.stopEntry(entry);
    await this.registry.update(entry.launchId, { status: "stopped" });
    await this.log.write({ event: "stopped", launch_id: entry.launchId });
    return { stopped: true, id: entry.id };
  }
  /**
   * Where to look for the agent's own session registry. Two different uses of an
   * environment meet here, and conflating them is the bug this exists to avoid:
   *
   * - *Spawning* Muster's own helpers — the version probes, `assertClaudePolicy`
   *   and the Codex RPC connection — keeps `hostEnv`. They need a working PATH
   *   and they are Muster's machinery, not the agent's.
   * - *Locating* what the agent wrote must follow the agent's configuration
   *   directory. A launch under an identity relocates that directory to the
   *   per-launch copy, so the session record is inside the copy; resolving
   *   against `hostEnv` would search the operator's own directory, find nothing,
   *   and fail the whole launch deadline with a useless diagnostic.
   *
   * The identity's token is deliberately absent: the resolvers read paths.
   * OpenCode needs no entry — its resolver uses the per-launch loopback HTTP
   * endpoint rather than a configuration path.
   */
  private resolutionEnv(
    runtime: Runtime,
    configHome: string | undefined,
  ): Record<string, string> {
    const key = configHomeVar(runtime);
    if (!configHome || !key) return this.hostEnv;
    return { ...this.hostEnv, [key]: configHome };
  }
  private async refreshed(entry: Entry): Promise<Entry> {
    if (
      entry.kind !== "session" ||
      entry.status !== "running" ||
      !entry.root ||
      !entry.peer
    )
      return entry;
    const deadline = Date.now() + 1500;
    try {
      // The agent's own configuration home, which an identity launch relocates
      // to a per-launch copy — composed here because only Muster knows where
      // that copy went, and handed to the row that knows what to do with it.
      const metadata = await AGENTS[entry.runtime].refreshMetadata(
        entry,
        this.resolutionEnv(
          entry.runtime,
          entry.configHome ?? entry.identityPath,
        ),
        deadline,
      );
      const named = assignNames([
        {
          runtime: runtimeName(entry.runtime),
          uuid: entry.id,
          rawName: metadata.rawName,
        },
      ])[0]!;
      return await this.registry.update(entry.launchId, {
        peer: {
          ...entry.peer,
          state: metadata.state,
          name: named.display,
          canonical_id: named.canonicalId,
          ...(entry.runtime === "opencode"
            ? { server_url: entry.server_url }
            : {}),
        },
      });
    } catch {
      // Any failure is "unreachable", including a connection this refresh never
      // managed to open. Each implementation owns whatever it opened, so there
      // is nothing left for this to close.
      return await this.registry.update(entry.launchId, {
        peer: { ...entry.peer, state: "unreachable" },
      });
    }
  }
  /**
   * Unscoped by requester, unlike stop and output. Filtering the listing is a
   * contract change and nothing can call this remotely yet; the decision belongs
   * with the supported entry point (#44), which is also what would need to
   * choose between hiding other requesters' entries and redacting them.
   */
  /**
   * Counts for the status line a bare `muster` prints at a terminal.
   *
   * Deliberately not `list`. That refreshes every entry, and a refresh removes
   * a terminal entry's identity copy and MCP config and reaches an OpenCode
   * session over HTTP — none of which belongs in the output of typing a bare
   * command. This reads the registry and changes nothing, so what it reports is
   * what was recorded rather than what is running, and the caller says so.
   */
  async summary(): Promise<{ sessions: number }> {
    const entries = await this.registry.all();
    return {
      sessions: entries.filter(
        (e) =>
          e.kind === "session" && ["starting", "running"].includes(e.status),
      ).length,
    };
  }
  async list(kind?: "session" | "task"): Promise<any[]> {
    const entries = await this.registry.all();
    const result = [];
    for (const original of entries) {
      if (kind && kind !== original.kind) continue;
      const e = await this.refreshed(original);
      if (e.mcpConfigPath && !["starting", "running"].includes(e.status))
        await rm(e.mcpConfigPath, { force: true });
      if (e.identityPath && !["starting", "running"].includes(e.status))
        await rm(e.identityPath, { recursive: true, force: true });
      if (e.kind === "session")
        result.push({
          ...e.peer,
          kind: "session",
          ...(e.permissions
            ? { permissions: e.permissions, sandbox: e.sandbox }
            : {}),
          // From the entry, not the peer: a listing must report the same fact a
          // launch result does, and an entry predating the field has none.
          ...(e.enforcement ? { enforcement: e.enforcement } : {}),
          ...(e.identity ? { identity: e.identity } : {}),
          // Absent on an entry written before the field, which is a different
          // fact from an explicit null: that one means Muster resolved nothing
          // and the child chose. Both are more useful than a guess.
          ...(e.model !== undefined
            ? { model: e.model, model_source: e.modelSource ?? null }
            : {}),
          ...(e.idleTimeout ? { idle_timeout: e.idleTimeout } : {}),
          ...(e.ttl ? { ttl: e.ttl } : {}),
          id: e.id,
          runtime: e.peer?.runtime ?? e.runtime,
          state: e.status === "running" ? (e.peer?.state ?? "idle") : e.status,
          host: e.host,
          ...(e.error ? { error: e.error } : {}),
        });
      else {
        let exit: any;
        try {
          exit = JSON.parse(await readFile(e.exitPath!, "utf8"));
        } catch {}
        result.push({
          kind: "task",
          ...(e.mcp ? { mcp: e.mcp } : {}),
          ...(e.mcp_warnings ? { mcp_warnings: e.mcp_warnings } : {}),
          ...(e.permissions
            ? { permissions: e.permissions, sandbox: e.sandbox }
            : {}),
          ...(e.enforcement ? { enforcement: e.enforcement } : {}),
          ...(e.identity ? { identity: e.identity } : {}),
          // Absent on an entry written before the field, which is a different
          // fact from an explicit null: that one means Muster resolved nothing
          // and the child chose. Both are more useful than a guess.
          ...(e.model !== undefined
            ? { model: e.model, model_source: e.modelSource ?? null }
            : {}),
          id: e.id,
          runtime: e.runtime,
          cwd: e.cwd,
          state: exit ? "exited" : e.status,
          ...(e.root ? { pid: e.root.pid } : {}),
          ...(exit ? { exit_code: exit.code, signal: exit.signal } : {}),
          ...(e.error ? { error: e.error } : {}),
        });
      }
    }
    return result;
  }
  async output(id: string, requester: RequesterId = LOCAL) {
    const entry = await this.find(id);
    assertMayAct(entry, requester);
    if (entry.kind !== "task")
      throw new Error("output is available only for task runs");
    if (!entry.outputPath) return "";
    try {
      return await readFile(entry.outputPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    for (const entry of await this.registry.all())
      if (
        entry.host === "pty" &&
        this.owned.has(entry.launchId) &&
        entry.status === "running"
      ) {
        await this.stopEntry(entry);
        await this.registry.update(entry.launchId, { status: "stopped" });
      }
  }
  async hasOwnedPty() {
    return (await this.registry.all()).some(
      (e) =>
        e.host === "pty" &&
        this.owned.has(e.launchId) &&
        e.status === "running",
    );
  }
}
