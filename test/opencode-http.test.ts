import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  allocateLoopbackPort,
  OpenCodeHttp,
  OpenCodeProtocolError,
} from "../src/opencode-http.js";
import { ampleDeadline } from "./deadline.js";

/**
 * A route is either a handler, or a value to serialise as the JSON body.
 *
 * This used to read `unknown | ((request, response) => void)`, which is just
 * `unknown`: a union with `unknown` absorbs every other member. The function
 * arm therefore contributed nothing, every handler below was written against
 * implicitly-`any` parameters, and the body arm was unchecked too (#74).
 */
type JsonBody =
  Record<string, unknown> | unknown[] | string | number | boolean | null;
type Route =
  ((request: IncomingMessage, response: ServerResponse) => void) | JsonBody;

const cleanup: Array<() => Promise<void>> = [];

async function startTestServer(
  routes: Record<string, Route>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ""];
    if (typeof route === "function") {
      route(request, response);
      return;
    }
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(route));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  cleanup.push(close);
  return { url: `http://127.0.0.1:${address.port}`, close };
}

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("OpenCodeHttp", () => {
  test("reads health, sessions, one session, and status from one loopback endpoint", async () => {
    const session = {
      id: "ses_test",
      title: "review",
      directory: "/repo",
      time: { created: 10, updated: 11 },
    };
    const server = await startTestServer({
      "/global/health": { healthy: true, version: "1.18.31" },
      "/session": [session],
      "/session/ses_test": session,
      "/session/status": { ses_test: { type: "idle" } },
    });
    const client = new OpenCodeHttp(server.url);
    const deadline = ampleDeadline();

    await expect(client.health(deadline)).resolves.toEqual({
      healthy: true,
      version: "1.18.31",
    });
    await expect(client.sessions(deadline)).resolves.toEqual([session]);
    await expect(client.session("ses_test", deadline)).resolves.toEqual(
      session,
    );
    await expect(client.statuses(deadline)).resolves.toEqual({
      ses_test: { type: "idle" },
    });
  });

  test("accepts OpenCode retry session status with retry diagnostics", async () => {
    const server = await startTestServer({
      "/session/status": {
        ses_test: {
          type: "retry",
          attempt: 2,
          message: "provider overloaded",
          next: 42,
        },
      },
    });

    await expect(
      new OpenCodeHttp(server.url).statuses(ampleDeadline()),
    ).resolves.toEqual({
      ses_test: {
        type: "retry",
        attempt: 2,
        message: "provider overloaded",
        next: 42,
      },
    });
  });

  test("rejects endpoints that are not loopback HTTP URLs", () => {
    expect(() => new OpenCodeHttp("http://example.com:4096")).toThrow(
      /loopback/i,
    );
    expect(() => new OpenCodeHttp("http://localhost:4096")).toThrow(
      /literal loopback IP/i,
    );
    expect(() => new OpenCodeHttp("http://127.0.0.2:4096")).toThrow(
      /literal loopback IP/i,
    );
    expect(() => new OpenCodeHttp("https://127.0.0.1:4096")).toThrow(
      /loopback HTTP/i,
    );
  });

  test("fails a request when its absolute deadline elapses", async () => {
    const server = await startTestServer({
      "/global/health": (_request, response) => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
        }, 100);
      },
    });

    await expect(
      new OpenCodeHttp(server.url).health(Date.now() + 20),
    ).rejects.toThrow(/OpenCode protocol error.*timed out/i);
  });

  test("rejects malformed JSON without including the response body", async () => {
    const secret = "secret-api-token";
    const server = await startTestServer({
      "/global/health": (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`not-json-${secret}`);
      },
    });

    const promise = new OpenCodeHttp(server.url).health(ampleDeadline());
    await expect(promise).rejects.toThrow(
      /OpenCode protocol error.*invalid JSON/i,
    );
    await expect(promise).rejects.not.toThrow(secret);
  });

  test("rejects non-success responses without including the response body", async () => {
    const secret = "bearer-secret";
    const server = await startTestServer({
      "/global/health": (_request, response) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: secret }));
      },
    });

    const error = await new OpenCodeHttp(server.url)
      .health(ampleDeadline())
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpenCodeProtocolError);
    expect(error).toMatchObject({
      code: "http",
      method: "GET",
      path: "/global/health",
      status: 503,
    });
    expect((error as Error).message).toMatch(
      /OpenCode protocol error.*HTTP 503/i,
    );
    expect((error as Error).message).not.toContain(secret);
  });

  test("rejects JSON served with the wrong content type", async () => {
    const server = await startTestServer({
      "/global/health": (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
      },
    });

    await expect(
      new OpenCodeHttp(server.url).health(ampleDeadline()),
    ).rejects.toThrow(/OpenCode protocol error.*content type/i);
  });

  test("posts abort to the encoded session endpoint", async () => {
    let method: string | undefined;
    let path: string | undefined;
    const server = await startTestServer({
      "/session/ses%2Ftest/abort": (request, response) => {
        method = request.method;
        path = request.url;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("true");
      },
    });

    await expect(
      new OpenCodeHttp(server.url).abort("ses/test", ampleDeadline()),
    ).resolves.toBe(true);
    expect({ method, path }).toEqual({
      method: "POST",
      path: "/session/ses%2Ftest/abort",
    });
  });

  test("streams typed events from the SSE endpoint", async () => {
    const server = await startTestServer({
      "/event": (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": keep-alive\n\n");
        response.end(
          `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_test" } })}\n\n`,
        );
      },
    });

    const events = new OpenCodeHttp(server.url).events(ampleDeadline());
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      },
    });
    await expect(events.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  test("enforces the absolute deadline while waiting for an SSE event", async () => {
    const server = await startTestServer({
      "/event": (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting\n\n");
      },
    });

    const events = new OpenCodeHttp(server.url).events(Date.now() + 25);
    await expect(events.next()).rejects.toThrow(
      /OpenCode protocol error.*timed out/i,
    );
  });

  test("keeps an established SSE stream open until the caller deadline", async () => {
    const server = await startTestServer({
      "/event": (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": connected\n\n");
        setTimeout(() => {
          response.end(
            `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_late" } })}\n\n`,
          );
        }, 2100);
      },
    });

    const events = new OpenCodeHttp(server.url).events(Date.now() + 4000);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.idle",
        properties: { sessionID: "ses_late" },
      },
    });
  });
});

test("allocateLoopbackPort returns a positive port that is free to bind", async () => {
  const port = await allocateLoopbackPort();
  expect(port).toBeGreaterThan(0);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});
