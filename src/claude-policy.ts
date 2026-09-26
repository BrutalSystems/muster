import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { PreparedMcp } from "./mcp.js";

export function claudeMcpConfig(servers: PreparedMcp[], bridgePath?: string) {
  if (servers.length && !bridgePath)
    throw new Error("Missing MCP bridge configuration");
  return {
    mcpServers: Object.fromEntries(
      servers.map(({ name, config }) => [
        name,
        {
          type: "stdio",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../dist/mcp-bridge.js", import.meta.url)),
            bridgePath!,
            name,
          ],
          env: Object.fromEntries(
            [
              ...config.env_vars,
              ...(config.bearer_token_env_var
                ? [config.bearer_token_env_var]
                : []),
            ].map((key) => [key, "${" + key + "}"]),
          ),
        },
      ]),
    ),
  };
}

/** Claude's CLI cannot report all effective enterprise policy before starting.
 * Refuse detected managed sources rather than pretending inline settings win. */
export async function assertClaudePolicy(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const home = env.HOME ?? homedir();
  const system =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : "/etc/claude-code";
  const files = [
    join(system, "managed-settings.json"),
    join(system, "managed-mcp.json"),
    join(home, ".claude", "remote-settings.json"),
  ];
  try {
    for (const file of await readdir(join(system, "managed-settings.d")))
      if (file.endsWith(".json"))
        files.push(join(system, "managed-settings.d", file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const file of files) {
    try {
      const settings = JSON.parse(await readFile(file, "utf8"));
      if (settings && Object.keys(settings).length)
        throw new Error(
          `Managed Claude policy detected at ${file}; effective sandbox policy cannot be verified by this v1 launcher`,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await promisify(execFile)(
        "defaults",
        ["read", "com.anthropic.claudecode"],
        { timeout: 1000, env },
      );
      if (stdout.trim())
        throw new Error(
          "Managed Claude preferences detected; effective sandbox policy cannot be verified by this v1 launcher",
        );
    } catch (e) {
      if ((e as { code?: unknown }).code !== 1) throw e;
    }
  }
}
