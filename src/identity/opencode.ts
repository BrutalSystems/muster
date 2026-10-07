import { realpath } from "node:fs/promises";
import {
  OpenCodeHttp,
  OpenCodeProtocolError,
  type OpenCodeMessage,
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

/** The text of the session's first user message, or undefined before it has one. */
function firstUserText(messages: OpenCodeMessage[]) {
  const first = messages.find((message) => message.info.role === "user");
  if (!first) return undefined;
  return first.parts
    .filter((part) => part.type === "text" && part.text !== undefined)
    .map((part) => part.text)
    .join("");
}

async function carriesPrompt(
  client: OpenCodeHttp,
  id: string,
  prompt: string,
  deadline: number,
) {
  try {
    const text = firstUserText(await client.messages(id, deadline));
    return text !== undefined && text.trim() === prompt.trim();
  } catch (error) {
    // One unreadable candidate — deleted, or another process's half-written
    // session — is not a match, and must not stall discovery of the rest.
    if (error instanceof OpenCodeProtocolError) return false;
    throw error;
  }
}

/**
 * Finds the session this launch's OpenCode created.
 *
 * `/session` reads the project database every OpenCode process on the machine
 * shares, so directory and creation window alone can match a stranger's
 * session. Two signals tie a candidate to this launch:
 *
 * - presence in `/session/status`, which is the endpoint process's in-memory
 *   map of its own non-idle sessions; or
 * - for a candidate absent from that map, a first user message equal to the
 *   prompt this launch submitted.
 *
 * The second exists because OpenCode deletes a session from the status map the
 * moment it goes idle (#2): a first turn that finishes before discovery left
 * the session invisible, and the launch timed out. Without `prompt`, an absent
 * candidate is never claimed. Every candidate that passes either signal counts
 * toward the ambiguity check.
 */
export async function resolveOpenCode(
  rootPid: number,
  serverUrl: string,
  cwd: string,
  createdAfter: number,
  deadline: number,
  prompt?: string,
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
        const matches: OpenCodeSession[] = [];
        for (const session of candidates)
          if (
            Object.prototype.hasOwnProperty.call(statuses, session.id) ||
            (prompt !== undefined &&
              (await carriesPrompt(client, session.id, prompt, deadline)))
          )
            matches.push(session);
        if (!(await processRef(rootPid))) return;
        if (!(await openCodeEndpointOwnedBy(rootPid, serverUrl, deadline))) {
          ownershipProven = false;
          continue;
        }
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
