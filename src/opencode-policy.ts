import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import {
  resolveModel,
  resolvePermissions,
  runtimeArgs,
  type RunRequest,
} from "./guard.js";
import type { PreparedMcp } from "./mcp.js";
import type { SelectedPlugin } from "./plugins.js";
import { openCodeProviders } from "./providers.js";

const exec = promisify(execFile);
const DEBUG_CONFIG_ERROR = "Cannot verify effective OpenCode MCP configuration";
const ISOLATION_ERROR =
  "OpenCode MCP isolation could not be verified; refusing launch";
const INLINE_CONFIG_ERROR =
  "Cannot safely compose the existing inline OpenCode config";

export type OpenCodeLaunch = {
  argv: string[];
  envPatch: Record<string, string>;
  port?: number;
  serverUrl?: string;
};

type JsonRecord = Record<string, unknown>;
type EffectiveMcp = { server: PreparedMcp; name: string };

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function commandTimeout(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(DEBUG_CONFIG_ERROR);
  return Math.min(4000, remaining);
}

async function resolvedConfig(
  env: Record<string, string>,
  cwd: string,
  deadline: number,
  errorMessage = DEBUG_CONFIG_ERROR,
): Promise<JsonRecord> {
  try {
    const { stdout } = await exec("opencode", ["--pure", "debug", "config"], {
      env,
      cwd,
      timeout: commandTimeout(deadline),
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) throw new Error("invalid config");
    return value;
  } catch {
    // OpenCode diagnostics and resolved config may contain credentials. Never
    // include child output, inline config, or the underlying error here.
    throw new Error(errorMessage);
  }
}

function fixedEnvironmentName(server: string, key: string) {
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("hex").toUpperCase();
  return `MUSTER_OPENCODE_MCP_${encode(server)}_${encode(key)}`;
}

function environmentReference(name: string) {
  return `{env:${name}}`;
}

export function openCodeMcpConfig(
  server: PreparedMcp,
): Record<string, unknown> {
  const config = server.config;
  if (config.command) {
    const environment = Object.fromEntries([
      ...Object.keys(config.env).map((key) => [
        key,
        environmentReference(fixedEnvironmentName(server.name, key)),
      ]),
      ...config.env_vars.map((key) => [key, environmentReference(key)]),
    ]);
    return {
      type: "local",
      command: [config.command, ...config.args],
      ...(Object.keys(environment).length ? { environment } : {}),
      timeout: config.startup_timeout_sec * 1000,
      enabled: true,
    };
  }
  return {
    type: "remote",
    url: config.url!,
    ...(config.bearer_token_env_var
      ? {
          headers: {
            Authorization: `Bearer ${environmentReference(config.bearer_token_env_var)}`,
          },
        }
      : {}),
    timeout: config.startup_timeout_sec * 1000,
    enabled: true,
  };
}

function effectiveMcp(
  selected: PreparedMcp[],
  inheritedMcpNames: string[],
): EffectiveMcp[] {
  const used = new Set(inheritedMcpNames);
  return selected.map((server) => {
    let name = server.name;
    let suffix = 0;
    while (used.has(name)) name = `muster_${server.name}_${++suffix}`;
    used.add(name);
    return { server, name };
  });
}

function mcpPolicy(selected: PreparedMcp[], inheritedMcpNames: string[]) {
  const effective = effectiveMcp(selected, inheritedMcpNames);
  const mcp: Record<string, Record<string, unknown>> = Object.fromEntries(
    inheritedMcpNames.map((name) => [name, { enabled: false }]),
  );
  const tools: Record<string, boolean> = Object.fromEntries(
    inheritedMcpNames.map((name) => [`${name}_*`, false]),
  );
  for (const { server, name } of effective) {
    mcp[name] = openCodeMcpConfig(server);
    tools[`${name}_*`] = true;
    for (const tool of server.excludedTools) tools[`${name}_${tool}`] = false;
  }
  return { effective, mcp, tools };
}

/**
 * OpenCode's built-in tool ids, as reported by its own tool listing. Needed
 * because a wildcard `*` permission entry suppresses MCP tools outright — an
 * explicit allow for the tool does not rescue it — so a launch that selects
 * MCP servers has to name the built-ins it denies instead of leaning on `*`.
 * A built-in added by a future OpenCode release is not in this list and would
 * not be denied by it; see the isolation note in the README.
 */
const OPENCODE_BUILTIN_TOOLS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "todoread",
  "websearch",
  "skill",
  "apply_patch",
  "patch",
  "list",
  "lsp",
  "external_directory",
];

