import { CodexRpc } from "../codex-rpc.js";
import { OpenCodeHttp } from "../opencode-http.js";
import { codexReachable } from "../reach/codex.js";
import { openCodeReachable } from "../reach/opencode.js";
import { claudeReachable } from "../reach/claude.js";
import { resolveClaude } from "../identity/claude.js";
import { openCodeEndpointOwnedBy } from "../identity/opencode.js";
import { isSame } from "../identity/processes.js";
import type { Entry } from "../registry.js";

/** What a refresh learns: the agent's own name for the session, and what it is doing. */
export type SessionMetadata = {
  rawName: string | null;
  state: "idle" | "busy";
};

/**
 * Live metadata for a running session, one implementation per agent.
 *
 * These pass the same test `trustWorkspace` and `beforeStop` passed: the inputs
 * match. Each takes the entry, the environment the agent's own configuration
 * lives in, and a deadline, and each reads from the entry whatever it needs —
 * a server URL, a configuration home, nothing at all. Readiness could not be a
 * slot for the opposite reason: it needs a socket path, a live RPC handle and a
 * server URL, which is three different inputs wearing one name.
 *
 * Throwing is how "unreachable" is reported; the caller turns it into that
 * state. Each implementation owns any connection it opens.
 */
export async function refreshCodex(
  entry: Entry,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<SessionMetadata> {
  // The connection is opened and closed here rather than by the caller, so a
  // refresh cannot leak one by taking an early path out.
  const rpc = new CodexRpc(env, entry.cwd);
  try {
    return await codexReachable(rpc, entry.id, deadline);
  } finally {
    await rpc.close();
  }
}

export async function refreshOpenCode(
  entry: Entry,
  _env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<SessionMetadata> {
  if (!entry.server_url) throw new Error("session endpoint missing");
  if (!entry.root) throw new Error("session has no root process");
  // Checked BEFORE and AFTER the read, which is not belt-and-braces: a loopback
  // port is a shared resource and a pid can be reused, so an endpoint that was
  // ours when the read started may belong to something else by the time it
  // finishes, and metadata from a stranger is worse than none.
  const owned = async () =>
    (await isSame(entry.root!)) &&
    (await openCodeEndpointOwnedBy(
      entry.root!.pid,
      entry.server_url!,
      deadline,
    ));
  if (!(await owned()))
    throw new Error("session endpoint is not owned by the launch");
  const metadata = await openCodeReachable(
    new OpenCodeHttp(entry.server_url),
    {
      id: entry.id,
      pid: entry.root.pid,
      rawName: null,
      cwd: entry.cwd,
      serverUrl: entry.server_url,
    },
    deadline,
  );
  if (!(await owned()))
    throw new Error("session endpoint ownership changed during refresh");
  return metadata;
}

export async function refreshClaude(
  entry: Entry,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<SessionMetadata> {
  if (!entry.root) throw new Error("session has no root process");
  const identity = await resolveClaude(entry.root.pid, env, deadline);
  if (
    !identity ||
    identity.id !== entry.id ||
    !(await claudeReachable(identity.socketPath, deadline))
  )
    throw new Error("session unreachable");
  return identity;
}
