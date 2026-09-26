import { execFile } from "node:child_process";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import type { PreparedMcp } from "./mcp.js";
const exec = promisify(execFile);

export function codexMcpConfig(server: PreparedMcp) {
  const c = server.config;
  return {
    ...(c.command
      ? { command: c.command, args: c.args, env: c.env, env_vars: c.env_vars }
      : {
          url: c.url!,
          ...(c.bearer_token_env_var
            ? { bearer_token_env_var: c.bearer_token_env_var }
            : {}),
        }),
    enabled: true,
    required: server.required,
    enabled_tools: c.tools,
    disabled_tools: [],
    startup_timeout_sec: c.startup_timeout_sec,
    default_tools_approval_mode: "approve",
  };
}

export async function codexPolicyArgs(
  env: NodeJS.ProcessEnv,
  cwd: string,
  deadline = Date.now() + 8000,
  selected: PreparedMcp[] = [],
  /**
   * True when the launch itself will pass `--ignore-user-config`, as task
   * launches do. Enumeration has to agree with the launch: a server disabled
   * here that the launch never loads is not merely redundant, it is harmful.
   * `-c mcp_servers.<name>.enabled=false` CREATES the key when nothing else
   * defines it, leaving an entry with no command and no url, and Codex then
   * refuses the whole config with "invalid transport".
   */
  ignoreUserConfig = false,
): Promise<string[]> {
  const args = [
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "apps",
    "--disable",
    "skill_mcp_dependency_install",
    "-c",
    "notify=[]",
  ];
  async function list(extra: string[]) {
    try {
      const { stdout } = await exec(
        "codex",
        [...extra, "mcp", "list", "--json"],
        {
          env,
          cwd,
          timeout: Math.max(1, Math.min(4000, deadline - Date.now())),
          maxBuffer: 1024 * 1024,
        },
      );
      const value: unknown = JSON.parse(stdout);
      if (!Array.isArray(value))
        throw new Error("Cannot verify effective Codex MCP configuration");
      return value as Array<{ name: string; enabled?: boolean }>;
    } catch {
      throw new Error("Cannot verify effective Codex MCP configuration");
    }
  }
  const inherited = await list(args);
  const usedNames = new Set(inherited.map((s) => s.name));
  // Nothing to disable when the launch ignores the config the servers come
  // from: they are already absent. Disabling one anyway would CREATE the key
  // with neither command nor url, and Codex refuses the whole config with
  // "invalid transport". The names are still reserved below, so a requested
  // server never collides with one the user happens to have defined.
  if (!ignoreUserConfig)
    for (const server of inherited) {
      if (
        typeof server.name !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(server.name)
      )
        throw new Error(
          "Cannot safely disable an inherited MCP server with a non-simple name",
        );
      args.push("-c", `mcp_servers.${server.name}.enabled=false`);
    }
  const expected: string[] = [];
  for (const server of selected) {
    let name = server.name;
    let suffix = 0;
    // Config layers merge nested maps. A fresh key prevents inherited env,
    // credentials or per-tool policy from surviving the requested definition.
    while (usedNames.has(name)) name = `muster_${server.name}_${++suffix}`;
    usedNames.add(name);
    expected.push(name);
    args.push(
      "-c",
      `mcp_servers.${name}=${TOML.stringify.value(codexMcpConfig(server))}`,
    );
  }
  const enabled = (await list(args))
    .filter((s) => s.enabled !== false)
    .map((s) => s.name)
    .sort();
  expected.sort();
  // `codex mcp list` has no --ignore-user-config of its own, so when the launch
  // ignores the user config the listing still reports its servers. They cannot
  // reach the child — the flag is the guarantee — so the check is that every
  // requested server is present, rather than that nothing else is.
  const isolated = ignoreUserConfig
    ? expected.every((name) => enabled.includes(name))
    : JSON.stringify(enabled) === JSON.stringify(expected);
  if (!isolated)
    throw new Error(
      "Inherited Codex MCP servers remain enabled or requested servers are missing; refusing launch",
    );
  return args;
}
