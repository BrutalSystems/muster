import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveOpenCode } from "../src/identity/opencode.js";

type Session = {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
};

const servers: Server[] = [];

async function endpoint(
  sessions: () => Session[],
  statuses: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  onRequest?: () => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    onRequest?.();
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/global/health") {
      response.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
      return;
    }
    if (request.url === "/session") {
      response.end(JSON.stringify(sessions()));
      return;
    }
    if (request.url === "/session/status") {
      response.end(JSON.stringify(await statuses()));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

test("discovers the one endpoint-owned new session for the resolved cwd", async () => {
  const cwd = await realpath(process.cwd());
  const createdAfter = Date.now() - 100;
  const url = await endpoint(
    () => [
      {
        id: "ses_old",
        title: "old",
        directory: cwd,
        time: { created: createdAfter - 1, updated: createdAfter - 1 },
      },
      {
        id: "ses_elsewhere",
        title: "elsewhere",
        directory: `${cwd}-other`,
        time: { created: createdAfter + 1, updated: createdAfter + 1 },
      },
      {
        id: "ses_new",
        title: "review auth",
        directory: cwd,
        time: { created: createdAfter, updated: createdAfter + 1 },
      },
      {
        id: "ses_unowned",
        title: "other launch",
        directory: cwd,
        time: { created: createdAfter + 2, updated: createdAfter + 2 },
      },
    ],
    () => ({ ses_new: { type: "busy" } }),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, createdAfter, Date.now() + 3_000),
  ).resolves.toEqual({
    id: "ses_new",
    pid: process.pid,
    rawName: "review auth",
    cwd,
    serverUrl: url,
  });
});

test("normalizes a whitespace-only OpenCode title to no raw name", async () => {
  const cwd = await realpath(process.cwd());
  const url = await endpoint(
    () => [
      {
        id: "ses_blank",
        title: "  \t",
        directory: cwd,
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
    () => ({ ses_blank: { type: "busy" } }),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, 0, Date.now() + 3_000),
  ).resolves.toMatchObject({ id: "ses_blank", rawName: null });
});

test("retries until the matching session appears on the launch endpoint", async () => {
  const cwd = await realpath(process.cwd());
  const session: Session = {
    id: "ses_delayed",
    title: "delayed",
    directory: cwd,
    time: { created: Date.now(), updated: Date.now() },
  };
  let listings = 0;
  const url = await endpoint(
    () => (++listings < 3 ? [] : [session]),
    () => ({ ses_delayed: { type: "busy" } }),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, 0, Date.now() + 3_000),
  ).resolves.toMatchObject({ id: "ses_delayed" });
  expect(listings).toBe(3);
});

test("returns undefined when no matching session appears before the deadline", async () => {
  const cwd = await realpath(process.cwd());
  const url = await endpoint(
    () => [
      {
        id: "ses_wrong_cwd",
        title: "wrong",
        directory: `${cwd}-other`,
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
    () => ({ ses_wrong_cwd: { type: "busy" } }),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, 0, Date.now() + 80),
  ).resolves.toBeUndefined();
});

test("does not claim an idle session read from the shared project database", async () => {
  const cwd = await realpath(process.cwd());
  const url = await endpoint(
    () => [
      {
        id: "ses_unowned_idle",
        title: "other launch",
        directory: cwd,
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
    () => ({}),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, 0, Date.now() + 80),
  ).resolves.toBeUndefined();
});

test("rejects ambiguous new sessions on the same endpoint and cwd", async () => {
  const cwd = await realpath(process.cwd());
  const session = (id: string): Session => ({
    id,
    title: id,
    directory: cwd,
    time: { created: Date.now(), updated: Date.now() },
  });
  const url = await endpoint(
    () => [session("ses_one"), session("ses_two")],
    () => ({
      ses_one: { type: "busy" },
      ses_two: { type: "busy" },
    }),
  );

  await expect(
    resolveOpenCode(process.pid, url, cwd, 0, Date.now() + 3_000),
  ).rejects.toThrow(/multiple OpenCode sessions/i);
});

test("does not query the endpoint when the launched root process is dead", async () => {
  let requests = 0;
  const url = await endpoint(
    () => [],
    () => ({}),
    () => requests++,
  );

  await expect(
    resolveOpenCode(99_999_999, url, process.cwd(), 0, Date.now() + 3_000),
  ).resolves.toBeUndefined();
  expect(requests).toBe(0);
});

test("does not return an identity when the root dies during discovery", async () => {
  const cwd = await realpath(process.cwd());
  const dir = await mkdtemp(join(tmpdir(), "muster-opencode-dies-"));
  const marker = join(dir, "status-requested");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const http = require("node:http");
const cwd = process.argv[1];
const marker = process.argv[2];
const session = { id: "ses_stale", title: "stale", directory: cwd, time: { created: Date.now(), updated: Date.now() } };
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url === "/global/health") return response.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
  if (request.url === "/session") return response.end(JSON.stringify([session]));
  if (request.url === "/session/status") { fs.writeFileSync(marker, "requested"); process.exit(0); }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`,
      cwd,
      marker,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  if (!child.pid) throw new Error("Child did not start");
  const port = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (data) => resolve(String(data).trim()));
  });
  const url = `http://127.0.0.1:${port}`;

  await expect(
    resolveOpenCode(child.pid, url, cwd, 0, Date.now() + 3_000),
  ).resolves.toBeUndefined();
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(await readFile(marker, "utf8")).toBe("requested");
});
