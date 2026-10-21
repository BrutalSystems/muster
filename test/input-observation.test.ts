import { expect, test } from "vitest";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Muster, durableId } from "../src/run.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { PtyHost } from "../src/hosts/pty.js";
import { OpenCodeHttp } from "../src/opencode-http.js";
import { testServer } from "./global-setup.js";
import { fixture } from "./helpers.js";

test("live screen observations survive fresh readers, clear on redraw, and never persist text", async () => {
  const f = await fixture();
  const screen = join(f.root, "screen.txt");
  await writeFile(screen, "private probe text\nPassword:");
  f.env.MUSTER_FAKE_SCREEN_FILE = screen;
  const host = new TmuxHost(testServer("input-observation"));
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  const fresh = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [host],
  });
  try {
    const result = await m.run({
      runtime: "claude",
      prompt: "input observation",
      cwd: f.root,
      host: "tmux",
    });
    const id = durableId(result);
    expect(result).toHaveProperty("input_status");
    await expect
      .poll(async () => (await fresh.list())[0].input_status)
      .toMatchObject({
        state: "waiting",
        reason: "password",
        source: "tmux-screen",
      });
    const record = (await fresh.wait(id, { timeoutMs: 0 })).record;
    expect(record).toMatchObject({
      input_status: { state: "waiting", reason: "password" },
      state: "idle",
    });
    expect(JSON.stringify(record)).not.toContain("private probe text");
    expect(await readFile(join(f.home, "registry.json"), "utf8")).not.toContain(
      "private probe text",
    );
    await rm(
      join(
        f.root,
        ".claude",
        "sessions",
        String((result as any).pid) + ".json",
      ),
    );
    expect((await fresh.list())[0]).toMatchObject({
      state: "unreachable",
      input_status: { state: "waiting", reason: "password" },
    });
    await writeFile(screen, "❯ ");
    await expect
      .poll(async () => (await fresh.list())[0].input_status.state)
      .toBe("unknown");
    await m.stop(id);
    expect((await fresh.wait(id)).record).toMatchObject({
      input_status: { state: "unknown", reason: "unknown", source: "none" },
    });
  } finally {
    await m.close();
    await fresh.close();
  }
});

test("Codex native approval status is reported without a screen and clears on the next observation", async () => {
  const f = await fixture({
    MUSTER_FAKE_THREAD_STATUS: JSON.stringify({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }),
  });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const result = await m.run({
      runtime: "codex",
      cwd: f.root,
      prompt: "native approval",
      host: "pty",
    });
    const id = durableId(result);
    expect(result).toMatchObject({
      input_status: {
        state: "waiting",
        reason: "permission",
        source: "codex-status",
      },
    });
    expect((await m.list())[0]).toMatchObject({
      input_status: { state: "waiting", reason: "permission" },
    });
    const file = join(f.env.CODEX_HOME!, "threads", id + ".json");
    const thread = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...thread, fixtureStatus: { type: "idle" } }),
    );
    expect((await m.wait(id, { timeoutMs: 0 })).record).toMatchObject({
      input_status: { state: "unknown" },
    });
    await m.stop(id);
  } finally {
    await m.close();
  }
});

test("OpenCode pending requests are scoped to the session and do not expose payloads", async () => {
  let requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/permission"
          ? [
              {
                id: "per_a",
                sessionID: "ses_other",
                permission: "shell",
                patterns: ["private command"],
                metadata: {},
                always: [],
              },
            ]
          : [
              {
                id: "que_a",
                sessionID: "ses_target",
                questions: [{ question: "private question" }],
              },
            ],
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const client = new OpenCodeHttp(`http://127.0.0.1:${address.port}`);
  try {
    expect(
      await client.inputStatus("ses_target", Date.now() + 1000),
    ).toMatchObject({
      state: "waiting",
      reason: "question",
      source: "opencode-question",
    });
    expect(
      await client.inputStatus("ses_other", Date.now() + 1000),
    ).toMatchObject({
      state: "waiting",
      reason: "permission",
      source: "opencode-permission",
    });
    expect(
      await client.inputStatus("ses_absent", Date.now() + 1000),
    ).toBeUndefined();
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("unavailable or oversized native input responses remain unknown", async () => {
  let mode = "oversized";
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "missing") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify([
        {
          id: "per_a",
          sessionID: "ses_target",
          payload: "x".repeat(70 * 1024),
        },
      ]),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const client = new OpenCodeHttp(`http://127.0.0.1:${address.port}`);
  try {
    expect(
      await client.inputStatus("ses_target", Date.now() + 1000),
    ).toBeUndefined();
    mode = "missing";
    expect(
      await client.inputStatus("ses_target", Date.now() + 1000),
    ).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an observation completing after the launch ends cannot report a current wait", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let observing = false;
  const host = new PtyHost();
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  let hostRef: string | undefined;
  try {
    await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "observation race",
      host: "pty",
    });
    const entry = (await m.registry.all())[0]!;
    hostRef = entry.hostRef;
    (host as any).inputStatus = async () => {
      observing = true;
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        state: "waiting",
        reason: "password",
        source: "tmux-screen",
        observed_at: new Date().toISOString(),
      };
    };
    const listing = m.list();
    await expect.poll(() => observing).toBe(true);
    await m.registry.update(entry.launchId, { status: "exited" });
    release!();
    expect((await listing)[0]).toMatchObject({
      state: "exited",
      input_status: { state: "unknown" },
    });
    expect((await m.registry.all())[0]).toMatchObject({
      input_status: { state: "unknown" },
    });
  } finally {
    release?.();
    if (hostRef) await host.stop(hostRef);
    await m.close();
  }
});

test("the registry liveness sweep clears an observation sampled before process exit", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "claude", kind: "session", cwd: f.root },
      4,
    );
    await m.registry.update(entry.launchId, {
      root: { pid: process.pid, start: "not-this-process-start" },
    });
    const updated = await m.registry.update(entry.launchId, {
      input_status: {
        state: "waiting",
        reason: "password",
        source: "tmux-screen",
        observed_at: new Date().toISOString(),
      },
    });
    expect(updated).toMatchObject({
      status: "exited",
      input_status: { state: "unknown" },
    });
    expect((await m.registry.all())[0]).toMatchObject({
      input_status: { state: "unknown" },
    });
  } finally {
    await m.close();
  }
});

test("a request-key retry reports reservation-owned input evidence instead of peer data", async () => {
  const f = await fixture({
    MUSTER_FAKE_THREAD_STATUS: JSON.stringify({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }),
  });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const req = {
    runtime: "codex",
    cwd: f.root,
    prompt: "retry input status",
    host: "pty",
    requestKey: "input-retry",
  };
  try {
    const result = await m.run(req);
    const entry = (await m.registry.all())[0]!;
    await m.registry.update(entry.launchId, {
      peer: {
        ...entry.peer,
        input_status: {
          state: "waiting",
          reason: "password",
          source: "tmux-screen",
          observed_at: "forged",
        },
      },
    });
    const retry = await m.run(req);
    expect(retry).toMatchObject({
      input_status: {
        state: "waiting",
        reason: "permission",
        source: "codex-status",
      },
    });
    expect(JSON.stringify(retry)).not.toContain("forged");
    await m.stop(durableId(result));
  } finally {
    await m.close();
  }
});
