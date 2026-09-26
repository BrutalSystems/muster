import { CodexRpc } from "../codex-rpc.js";
/** Why a thread cannot serve as a messageable session identity, or null if it
 * can. One source of truth: the launch loop screens candidate writer locks with
 * this, and readiness re-checks it on the thread it settled on. */
export function threadRejection(
  thread:
    | {
        id?: string;
        source?: unknown;
        ephemeral?: boolean;
        canAcceptDirectInput?: boolean;
      }
    | undefined,
  id: string,
): string | null {
  if (!thread || thread.id !== id)
    return "thread/read returned no matching thread";
  if (thread.source === "exec")
    return "source is exec, not a messageable session";
  if (thread.ephemeral === true || thread.canAcceptDirectInput === false)
    return "thread cannot accept direct input";
  if (thread.source !== "cli") return "source is not a direct CLI session";
  return null;
}
export async function codexReachable(
  rpc: CodexRpc,
  id: string,
  deadline: number,
) {
  const { thread } = await rpc.call("thread/read", { threadId: id }, deadline);
  const rejection = threadRejection(thread, id);
  if (rejection) throw new Error(rejection);
  const listing = await rpc.call(
    "thread/list",
    { limit: 100, useStateDbOnly: true },
    deadline,
  );
  const metadata = Array.isArray(listing.data)
    ? listing.data.find((t: any) => t.id === id)
    : undefined;
  // Tin Can derives names from thread/list rather than thread/read.
  const rawName =
    typeof metadata?.name === "string" && metadata.name !== ""
      ? metadata.name
      : null;
  const status = metadata?.status ?? thread.status;
  const state =
    status === "idle" ||
    status === undefined ||
    status?.type === "idle" ||
    status?.type === "notLoaded"
      ? "idle"
      : "busy";
  return { rawName, state: state as "idle" | "busy" };
}