function permissions(
  req: RunRequest,
  config: Config,
  tools: Record<string, boolean>,
) {
  const policy = resolvePermissions(req, config);
  // A selected MCP server cannot coexist with a wildcard entry, so the
  // built-ins are enumerated instead. Without one, `*` still backstops.
  const selectsMcp = Object.values(tools).some((enabled) => enabled);
  const fallback =
    policy.permissions === "bypass"
      ? "allow"
      : policy.permissions === "auto"
        ? "ask"
        : "deny";
  const permission: Record<string, "allow" | "ask" | "deny"> =
    selectsMcp && policy.permissions !== "bypass"
      ? Object.fromEntries(
          OPENCODE_BUILTIN_TOOLS.map((name) => [name, fallback]),
        )
      : { "*": fallback };
  if (policy.permissions !== "bypass") {
    for (const name of [
      "read",
      "glob",
      "grep",
      "list",
      "lsp",
      "todoread",
      "question",
    ])
      permission[name] = "allow";
  }
  if (policy.permissions === "deny" || policy.sandbox === "read-only") {
    for (const name of [
      "edit",
      "bash",
      "task",
      "external_directory",
      "webfetch",
      "websearch",
    ])
      permission[name] = "deny";
  } else if (policy.permissions === "auto") {
    for (const name of ["external_directory", "webfetch", "websearch"])
      permission[name] = "deny";
    permission.question = "allow";
  }
  for (const [pattern, enabled] of Object.entries(tools))
    permission[pattern] = enabled ? "allow" : "deny";
  return permission;
}

export function openCodeConfig(
  req: RunRequest,
  config: Config,
  selected: PreparedMcp[],
  inheritedMcpNames: string[],
  plugins: SelectedPlugin[] = [],
  source: NodeJS.ProcessEnv = {},
): Record<string, unknown> {
  const { mcp, tools } = mcpPolicy(selected, inheritedMcpNames);
  // An `args`-named model is already forwarded onto the child's argv by
  // `runtimeArgs`, so it must not also enter the verified overlay: that would
  // deliver one model by two routes and rewrite a config the caller never
  // changed. The overlay carries only what `--model` or `[opencode] model`
  // named, exactly as before this resolver existed.
  const resolved = resolveModel(req, config);
  const model =
    resolved && resolved.origin !== "args"
      ? resolved.model
      : config.opencode.model;
  const provider = openCodeProviders(config, source);
  return {
    share: "disabled",
    // Providers merge with whatever the child resolves for itself, so naming
    // one here adds a definition rather than displacing the operator's.
    ...(Object.keys(provider).length > 0 && { provider }),
    ...(model !== undefined && { model }),
    server: { hostname: "127.0.0.1" },
    permission: permissions(req, config, tools),
    tools,
    mcp,
    // Absent, OpenCode discovers plugins from the user and project plugin
    // directories; `--pure` is what suppresses them. A non-empty array names
    // the operator's selection but does NOT displace project-local discovery,
    // so selecting any plugin also admits whatever the target repository
    // ships under .opencode/plugin. An empty array is the isolated case and
    // is paired with `--pure` at launch.
    plugin: plugins.map((plugin) => plugin.url),
  };
}

function mergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map(
      (key) => {
        const original = base[key];
        const replacement = override[key];
        return [
          key,
          isRecord(original) && isRecord(replacement)
            ? mergeRecords(original, replacement)
            : replacement === undefined
              ? original
              : replacement,
        ];
      },
    ),
  );
}

function composeInlineConfig(env: Record<string, string>, overlay: JsonRecord) {
  let inherited: JsonRecord = {};
  const source = env.OPENCODE_CONFIG_CONTENT;
  if (source !== undefined) {
    try {
      const value: unknown = JSON.parse(source);
      if (!isRecord(value)) throw new Error("invalid inline config");
      inherited = value;
    } catch {
      throw new Error(INLINE_CONFIG_ERROR);
    }
  }
  const inheritedMcp = inherited.mcp;
  const overlayMcp = overlay.mcp;
  if (
    (inheritedMcp !== undefined && !isRecord(inheritedMcp)) ||
    !isRecord(overlayMcp)
  )
    throw new Error(INLINE_CONFIG_ERROR);
  return {
    ...inherited,
    ...overlay,
    // Preserve inherited inline definitions so provider/model configuration
    // remains intact, but apply Muster's enabled state and selected definitions.
    mcp: mergeRecords(inheritedMcp ?? {}, overlayMcp),
  };
}

