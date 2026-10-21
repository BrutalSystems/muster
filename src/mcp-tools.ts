/**
 * The `run`, `list`, `stop`, `output` and `title` tools exactly as the MCP server
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
          description:
            "Viewer app; requires open. terminal, iterm2, ghostty, or a name defined under [open.apps] in config. Auto uses the configured default.",
        },
        permissions: {
          type: "string",
          enum: ["auto", "deny", "bypass"],
          description:
            "Seals the launch. Defaults to config, else deny (claude: normal when config names neither). Auto requires workspace-write; bypass requires authorized full-access.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "full-access"],
          description:
            "Seals the launch. Defaults to config, else read-only (claude: normal when config names neither). Full access requires config authorization.",
        },
        level: {
          type: "string",
          enum: ["read", "work", "normal", "open"],
          description:
            "normal (claude's default, claude only) opens the agent exactly as a person would by hand: the profile's rules, CLAUDE.md, permissions, hooks, plugins and MCP servers. read (deny + read-only), work (auto + workspace-write) and open (bypass + full-access) are sealed: muster's settings replace the profile's, so no rules or CLAUDE.md load. Naming a level and permissions or sandbox is an error.",
        },
        mcp: {
          type: "array",
          items: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          description:
            "Configured MCP server names. Omit for session defaults; normal/inherit-profile launches and tasks have no Muster defaults. [] selects no Muster servers; profile servers remain in normal/inherit-profile mode unless restrict-mcp is set. restrict-mcp requires an explicit array, including [] for none.",
        },
        options: {
          type: "array",
          items: {
            type: "string",
            anyOf: [
              {
                enum: [
                  "auto-approve-path",
                  "accept-bypass-warning",
                  "inherit-profile",
                  "restrict-mcp",
                ],
              },
              { pattern: "^(metadata|provenance|guard)=" },
            ],
          },
          description:
            "Muster-side launch options. guard=<bundle-file> attaches a local version-1 guard bundle to an inherited Claude launch; scripts are snapshotted, hooks fail closed, and only immutable IDs/digests/counts are returned. Repeated guard entries are supported. See docs/cli.md. restrict-mcp requires Claude inherit-profile: only explicitly selected Muster MCP servers load; all account connectors are disabled. Requires Claude Code 2.1.305 or later. inherit-profile preserves Claude/Codex profile configuration with explicit bypass/full-access permissions (level open), gated by allow_dangerous_flags. auto-approve-path records the launch directory as trusted in the profile the agent will use, so its one-time dialog does not block the launch; refused for a runtime with no trust gate, and refused if the directory ships hooks or MCP servers. accept-bypass-warning accepts Claude's one-time Bypass Permissions warning for a bypass launch (level open); refused for other runtimes and without bypass permissions. metadata=<JSON> adds up to 32 string facts (keys 1-64 UTF-8 bytes, values at most 1024 bytes, canonical JSON at most 16 KiB). provenance=<JSON> requires namespace, session, launcher, parent; IDs use [A-Za-z0-9._:-]{1,128}, parent is an ID in that namespace or explicit null for a caller-declared root. Each structured option occurs once; duplicate JSON keys are refused. Values are informational, immutable, and returned by run/list/wait; never put secrets here. Not expressible remotely.",
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
        resume: {
          type: "string",
          description:
            "Claude only: reopen this existing session (its UUID) instead of starting a new one; the prompt is its next message, and the run reports the same session id. Refused while that session is running, for a remote requester, and with an identity.",
        },
        forkSession: {
          type: "boolean",
          description:
            "With resume: continue the conversation under a new session id, leaving the original as it was. Allowed while the original is running.",
        },
        idleTimeout: {
          type: "string",
          description:
            "Stop this tmux session after the given inactivity, as 90s/30m/4h, or 'off'. Off by default. Refused for tasks and for pty or macos-terminal hosts, which do not outlive their parent.",
        },
        ttl: {
          type: "string",
          description:
            "Stop this tmux session the given duration after launch regardless of activity, as 90s/30m/4h, or 'off'. Off by default.",
        },
        title: {
          type: "string",
          description:
            "Terminal title for this tmux session, shown by any terminal attached to it. Defaults to the session's name and runtime once it is reachable; the agent's own title is shown instead only with [session] title_from_agent. Control characters are stripped and it is capped at 100 characters. Refused for tasks and for pty or macos-terminal hosts.",
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
  {
    name: "title",
    description:
      "Retitle a running tmux session by durable id or unambiguous peer name, from outside its agent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
      },
      required: ["id", "title"],
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
/**
 * What `muster mcp` serves by default: reading what Muster already owns.
 * Nothing here can start, stop or change a run, so registering the server
 * where every Claude session sees it grants no launch authority.
 */
export const READ_ONLY_TOOLS = ["list", "output"] as const;
/**
 * Added by `muster mcp --allow-launch`, the deliberate grant. `title` is here
 * rather than above because it changes a running session, and the read-only
 * set is defined as changing nothing.
 */
export const LAUNCH_TOOLS = ["run", "stop", "title"] as const;
export function mcpToolNames(allowLaunch: boolean): string[] {
  return allowLaunch
    ? [...READ_ONLY_TOOLS, ...LAUNCH_TOOLS]
    : [...READ_ONLY_TOOLS];
}
