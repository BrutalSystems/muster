import type { Runtime } from "./types.js";
import type { Entry } from "./registry.js";
import { abortOpenCodeSession } from "./stop/opencode.js";
import {
  refreshClaude,
  refreshCodex,
  refreshOpenCode,
  type SessionMetadata,
} from "./refresh/index.js";
import { setCodexWorkspaceTrust, setWorkspaceTrust } from "./identity-copy.js";

/**
 * What Muster must know about one agent, for the facts that are the same
 * question asked of each.
 *
 * `AGENT_CAPABILITIES.md` lists all sixteen capabilities and where each lives.
 * Only the ones that are pure data belong here. The ones that are a question
 * with three unrelated mechanisms behind it — "is there a session yet", "is it
 * still alive" — stay as explicit dispatch to `identity/*` and `reach/*`,
 * because a uniform signature over a file read, a JSON-RPC call and an HTTP
 * check with a port-ownership test would hide the differences that matter when
 * one of them misbehaves.
 *
 * `null` is an answer, not a gap: OpenCode has no configuration-home variable.
 *
 * The wire name is deliberately NOT here. `naming.ts` owns it as a versioned
 * agreement with Tin Can, and restating it in a second place with a test
 * asserting the two agree is the pattern this repo removed from its Tin Can
 * pin: a value that can drift, guarded after the fact, rather than one place
 * that cannot.
 */
export type AgentCapabilities = {
  /**
   * The environment variable naming the agent's own configuration directory —
   * where it writes the session record a launch is resolved against, and what
   * an identity launch relocates to a per-launch copy.
   */
  configHomeVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | null;
  /**
   * How strongly containment is imposed once a sandbox is configured. The
   * difference is in the runtimes rather than in Muster: Codex and Claude Code
   * each have an OS sandbox Muster configures, while OpenCode's permissions are
   * tool policy with no kernel behind them.
   */
  enforcement: "kernel" | "tool-policy";
  /**
   * Which options a caller may pass through after `--`. `forwarded` reaches the
   * runtime; `consumed` is accepted and dropped because Muster derives that
   * setting itself, and anything in neither list is refused rather than passed
   * blindly.
   */
  runtimeOptions: { forwarded: string[]; consumed: string[] };
  /**
   * Records that a directory is trusted, in the per-launch identity copy —
   * never in the live configuration, which a running session rewrites
   * continuously and Muster cannot coordinate with. `null` where the agent has
   * no such gate.
   *
   * A slot rather than explicit dispatch because the INPUTS match: every agent
   * that has this answers the same question from the same two arguments. That
   * is what separates it from "is there a session yet", where Claude needs a
   * socket path, Codex a live RPC handle and OpenCode a server URL — there a
   * uniform signature would be a lie.
   *
   * The second argument is the CANONICAL key from `workspaceTrustKey`, not the
   * launch directory: Claude has two trust gates that disagree about how far
   * they look, and only the repo root satisfies both. It is also resolved,
   * never as written, because these agents key by what their own getcwd(2)
   * returns with symlinks expanded — on macOS a launch into /tmp/... is really
   * /private/tmp/..., and an unresolved key is one they never look up.
   */
  trustWorkspace:
    ((identityCopy: string, trustKey: string) => Promise<void>) | null;
  /**
   * What to say to the agent before its processes are signalled, or `null` when
   * there is nothing to say. Only OpenCode has an answer: it is a server with
   * work possibly in flight, so it is asked to abort over its own endpoint.
   *
   * A slot on the same test as `trustWorkspace`: the inputs match — the entry
   * and a deadline — and each implementation reads what it needs from the
   * entry. Killing the tree afterwards is identical for all three and is not
   * part of this row.
   */
  beforeStop: ((entry: Entry, deadline: number) => Promise<void>) | null;
  /**
   * Live metadata for a running session — the agent's own name for it, and
   * whether it is idle or busy. Never `null`: every agent can be asked, and
   * throwing is how "unreachable" is reported.
   *
   * `env` is the environment the agent's own configuration lives in, which an
   * identity launch relocates to a per-launch copy. The caller composes it
   * because only Muster knows where that copy went.
   */
  refreshMetadata: (
    entry: Entry,
    env: NodeJS.ProcessEnv,
    deadline: number,
  ) => Promise<SessionMetadata>;
};

/**
 * The model flags Muster resolves itself. Listed as `consumed` for the runtimes
 * whose model Muster owns, so a caller may NAME a model without it reaching the
 * child's argv twice.
 *
 * Exactly these two spellings. Anything else a caller passes after `--` is in
 * neither list and is refused, which is what keeps `--config=sandbox_mode=...`
 * an error rather than something quietly dropped.
 */
export const MODEL_FLAGS = ["--model", "-m"];

/**
 * One row per runtime. `Record<Runtime, …>` is the point: a fourth agent is a
 * compile error until every column is filled, where the scattered
 * `runtime === ?` checks this replaced would simply have been incomplete.
 */
export const AGENTS: Record<Runtime, AgentCapabilities> = {
  claude: {
    configHomeVar: "CLAUDE_CONFIG_DIR",
    enforcement: "kernel",
    runtimeOptions: { forwarded: ["--effort"], consumed: MODEL_FLAGS },
    trustWorkspace: setWorkspaceTrust,
    beforeStop: null,
    refreshMetadata: refreshClaude,
  },
  codex: {
    configHomeVar: "CODEX_HOME",
    enforcement: "kernel",
    runtimeOptions: { forwarded: [], consumed: MODEL_FLAGS },
    trustWorkspace: setCodexWorkspaceTrust,
    beforeStop: null,
    refreshMetadata: refreshCodex,
  },
  opencode: {
    configHomeVar: null,
    enforcement: "tool-policy",
    runtimeOptions: {
      forwarded: ["--model", "-m", "--agent", "--variant"],
      consumed: [],
    },
    trustWorkspace: null,
    beforeStop: abortOpenCodeSession,
    refreshMetadata: refreshOpenCode,
  },
};