function envPatch(
  selected: PreparedMcp[],
  overlay: JsonRecord,
  env: Record<string, string>,
) {
  const config = composeInlineConfig(env, overlay);
  const patch: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  for (const server of selected)
    for (const [key, value] of Object.entries(server.config.env))
      patch[fixedEnvironmentName(server.name, key)] = value;
  return patch;
}

function sameKeys(actual: JsonRecord, expected: JsonRecord) {
  return (
    JSON.stringify(Object.keys(actual).sort()) ===
    JSON.stringify(Object.keys(expected).sort())
  );
}

function resolveExpectedEnvironment(
  value: unknown,
  env: Record<string, string>,
): unknown {
  if (typeof value === "string")
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
      env[name] === undefined ? "" : env[name],
    );
  if (Array.isArray(value))
    return value.map((item) => resolveExpectedEnvironment(item, env));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveExpectedEnvironment(item, env),
      ]),
    );
  return value;
}

function equivalentMcpDefinition(
  actual: JsonRecord,
  expected: JsonRecord,
  env: Record<string, string>,
) {
  const resolved = resolveExpectedEnvironment(expected, env);
  return (
    isRecord(resolved) &&
    sameKeys(actual, resolved) &&
    JSON.stringify(actual) === JSON.stringify(resolved)
  );
}

function denyOnly(value: unknown): boolean {
  if (value === "deny") return true;
  return (
    isRecord(value) &&
    Object.values(value).length > 0 &&
    Object.values(value).every(denyOnly)
  );
}

async function verifyOverlay(
  overlay: JsonRecord,
  selected: PreparedMcp[],
  inheritedMcpNames: string[],
  env: Record<string, string>,
  cwd: string,
  deadline: number,
) {
  const patch = envPatch(selected, overlay, env);
  const effectiveConfig = await resolvedConfig(
    { ...env, ...patch },
    cwd,
    deadline,
    ISOLATION_ERROR,
  );
  const actualMcp = isRecord(effectiveConfig.mcp) ? effectiveConfig.mcp : {};
  const actualTools = isRecord(effectiveConfig.tools)
    ? effectiveConfig.tools
    : {};
  const actualPermission = isRecord(effectiveConfig.permission)
    ? effectiveConfig.permission
    : {};
  const expectedPermission = isRecord(overlay.permission)
    ? overlay.permission
    : {};
  const expected = mcpPolicy(selected, inheritedMcpNames);
  const selectedNames = new Set(expected.effective.map(({ name }) => name));
  for (const name of inheritedMcpNames) {
    const value = actualMcp[name];
    if (!isRecord(value) || value.enabled !== false)
      throw new Error(ISOLATION_ERROR);
  }
  for (const { server, name } of expected.effective) {
    const value = actualMcp[name];
    if (
      !isRecord(value) ||
      !equivalentMcpDefinition(value, openCodeMcpConfig(server), {
        ...env,
        ...patch,
      })
    )
      throw new Error(ISOLATION_ERROR);
  }
  for (const [name, value] of Object.entries(actualMcp))
    if (
      !selectedNames.has(name) &&
      !inheritedMcpNames.includes(name) &&
      (!isRecord(value) || value.enabled !== false)
    )
      throw new Error(ISOLATION_ERROR);
  for (const [pattern, enabled] of Object.entries(expected.tools))
    if (actualTools[pattern] !== enabled) throw new Error(ISOLATION_ERROR);
  for (const [pattern, enabled] of Object.entries(actualTools))
    if (enabled === true && expected.tools[pattern] !== true)
      throw new Error(ISOLATION_ERROR);
  for (const [pattern, action] of Object.entries(expectedPermission))
    if (actualPermission[pattern] !== action) throw new Error(ISOLATION_ERROR);
  for (const [pattern, action] of Object.entries(actualPermission))
    if (!(pattern in expectedPermission) && !denyOnly(action))
      throw new Error(ISOLATION_ERROR);
  if (effectiveConfig.share !== "disabled") throw new Error(ISOLATION_ERROR);
  const expectedServer = overlay.server;
  if (
    !isRecord(expectedServer) ||
    !isRecord(effectiveConfig.server) ||
    JSON.stringify(effectiveConfig.server) !== JSON.stringify(expectedServer)
  )
    throw new Error(ISOLATION_ERROR);
  return patch;
}

