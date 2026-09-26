/**
 * The `run`, `list`, `stop` and `output` tools exactly as the MCP server
 * advertises them.
 *
 * Extracted from `src/muster.ts` so it can be ASSERTED against `runSchema`
 * rather than kept in step by hand. One request shape had two hand-maintained
 * descriptions and nothing checked that they agreed, and four fields drifted
 * across two branches: `level`, then `identity`, `model` and `plugin`. Because
 * the schema is `additionalProperties: false`, an omitted key is not merely
 * undocumented — a conformant client is told it is INVALID.
 * `test/mcp-run-schema.test.ts` is what ends that class.
 */
export const MCP_TOOLS = [
  {
    name: "run",
    description:
      "Launch an instructed agent. Sessions return only when reachable; tasks return a non-messageable run handle.",
    inputSchema: {
      type: "object",
      properties: {
        runtime: {
          type: "string",
          enum: ["codex", "claude", "opencode"],
        },
        prompt: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        kind: {
          type: "string",
          enum: ["session", "task"],
          default: "session",
        },
        host: {
          type: "string",
          enum: ["auto", "tmux", "pty", "macos-terminal"],
        },
        open: {
          type: "boolean",
          description:
            "Open the tmux session in a terminal viewer (macOS only).",
        },
        terminal: {
          type: "string",
          enum: ["auto", "terminal", "iterm2", "ghostty"],
          description: "Viewer app; requires open. Auto uses Terminal.app.",
        },
        permissions: {
          type: "string",
          enum: ["auto", "deny", "bypass"],
          description:
            "Defaults to config (deny). Auto requires workspace-write; bypass requires authorized full-access.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "full-access"],
          description:
            "Defaults to config (read-only). Full access requires config authorization.",
        },
        level: {
          type: "string",
          enum: ["read", "work", "open"],
          description:
            "A spelling of a legal permissions/sandbox pair: read is deny + read-only, work is auto + workspace-write, open is bypass + full-access. Naming a level and either flag is an error.",
        },
        mcp: {
          type: "array",
          items: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          description:
            "Configured MCP server names. Omit for session defaults; [] disables all. Tasks have no defaults.",
        },
        options: {
          type: "array",
          items: { type: "string", enum: ["auto-approve-path"] },
          description:
            "Muster-side launch options. auto-approve-path records the launch directory as trusted in the profile the agent will use, so its one-time dialog does not block the launch; refused for a runtime with no trust gate, and refused if the directory ships hooks or MCP servers. Not expressible remotely.",
        },
        project: {
          type: "string",
          pattern: "^[a-zA-Z0-9_-]+$",
          description:
            "A project named in config.toml, used instead of cwd. Naming both is an error.",
        },
        requestKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Caller-owned identity for this launch. Repeating it returns the launch it already produced instead of starting another; repeating it with different parameters is refused.",
        },
        plugin: {
          type: "array",
          items: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          description:
            "Configured OpenCode plugin names. Omit for session defaults; [] disables all. OpenCode only.",
        },
        model: {
          type: "string",
          minLength: 1,
          description:
            "Model for the launch. A bare model id for claude and codex; PROVIDER/MODEL for opencode, where it overrides the configured [opencode] model. Recorded on the run and reported by `list`.",
        },
        idleTimeout: {
          type: "string",
          description:
            "Stop this tmux session after the given inactivity, as 90s/30m/4h, or 'off'. Defaults to 30m. Refused for tasks and for pty or macos-terminal hosts, which do not outlive their parent.",
        },
        ttl: {
          type: "string",
          description:
            "Stop this tmux session the given duration after launch regardless of activity, as 90s/30m/4h, or 'off'. Off by default.",
        },
        identity: {
          type: "string",
          pattern: "^[a-zA-Z0-9_-]+$",
          description:
            "A named identity created by `muster setup-identity`; the agent runs as that account instead of inheriting the ambient environment. A non-local requester is bounded by its profile's identities.",
        },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["runtime", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "list",
    description:
      "List Muster-owned sessions and tasks, including host capabilities.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["session", "task"] } },
      additionalProperties: false,
    },
  },
  {
    name: "stop",
    description:
      "Stop a Muster-owned run by durable id or unambiguous peer name.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "output",
    description: "Read captured output from a task run.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;
/**
 * runSchema keys deliberately absent from the advertised `run` inputSchema.
 *
 * Empty today, and it stays here rather than being implicit: adding a field to
 * runSchema without either advertising it or naming it here — with a reason —
 * fails the drift test. That is the point. An entry is a decision that MCP
 * callers may not set the field, not a place to park an oversight.
 */
export const RUN_MCP_OMITTED: readonly string[] = [];
