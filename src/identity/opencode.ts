import { realpath } from "node:fs/promises";
import {
  OpenCodeHttp,
  OpenCodeProtocolError,
  type OpenCodeSession,
} from "../opencode-http.js";
import { command, delay, descendants, processRef } from "./processes.js";

const POLL_INTERVAL_MS = 50;

export type OpenCodeIdentity = {
  id: string;
  pid: number;
  rawName: string | null;
  cwd: string;
  serverUrl: string;
};

function rawName(session: OpenCodeSession) {
  return session.title.trim() === "" ? null : session.title;
}

export async function openCodeEndpointOwnedBy(
  rootPid: number,
  serverUrl: string,
  deadline: number,
): Promise<boolean> {
  try {
    const endpoint = new URL(serverUrl);
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port <= 0 || deadline <= Date.now())
      return false;
    const family = new Set(await descendants(rootPid, deadline));
    const output = await command(
      "lsof",
      [
        "-nP",
        "-a",
        `-iTCP@${endpoint.hostname}:${port}`,
        "-sTCP:LISTEN",
        "-Fp",
      ],
      Math.max(1, Math.min(1000, deadline - Date.now())),
    );
    const listeners = output
      .split("\n")
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)));
    return listeners.length > 0 && listeners.every((pid) => family.has(pid));
  } catch {
    return false;
  }
}

export async function resolveOpenCode(
  rootPid: number,
  serverUrl: string,
  cwd: string,
  createdAfter: number,
  deadline: number,
): Promise<OpenCodeIdentity | undefined> {
  const resolvedCwd = await realpath(cwd);
  const client = new OpenCodeHttp(serverUrl);
  let ownershipProven = false;

  while (Date.now() < deadline) {
    if (!(await processRef(rootPid))) return;
    if (
      !ownershipProven &&
      !(await openCodeEndpointOwnedBy(rootPid, serverUrl, deadline))
    ) {
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(POLL_INTERVAL_MS, remaining));
      continue;
    }
    ownershipProven = true;
    try {
      const health = await client.health(deadline);
      if (health.healthy) {
        const sessions = await client.sessions(deadline);
        if (!(await processRef(rootPid))) return;
        const candidates = sessions.filter(
          (session) =>
            session.directory === resolvedCwd &&
            session.time.created >= createdAfter,
        );
        const statuses = candidates.length
          ? await client.statuses(deadline)
          : {};
        if (!(await processRef(rootPid))) return;
        if (!(await openCodeEndpointOwnedBy(rootPid, serverUrl, deadline))) {
          ownershipProven = false;
          continue;
        }
        const matches = candidates.filter((session) =>
          Object.prototype.hasOwnProperty.call(statuses, session.id),
        );
        if (matches.length > 1)
          throw new Error(
            "Multiple OpenCode sessions matched the launch endpoint, cwd, and creation window",
          );
        const match = matches[0];
        if (match)
          return {
            id: match.id,
            pid: rootPid,
            rawName: rawName(match),
            cwd: resolvedCwd,
            serverUrl,
          };
      }
    } catch (error) {
      if (!(error instanceof OpenCodeProtocolError)) throw error;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}