export async function openCodeMcpNames(
  env: Record<string, string>,
  cwd: string,
  deadline: number,
): Promise<string[]> {
  const config = await resolvedConfig(env, cwd, deadline);
  if (config.mcp === undefined) return [];
  if (!isRecord(config.mcp)) throw new Error(DEBUG_CONFIG_ERROR);
  return Object.keys(config.mcp);
}

export async function openCodeSessionLaunch(
  req: RunRequest,
  config: Config,
  selected: PreparedMcp[],
  inheritedMcpNames: string[],
  port: number,
  env: Record<string, string>,
  cwd: string,
  deadline: number,
  plugins: SelectedPlugin[] = [],
  source: NodeJS.ProcessEnv = {},
): Promise<OpenCodeLaunch> {
  const extra = runtimeArgs(req);
  const policy = resolvePermissions(req, config);
  const overlay = {
    ...openCodeConfig(
      req,
      config,
      selected,
      inheritedMcpNames,
      plugins,
      source,
    ),
    server: { hostname: "127.0.0.1", port },
  };
  const patch = await verifyOverlay(
    overlay,
    selected,
    inheritedMcpNames,
    env,
    cwd,
    deadline,
  );
  return {
    argv: [
      "opencode",
      ...(plugins.length === 0 ? ["--pure"] : []),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      ...(policy.permissions === "auto" ? ["--auto"] : []),
      ...extra,
      "--prompt",
      req.prompt,
    ],
    envPatch: patch,
    port,
    serverUrl: `http://127.0.0.1:${port}`,
  };
}

export async function openCodeTaskLaunch(
  req: RunRequest,
  config: Config,
  selected: PreparedMcp[],
  inheritedMcpNames: string[],
  env: Record<string, string>,
  cwd: string,
  deadline: number,
  plugins: SelectedPlugin[] = [],
  source: NodeJS.ProcessEnv = {},
): Promise<OpenCodeLaunch> {
  const extra = runtimeArgs(req);
  const policy = resolvePermissions(req, config);
  const overlay = openCodeConfig(
    req,
    config,
    selected,
    inheritedMcpNames,
    plugins,
    source,
  );
  const patch = await verifyOverlay(
    overlay,
    selected,
    inheritedMcpNames,
    env,
    cwd,
    deadline,
  );
  return {
    argv: [
      "opencode",
      "run",
      "--format",
      "json",
      ...(plugins.length === 0 ? ["--pure"] : []),
      ...(policy.permissions === "auto" ? ["--auto"] : []),
      ...extra,
      "--",
      req.prompt,
    ],
    envPatch: patch,
  };
}

type Version = {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
};

function parseVersion(value: string): Version | undefined {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

function atLeast(actual: Version, minimum: Version) {
  for (const key of ["major", "minor", "patch"] as const) {
    if (actual[key] !== minimum[key]) return actual[key] > minimum[key];
  }
  return !actual.prerelease || minimum.prerelease;
}

export async function assertOpenCodeVersion(
  env: Record<string, string>,
  minimum: string,
  deadline: number,
): Promise<void> {
  const required = parseVersion(minimum);
  if (!required)
    throw new Error(`Invalid required OpenCode version: ${minimum}`);
  let detected: string;
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("deadline");
    const { stdout } = await exec("opencode", ["--version"], {
      env,
      timeout: Math.min(4000, remaining),
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    detected = stdout.trim();
  } catch {
    throw new Error(
      `OpenCode executable not found or version could not be determined; requires ${minimum}+`,
    );
  }
  const actual = parseVersion(detected);
  if (!actual)
    throw new Error(
      `Unrecognized OpenCode version; requires compatible version ${minimum}+`,
    );
  if (!atLeast(actual, required))
    throw new Error(
      `OpenCode ${detected} is unsupported; requires OpenCode ${minimum} or newer`,
    );
}
