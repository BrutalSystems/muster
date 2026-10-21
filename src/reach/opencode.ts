import type { InputStatus } from "../input-status.js";
import type { OpenCodeIdentity } from "../identity/opencode.js";
import { OpenCodeHttp } from "../opencode-http.js";

export type OpenCodeReachability = {
  rawName: string | null;
  state: "idle" | "busy";
  diagnostic?: string;
  input_status?: InputStatus;
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

  const input = await client.inputStatus(
    identity.id,
    Math.min(deadline, Date.now() + 300),
  );
  const observation = input ? { input_status: input } : {};
  const rawName = session.title.trim() === "" ? null : session.title;
  if (!status || status.type === "idle")
    return { rawName, state: "idle", ...observation };
  if (status.type === "retry")
    return {
      rawName,
      ...observation,
      state: "busy",
      diagnostic: `OpenCode retry attempt ${status.attempt}: ${status.message}`,
    };
  return { rawName, state: "busy", ...observation };
}
