import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import type { OpenCodeIdentity } from "../src/identity/opencode.js";
import { OpenCodeHttp, type OpenCodeStatus } from "../src/opencode-http.js";
import { openCodeReachable } from "../src/reach/opencode.js";

const servers: Server[] = [];

async function fixture(
  options: {
    returnedId?: string;
    title?: string;
    status?: OpenCodeStatus;
    includeStatus?: boolean;
  } = {},
): Promise<{ client: OpenCodeHttp; identity: OpenCodeIdentity }> {
  const id = "ses_test";
  const returnedId = options.returnedId ?? id;
  const session = {
    id: returnedId,
    title: options.title ?? "review auth",
    directory: "/repo",
    time: { created: 10, updated: 11 },
  };
  const statuses =
    options.includeStatus === false
      ? {}
      : { [id]: options.status ?? ({ type: "idle" } as const) };
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(request.url === `/session/${id}` ? session : statuses),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  return {
    client: new OpenCodeHttp(serverUrl),
    identity: {
      id,
      pid: process.pid,
      rawName: null,
      cwd: "/repo",
      serverUrl,
    },
  };
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

test("maps an idle OpenCode session to the shared idle state", async () => {
  const { client, identity } = await fixture({
    title: "current title",
    status: { type: "idle" },
  });

  await expect(
    openCodeReachable(client, identity, Date.now() + 1_000),
  ).resolves.toEqual({ rawName: "current title", state: "idle" });
});

test("maps a busy OpenCode session to the shared busy state", async () => {
  const { client, identity } = await fixture({ status: { type: "busy" } });

  await expect(
    openCodeReachable(client, identity, Date.now() + 1_000),
  ).resolves.toEqual({ rawName: "review auth", state: "busy" });
});

test("maps retry to busy and surfaces the retry message as a diagnostic", async () => {
  const { client, identity } = await fixture({
    title: " \t",
    status: {
      type: "retry",
      attempt: 3,
      message: "provider overloaded",
      next: 42,
    },
  });

  await expect(
    openCodeReachable(client, identity, Date.now() + 1_000),
  ).resolves.toEqual({
    rawName: null,
    state: "busy",
    diagnostic: "OpenCode retry attempt 3: provider overloaded",
  });
});

test("rejects a session detail response for a different durable ID", async () => {
  const { client, identity } = await fixture({ returnedId: "ses_other" });

  await expect(
    openCodeReachable(client, identity, Date.now() + 1_000),
  ).rejects.toThrow(/no matching session/i);
});

test("maps an omitted status entry to idle for a proven durable session", async () => {
  const { client, identity } = await fixture({
    title: "idle title",
    includeStatus: false,
  });

  await expect(
    openCodeReachable(client, identity, Date.now() + 1_000),
  ).resolves.toEqual({ rawName: "idle title", state: "idle" });
});
