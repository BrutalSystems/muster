import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Source-qualified configuration IDs, never credentials or server definitions. */
export type McpSelection = {
  mode: "explicit";
  servers: string[];
  claude_ai: false;
};
export function mcpSelection(req: {
  options: readonly string[];
  mcp?: readonly string[];
}): McpSelection | undefined {
  if (!req.options.includes("restrict-mcp")) return;
  if (req.mcp === undefined)
    throw new Error(
      "--options restrict-mcp requires an explicit --mcp selection or --no-mcp (mcp: [] through MCP)",
    );
  return {
    mode: "explicit",
    servers: [...new Set(req.mcp)].sort().map((name) => `muster:${name}`),
    claude_ai: false,
  };
}
/** Fail closed on runtimes predating the verified connector controls. */
export async function assertRestrictedClaudeVersion(
  env: NodeJS.ProcessEnv,
  minimumPatch = 305,
  command = "claude",
): Promise<void> {
  let version: string;
  try {
    const { stdout } = await promisify(execFile)(command, ["--version"], {
      env,
      timeout: 4000,
      maxBuffer: 16384,
    });
    version = stdout.trim();
  } catch {
    throw new Error(
      "restrict-mcp requires a verifiable Claude Code version (2.1.305 or later)",
    );
  }
  const match = /^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)$/.exec(version);
  const parts = match?.slice(1).map(Number);
  if (
    !parts ||
    parts[0]! < 2 ||
    (parts[0] === 2 &&
      (parts[1]! < 1 || (parts[1] === 1 && parts[2]! < minimumPatch)))
  )
    throw new Error("restrict-mcp requires Claude Code 2.1.305 or later");
}
