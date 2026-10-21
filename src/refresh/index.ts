import { resolveCodex } from "../identity/codex.js";
import type { InputStatus } from "../input-status.js";
import { CodexRpc } from "../codex-rpc.js";
import { OpenCodeHttp } from "../opencode-http.js";
import { codexReachable } from "../reach/codex.js";
import { openCodeReachable } from "../reach/opencode.js";
import { claudeReachable } from "../reach/claude.js";
import { resolveClaude } from "../identity/claude.js";
import { openCodeEndpointOwnedBy } from "../identity/opencode.js";
import {
  isSame,
  processRef,
  descendants,
  type ProcessRef,
} from "../identity/processes.js";
import type { Entry } from "../registry.js";

/** What a refresh learns: the agent's own name for the session, and what it is doing. */
export type SessionMetadata = {
  rawName: string | null;
  state: "idle" | "busy";
  input_status?: InputStatus;
  id?: string;
  process?: ProcessRef;
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
export class CodexTrackingUnsupported extends Error {
  constructor() {
    super("codex_thread_tracking_unsupported");
  }
}
export async function refreshCodex(
  entry: Entry,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<SessionMetadata> {
  const rpc = new CodexRpc(env, entry.cwd);
  try {
    // Old CLI threads remain readable after /new. Exclude only positively
    // identified non-foreground helpers; an unreadable/blank thread stays a
    // candidate, never a reason to choose the readable old thread.
    try {
      if (!entry.root || !(await isSame(entry.root))) throw new Error();
      const identity = await resolveCodex(
        entry.root.pid,
        env,
        deadline,
        async (id) => {
          try {
            const { thread } = await rpc.call(
              "thread/read",
              { threadId: id },
              deadline,
            );
            if (
              thread?.id === id &&
              (thread.ephemeral === true ||
                thread.source === "exec" ||
                (thread.source &&
                  typeof thread.source === "object" &&
                  thread.source.subAgent))
            )
              return "non-foreground helper";
          } catch {
            /* Unknown candidates are retained. */
          }
          return null;
        },
      );
      const ref = identity && (await processRef(identity.pid));
      if (
        !identity ||
        !ref ||
        identity.id !== entry.id ||
        (entry.runtimeProcess
          ? ref.pid !== entry.runtimeProcess.pid ||
            ref.start !== entry.runtimeProcess.start
          : identity.pid !== entry.peer?.pid) ||
        !(await isSame(entry.root))
      )
        throw new Error();
    } catch {
      throw new CodexTrackingUnsupported();
    }
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
  if (!(await isSame(entry.root))) throw new Error("launch process changed");
  const identity = await resolveClaude(entry.root.pid, env, deadline);
  const ref = identity ? await processRef(identity.pid) : undefined;
  const bound = entry.runtimeProcess;
  if (
    identity &&
    (!ref ||
      (bound
        ? ref.pid !== bound.pid || ref.start !== bound.start
        : identity.id !== entry.id || identity.pid !== entry.peer?.pid))
  )
    throw new Error(
      "runtime identity changed without a verified process binding",
    );
  if (!identity || !(await claudeReachable(identity.socketPath, deadline)))
    throw new Error("session unreachable");
  if (
    !(await isSame(entry.root)) ||
    !ref ||
    !(await isSame(ref)) ||
    !(await descendants(entry.root.pid, deadline)).includes(ref.pid)
  )
    throw new Error("runtime process ownership changed");
  return { ...identity, process: ref };
}
