import type { HostCapabilities, HostId, TerminalApp } from "./hosts/types.js";
import type { Enforcement } from "./enforcement.js";
import type { LaunchPermissions } from "./guard.js";
import type { McpSummary } from "./mcp.js";
export type Runtime = "codex" | "claude" | "opencode";
export type SessionPeer = LaunchPermissions &
  McpSummary & {
    kind: "session";
    /**
     * How strongly the containment was actually imposed. Optional because
     * `list()` builds its records from registry entries rather than from this
     * type, and an entry written before the field has none.
     */
    enforcement?: Enforcement;
    /**
     * The resolved identity NAME, absent when the launch ran on the ambient
     * environment — which is the honest answer, where a null would read as
     * "no account".
     */
    identity?: string;
    /**
     * The model Muster resolved at launch, null when it resolved none and the
     * child chose its own default. Carried here as well as on the listing so
     * `run` and `list` cannot describe one launch two ways.
     */
    model?: string | null;
    model_source?: "request" | "config" | null;
    /** Seconds of inactivity after which this session is stopped. Absent when
     *  no limit applies — a host that does not outlive its parent has none. */
    idle_timeout?: number;
    ttl?: number;
    name: string;
    canonical_id: string;
    state: "idle" | "busy";
    cwd: string;
    pid: number;
    host: HostId;
    capabilities: HostCapabilities;
    terminal_opened?: true;
    terminal?: TerminalApp;
    attach_hint: string | null;
  } & (
    | { runtime: "codex"; thread_id: string; session_id?: never }
    | { runtime: "claude-code"; session_id: string; thread_id?: never }
    | {
        runtime: "opencode";
        session_id: string;
        server_url: string;
        thread_id?: never;
      }
  );
export type TaskHandle = LaunchPermissions &
  McpSummary & {
    kind: "task";
    enforcement?: Enforcement;
    /**
     * The resolved identity NAME, absent when the launch ran on the ambient
     * environment — which is the honest answer, where a null would read as
     * "no account".
     */
    identity?: string;
    /**
     * The model Muster resolved at launch, null when it resolved none and the
     * child chose its own default. Absent only on a run recorded before the
     * field existed.
     */
    model?: string | null;
    model_source?: "request" | "config" | null;
    id: string;
    runtime: Runtime;
    state: "running";
    cwd: string;
    pid: number;
  };
export type RunResult = SessionPeer | TaskHandle;
