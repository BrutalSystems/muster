import net from "node:net";
import { z, type ZodType } from "zod";

const REQUEST_TIMEOUT_MS = 2_000;

const healthSchema = z.object({
  healthy: z.boolean(),
  version: z.string().min(1),
});

const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  directory: z.string().min(1),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
});

const statusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
    action: z
      .object({
        reason: z.string(),
        provider: z.string(),
        title: z.string(),
        message: z.string(),
        label: z.string(),
        link: z.string().optional(),
      })
      .optional(),
  }),
]);

const eventSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().min(1),
    properties: z.unknown(),
  })
  .passthrough();

export type OpenCodeSession = z.infer<typeof sessionSchema>;
export type OpenCodeStatus = z.infer<typeof statusSchema>;
export type OpenCodeEvent = z.infer<typeof eventSchema>;
export type OpenCodeHealth = z.infer<typeof healthSchema>;

export type OpenCodeProtocolErrorCode =
  | "endpoint"
  | "timeout"
  | "http"
  | "content_type"
  | "invalid_json"
  | "invalid_payload"
  | "request";

export class OpenCodeProtocolError extends Error {
  readonly name = "OpenCodeProtocolError";

  constructor(
    message: string,
    readonly code: OpenCodeProtocolErrorCode,
    readonly method?: string,
    readonly path?: string,
    readonly status?: number,
  ) {
    super(`OpenCode protocol error: ${message}`);
  }
}

function protocolError(
  message: string,
  code: OpenCodeProtocolErrorCode = "request",
  method?: string,
  path?: string,
  status?: number,
) {
  return new OpenCodeProtocolError(message, code, method, path, status);
}

function requestTimeout(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw protocolError("request timed out", "timeout");
  return Math.min(remaining, REQUEST_TIMEOUT_MS);
}

function isJsonContentType(value: string | null) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json");
}

function isLoopbackHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Reserves an ephemeral loopback port only long enough to learn its number.
 * The caller must still prove endpoint ownership during readiness because
 * another process can claim the port after this function closes its listener.
 */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(protocolError("could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(protocolError("could not release allocated port"));
        else resolve(port);
      });
    });
  });
}

export class OpenCodeHttp {
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw protocolError(
        "endpoint must be a loopback HTTP URL using a literal loopback IP",
        "endpoint",
      );
    }
    if (
      parsed.protocol !== "http:" ||
      !isLoopbackHostname(parsed.hostname) ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw protocolError(
        "endpoint must be a loopback HTTP URL using a literal loopback IP",
        "endpoint",
      );
    }
    this.baseUrl = new URL(parsed.origin);
  }

  health(deadline: number): Promise<OpenCodeHealth> {
    return this.requestJson("GET", "/global/health", deadline, healthSchema);
  }

  sessions(deadline: number): Promise<OpenCodeSession[]> {
    return this.requestJson(
      "GET",
      "/session",
      deadline,
      z.array(sessionSchema),
    );
  }

  session(id: string, deadline: number): Promise<OpenCodeSession> {
    return this.requestJson(
      "GET",
      `/session/${encodeURIComponent(id)}`,
      deadline,
      sessionSchema,
    );
  }

  statuses(deadline: number): Promise<Record<string, OpenCodeStatus>> {
    return this.requestJson(
      "GET",
      "/session/status",
      deadline,
      z.record(statusSchema),
    );
  }

  abort(id: string, deadline: number): Promise<boolean> {
    return this.requestJson(
      "POST",
      `/session/${encodeURIComponent(id)}/abort`,
      deadline,
      z.boolean(),
    );
  }

  async *events(deadline: number): AsyncGenerator<OpenCodeEvent> {
    const method = "GET";
    const path = "/event";
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), requestTimeout(deadline));
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const streamTimeout = deadline - Date.now();
      if (streamTimeout <= 0)
        throw protocolError(
          `${method} ${path} timed out`,
          "timeout",
          method,
          path,
        );
      timer = setTimeout(() => controller.abort(), streamTimeout);
      if (!response.ok)
        throw protocolError(
          `${method} ${path} returned HTTP ${response.status}`,
          "http",
          method,
          path,
          response.status,
        );
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "text/event-stream")
        throw protocolError(
          `${method} ${path} returned the wrong content type`,
          "content_type",
          method,
          path,
        );
      if (!response.body)
        throw protocolError(
          `${method} ${path} returned no event stream`,
          "invalid_payload",
          method,
          path,
        );

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: RegExpMatchArray | null;
        while ((boundary = buffer.match(/\r?\n\r?\n/))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index! + boundary[0].length);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line === "data" || line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") continue;
          yield this.parseEvent(data);
        }
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw protocolError(
          `${method} ${path} timed out`,
          "timeout",
          method,
          path,
        );
      if (error instanceof OpenCodeProtocolError) throw error;
      throw protocolError(
        `${method} ${path} request failed`,
        "request",
        method,
        path,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private parseEvent(data: string): OpenCodeEvent {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw protocolError(
        "GET /event returned invalid JSON",
        "invalid_json",
        "GET",
        "/event",
      );
    }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success)
      throw protocolError(
        "GET /event returned an invalid event payload",
        "invalid_payload",
        "GET",
        "/event",
      );
    return parsed.data;
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    deadline: number,
    schema: ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      requestTimeout(deadline),
    );
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok)
        throw protocolError(
          `${method} ${path} returned HTTP ${response.status}`,
          "http",
          method,
          path,
          response.status,
        );
      if (!isJsonContentType(response.headers.get("content-type")))
        throw protocolError(
          `${method} ${path} returned the wrong content type`,
          "content_type",
          method,
          path,
        );

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw protocolError(
          `${method} ${path} returned invalid JSON`,
          "invalid_json",
          method,
          path,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw protocolError(
          `${method} ${path} returned an invalid payload`,
          "invalid_payload",
          method,
          path,
        );
      return parsed.data;
    } catch (error) {
      if (controller.signal.aborted)
        throw protocolError(
          `${method} ${path} timed out`,
          "timeout",
          method,
          path,
        );
      if (error instanceof OpenCodeProtocolError) throw error;
      throw protocolError(
        `${method} ${path} request failed`,
        "request",
        method,
        path,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
