import { OpenCodeHttp } from "../opencode-http.js";
import { openCodeEndpointOwnedBy } from "../identity/opencode.js";
import { isSame } from "../identity/processes.js";
import type { Entry } from "../registry.js";

/**
 * Ask an OpenCode session to abort before anything is signalled.
 *
 * OpenCode is a server with work possibly in flight, so it gets told to stop
 * rather than only being killed — Claude and Codex have nothing equivalent to
 * say. Best effort by design: a failure here is not a reason to leave processes
 * running, and the kill that follows is what actually guarantees the stop.
 *
 * Every precondition is a reason not to shout at a stranger. The endpoint must
 * still be owned by the process Muster started, because a loopback port is a
 * shared resource and a pid can be reused — without that check an abort could
 * be sent to whatever now happens to be listening on that port.
 *
 * Lives outside `opencode-policy.ts` deliberately: that module imports
 * `guard.ts`, which imports the agent table, so referencing it from a row would
 * close a cycle and leave the slot undefined depending on evaluation order.
 */
export async function abortOpenCodeSession(
  entry: Entry,
  deadline: number,
): Promise<void> {
  const sessionId = entry.peer?.session_id;
  if (
    !entry.root ||
    !entry.server_url ||
    typeof sessionId !== "string" ||
    !(await isSame(entry.root)) ||
    !(await openCodeEndpointOwnedBy(entry.root.pid, entry.server_url, deadline))
  )
    return;
  await new OpenCodeHttp(entry.server_url)
    .abort(sessionId, deadline)
    .catch(() => {});
}
