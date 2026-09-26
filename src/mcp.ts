import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "./config.js";
import type { RunRequest } from "./guard.js";

export const mcpName = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const environmentName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const mcpServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z
      .string()
      .url()
      .refine((s) => /^https?:\/\//.test(s), "MCP URL must use HTTP(S)")
      .optional(),
    env: z.record(z.string()).default({}),
    env_vars: z.array(environmentName).default([]),
    bearer_token_env_var: environmentName.optional(),
    tools: z.array(mcpName).min(1),
    required: z.boolean().default(false),
    startup_timeout_sec: z.number().positive().max(60).default(10),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!!v.command === !!v.url)
      ctx.addIssue({
        code: "custom",
        message: "MCP server requires exactly one of command or url",
      });
    if (v.command && v.bearer_token_env_var)
      ctx.addIssue({
        code: "custom",
        message: "bearer_token_env_var requires an HTTP server",
      });
    if (
      v.url &&
      (v.args.length || Object.keys(v.env).length || v.env_vars.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "args, env and env_vars require a stdio server",
      });
  });
export type McpServer = z.infer<typeof mcpServerSchema>;
export type SelectedMcp = {
  name: string;
  config: McpServer;
  required: boolean;
};
export type PreparedMcp = SelectedMcp & { excludedTools: string[] };
export type McpSummary = { mcp: string[]; mcp_warnings?: string[] };

export function selectMcp(req: RunRequest, config: Config): SelectedMcp[] {
  // Personal defaults apply to sessions, not unattended one-shot tasks.
  const names = req.mcp ?? (req.kind === "session" ? config.default_mcp : []);
  return [...new Set(names)].map((name) => {
    const server = Object.hasOwn(config.mcp_servers, name)
      ? config.mcp_servers[name]
      : undefined;
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    return {
      name,
      config: server,
      required: req.mcp !== undefined || server.required,
    };
  });
}
export function mcpEnvironment(
  servers: SelectedMcp[],
  base: Record<string, string>,
  source: NodeJS.ProcessEnv,
) {
  const env = { ...base };
  for (const { config } of servers) {
    for (const key of [
      ...config.env_vars,
      ...(config.bearer_token_env_var ? [config.bearer_token_env_var] : []),
    ]) {
      if (source[key] !== undefined) env[key] = source[key]!;
    }
  }
  return env;
}
function serverEnv(config: McpServer, env: NodeJS.ProcessEnv) {
  const result: Record<string, string> = { ...config.env };
  for (const key of config.env_vars) {
    if (env[key] === undefined)
      throw new Error(`Missing MCP environment variable: ${key}`);
    result[key] = env[key]!;
  }
  return result;
}
function headers(
  config: McpServer,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!config.bearer_token_env_var) return {};
  const value = env[config.bearer_token_env_var];
  if (!value) throw new Error("Missing MCP bearer token environment variable");
  return { Authorization: `Bearer ${value}` };
}
export function mcpTransport(
  config: McpServer,
  env: Record<string, string>,
  cwd: string,
) {
  const transport = config.command
    ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...env, ...serverEnv(config, env) },
        cwd,
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: headers(config, env) },
      });
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", () => {});
  return transport;
}
export async function prepareMcp(
  selected: SelectedMcp[],
  env: Record<string, string>,
  cwd: string,
  deadline: number,
) {
  const servers: PreparedMcp[] = [],
    warnings: string[] = [];
  for (const server of selected) {
    const client = new Client(
      { name: "muster-preflight", version: "1" },
      { capabilities: {} },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let diagnostic =
      "startup or tool discovery failed (check executable, credentials and server configuration)";
    try {
      const timeout = Math.min(
        server.config.startup_timeout_sec * 1000,
        deadline - Date.now(),
      );
      if (timeout <= 0) throw new Error("deadline");
      const transport = mcpTransport(server.config, env, cwd);
      const discover = async () => {
        await client.connect(transport);
        const names = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const tool of page.tools) {
            if (!mcpName.safeParse(tool.name).success)
              throw new Error("Unsupported tool name");
            names.add(tool.name);
          }
          cursor = page.nextCursor;
        } while (cursor);
        const missing = server.config.tools.filter((name) => !names.has(name));
        if (missing.length) {
          diagnostic = `configured tools not found: ${missing.join(", ")}`;
          throw new Error("missing tools");
        }
        return [...names].filter((name) => !server.config.tools.includes(name));
      };
      const excludedTools = await Promise.race([
        discover(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeout);
        }),
      ]);
      servers.push({ ...server, excludedTools });
    } catch {
      // Server errors may include tokens or environment values; never log them.
      const message = `MCP server ${server.name}: ${diagnostic}`;
      if (server.required) throw new Error(message);
      warnings.push(`${message}; skipped optional default`);
    } finally {
      if (timer) clearTimeout(timer);
      await client.close().catch(() => {});
    }
  }
  return {
    servers,
    summary: {
      mcp: servers.map((s) => s.name),
      ...(warnings.length ? { mcp_warnings: warnings } : {}),
    } as McpSummary,
  };
}
