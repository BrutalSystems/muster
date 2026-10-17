/**
 * The CLI's flag table, apart from muster.ts because that module runs `main()`
 * at import and nothing could test what is defined there.
 */
import type { parseArgs } from "node:util";
/**
 * Every flag any command takes, in one table so `asksForHelp` can tell which
 * flags consume the next word: `--prompt --help` is a prompt, not a request
 * for help.
 */
export const CLI_OPTIONS = {
  prompt: { type: "string" },
  cwd: { type: "string" },
  kind: { type: "string" },
  host: { type: "string" },
  open: { type: "boolean" },
  terminal: { type: "string" },
  format: { type: "string" },
  permissions: { type: "string" },
  sandbox: { type: "string" },
  level: { type: "string" },
  "read-only": { type: "boolean" },
  "write-here": { type: "boolean" },
  unrestricted: { type: "boolean" },
  mcp: { type: "string", multiple: true },
  options: { type: "string", multiple: true },
  "no-mcp": { type: "boolean" },
  plugin: { type: "string", multiple: true },
  model: { type: "string" },
  "idle-timeout": { type: "string" },
  ttl: { type: "string" },
  title: { type: "string" },
  socket: { type: "string" },
  home: { type: "string" },
  "stop-now": { type: "boolean" },
  "no-plugin": { type: "boolean" },
  "request-key": { type: "string" },
  project: { type: "string" },
  identity: { type: "string" },
  agent: { type: "string" },
  "token-env": { type: "string" },
  interactive: { type: "boolean" },
  "on-exit": { type: "string" },
  timeout: { type: "string" },
} as const satisfies NonNullable<Parameters<typeof parseArgs>[0]>["options"];
/**
 * Whether a command's arguments ask for its help: `--help` or `-h` before any
 * `--`, and not the value of a flag that takes one.
 */
export function asksForHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
    const name = arg.startsWith("--") ? arg.slice(2) : undefined;
    const option =
      name && !name.includes("=")
        ? (CLI_OPTIONS as Record<string, { type: string }>)[name]
        : undefined;
    if (option?.type === "string") i++;
  }
  return false;
}
