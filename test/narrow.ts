import type { RunResult, SessionPeer, TaskHandle } from "../src/types.js";

/**
 * Narrowing a launch result to the arm the test meant, as an assertion.
 *
 * `run()` returns `SessionPeer | TaskHandle`, and `SessionPeer` narrows again
 * on `runtime` — a codex peer carries `thread_id` and *cannot* carry
 * `session_id`, a claude-code peer the reverse, an opencode peer a
 * `server_url` besides. That is a real guarantee, and tests were getting none
 * of it: `expect(peer.kind).toBe("session")` asserts at runtime but narrows
 * nothing for the compiler, so every property read after it was unchecked
 * (#74).
 *
 * These replace that line rather than being added beside it. They assert the
 * same thing, fail with a better message, and hand back a value the compiler
 * can check the rest of the test against.
 */
function tagOf(result: RunResult) {
  return result.kind === "session"
    ? `${result.kind}/${result.runtime}`
    : result.kind;
}
export function asSession(result: RunResult): SessionPeer {
  if (result.kind !== "session")
    throw new Error(`expected a session, got ${tagOf(result)}`);
  return result;
}
export function asTask(result: RunResult): TaskHandle {
  if (result.kind !== "task")
    throw new Error(`expected a task, got ${tagOf(result)}`);
  return result;
}
type WithRuntime<R extends SessionPeer["runtime"]> = Extract<
  SessionPeer,
  { runtime: R }
>;
/** A session of one runtime, so the fields only that runtime has are readable. */
export function asSessionOf<R extends SessionPeer["runtime"]>(
  result: RunResult,
  runtime: R,
): WithRuntime<R> {
  const peer = asSession(result);
  if (peer.runtime !== runtime)
    throw new Error(`expected a ${runtime} session, got ${tagOf(result)}`);
  return peer as WithRuntime<R>;
}
