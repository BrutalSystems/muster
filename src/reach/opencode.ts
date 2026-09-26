import type { OpenCodeIdentity } from "../identity/opencode.js";
import { OpenCodeHttp } from "../opencode-http.js";

export type OpenCodeReachability = {
  rawName: string | null;
  state: "idle" | "busy";
  diagnostic?: string;
};

export async function openCodeReachable(
  client: OpenCodeHttp,
  identity: OpenCodeIdentity,
  deadline: number,
): Promise<OpenCodeReachability> {
  const session = await client.session(identity.id, deadline);
  if (session.id !== identity.id)
    throw new Error("OpenCode session detail returned no matching session");

  const statuses = await client.statuses(deadline);
  const status = statuses[identity.id];

  const rawName = session.title.trim() === "" ? null : session.title;
  if (!status || status.type === "idle") return { rawName, state: "idle" };
  if (status.type === "retry")
    return {
      rawName,
      state: "busy",
      diagnostic: `OpenCode retry attempt ${status.attempt}: ${status.message}`,
    };
  return { rawName, state: "busy" };
}
