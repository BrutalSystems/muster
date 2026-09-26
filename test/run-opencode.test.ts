import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import TOML from "@iarna/toml";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { delay, processRef } from "../src/identity/processes.js";
import { Muster } from "../src/run.js";
import { fixture, lines } from "./helpers.js";
import { asSessionOf, asTask } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { ampleDeadline } from "./deadline.js";

async function waitForTaskExit(muster: Muster, id: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const task = (await muster.list("task")).find((run) => run.id === id);
    if (task?.state === "exited") return task;
    await delay(25);
  }
  throw new Error(`task ${id} did not exit`);
}

test("OpenCode through pty waits for readiness and returns durable endpoint identity", async () => {
  const f = await fixture({ MUSTER_FAKE_READY_MS: "200" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const startedAt = Date.now();
  const peer = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "test peer",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  try {
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    expect(peer).toMatchObject({
      kind: "session",
      runtime: "opencode",
      session_id: expect.any(String),
      server_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      state: "idle",
      host: "pty",
    });
    expect(peer.canonical_id).toMatch(
      new RegExp("^opencode:test-peer\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    );
    expect(peer.canonical_id.endsWith(peer.session_id)).toBe(true);
    const [entry] = await m.registry.all();
    expect(entry).toMatchObject({
      id: peer.session_id,
      server_url: peer.server_url,
      opencode_port: Number(new URL(peer.server_url).port),
    });
  } finally {
    await m.close();
  }
});

test("same-title OpenCode launches stay endpoint-local and stop by durable or canonical address", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const first = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "same",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  const second = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "same",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  try {
    expect(first.session_id).not.toBe(second.session_id);
    expect(first.server_url).not.toBe(second.server_url);
    await m.stop(first.session_id);
    await m.stop(second.canonical_id);
    expect((await m.registry.all()).map((entry) => entry.status)).toEqual([
      "stopped",
      "stopped",
    ]);
  } finally {
    await m.close();
  }
});

test("list refreshes OpenCode title and busy/retry state from the persisted endpoint and ID", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const peer = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "original",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  try {
    const [start] = (await lines(join(f.root, "starts.jsonl"))).filter(
      (record) => record.runtime === "opencode",
    );
    await writeFile(
      start.statePath,
      JSON.stringify({
        title: "renamed session",
        status: {
          type: "retry",
          attempt: 2,
          message: "provider busy",
          next: ampleDeadline(),
        },
      }),
    );
    expect((await m.list("session"))[0]).toMatchObject({
      session_id: peer.session_id,
      server_url: peer.server_url,
      name: "renamed-session",
      state: "busy",
    });
  } finally {
    await m.close();
  }
});

test("a wrong OpenCode endpoint payload times out, cleans the child, and records failure", async () => {
  const f = await fixture({ MUSTER_FAKE_OPENCODE_WRONG_CWD: "1" });
  await writeFile(
    join(f.home, "config.toml"),
    'host="pty"\nlaunch_timeout_sec=1\n',
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  await expect(
    m.run({
      runtime: "opencode",
      prompt: "wrong endpoint",
      cwd: f.root,
      host: "pty",
    }),
  ).rejects.toThrow(/OpenCode|session|endpoint/i);
  const [started] = (await lines(join(f.root, "starts.jsonl"))).filter(
    (record) => record.runtime === "opencode",
  );
  expect(await processRef(started.pid)).toBeUndefined();
  expect((await m.registry.all())[0]).toMatchObject({ status: "failed" });
  await m.close();
}, 10_000);

test("a matching session on a listener outside the launched process tree is rejected", async () => {
  const f = await fixture({ MUSTER_FAKE_OPENCODE_PORT_SQUATTER: "1" });
  await writeFile(
    join(f.home, "config.toml"),
    'host="pty"\nlaunch_timeout_sec=1\n',
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "opencode",
        prompt: "matching squatter",
        cwd: f.root,
        host: "pty",
      }),
    ).rejects.toThrow(/OpenCode|session|endpoint/i);
    const [started] = (await lines(join(f.root, "starts.jsonl"))).filter(
      (record) => record.runtime === "opencode",
    );
    expect(await processRef(started.pid)).toBeUndefined();
    expect((await m.registry.all())[0]).toMatchObject({ status: "failed" });
  } finally {
    await m.close();
  }
  const [squatter] = await lines(join(f.root, "opencode-squatters.jsonl"));
  expect(squatter).toMatchObject({ pid: expect.any(Number) });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await processRef(squatter.pid))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await processRef(squatter.pid)).toBeUndefined();
}, 10_000);

test("OpenCode stop attempts abort but still performs process cleanup when abort fails", async () => {
  const f = await fixture({ MUSTER_FAKE_OPENCODE_ABORT_FAIL: "1" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const peer = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "abort me",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  await m.stop(peer.session_id);
  expect(await lines(join(f.root, "opencode-aborts.jsonl"))).toEqual([
    expect.objectContaining({ id: peer.session_id }),
  ]);
  expect(await processRef(peer.pid)).toBeUndefined();
  await m.close();
});

test("refresh and stop reject a listener reassigned outside the launched process tree", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const peer = asSessionOf(
    await m.run({
      runtime: "opencode",
      prompt: "owned title",
      cwd: f.root,
      host: "pty",
    }),
    "opencode",
  );
  try {
    const [start] = (await lines(join(f.root, "starts.jsonl"))).filter(
      (record) => record.runtime === "opencode",
    );
    await writeFile(
      start.statePath,
      JSON.stringify({
        title: "replacement metadata",
        status: {
          type: "busy",
          reassignOnStatus: true,
          replacementTitle: "replacement listener",
        },
      }),
    );

    expect((await m.list("session"))[0]).toMatchObject({
      session_id: peer.session_id,
      name: "owned-title",
      state: "unreachable",
    });
    let replacement: { pid: number; port: number } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      [replacement] = await lines(join(f.root, "opencode-replacements.jsonl"));
      if (replacement) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(replacement).toMatchObject({
      pid: expect.any(Number),
      port: Number(new URL(peer.server_url).port),
    });

    await m.stop(peer.session_id);
    expect(
      await lines(join(f.root, "opencode-replacement-aborts.jsonl")),
    ).toEqual([]);
    expect(await processRef(peer.pid)).toBeUndefined();
    expect((await m.registry.all())[0]).toMatchObject({ status: "stopped" });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await processRef(replacement!.pid))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await processRef(replacement!.pid)).toBeUndefined();
  } finally {
    await m.close();
  }
}, 10_000);

test("OpenCode tmux open uses the shared attach and viewer behavior", async () => {
  const f = await fixture();
  const host = new TmuxHost(testServer("opencode-open"));
  let opened = "";
  host.openAvailable = async () => true;
  host.open = async (hostRef) => {
    opened = hostRef;
  };
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [host, new PtyHost()],
  });
  try {
    const peer = asSessionOf(
      await m.run({
        runtime: "opencode",
        prompt: "open code",
        cwd: f.root,
        open: true,
      }),
      "opencode",
    );
    expect(peer).toMatchObject({
      host: "tmux",
      terminal_opened: true,
      terminal: "terminal",
      attach_hint: expect.stringContaining(
        `tmux -L ${testServer("opencode-open")}`,
      ),
    });
    expect(opened).toMatch(/^@\d+$/);
    await m.stop(peer.canonical_id);
  } finally {
    await m.close();
  }
}, 10_000);

test("OpenCode version rejection occurs before reservation or child launch", async () => {
  const f = await fixture({ MUSTER_FAKE_OPENCODE_VERSION: "1.18.30" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  await expect(
    m.run({ runtime: "opencode", prompt: "too old", cwd: f.root, host: "pty" }),
  ).rejects.toThrow(/1\.18\.30.*1\.18\.31/);
  expect(await m.registry.all()).toEqual([]);
  expect(
    await readFile(join(f.root, "starts.jsonl"), "utf8").catch(() => ""),
  ).toBe("");
  await m.close();
});

test("OpenCode task uses JSON mode, selected MCP isolation, and persistent output without session metadata", async () => {
  const secret = "task-only-secret";
  const f = await fixture({
    MUSTER_FAKE_OPENCODE_INHERITED_MCP: "inherited",
    MUSTER_FAKE_TASK_MS: "200",
  });
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({
      mcp_servers: {
        fixture: {
          command: process.execPath,
          args: [join(process.cwd(), "test/fakes/mcp.mjs")],
          env: { FIXTURE_TOKEN: secret },
          tools: ["ping"],
          required: true,
        },
      },
    }),
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const task = asTask(
      await m.run({
        runtime: "opencode",
        kind: "task",
        prompt: "task with tools",
        cwd: f.root,
        mcp: ["fixture"],
      }),
    );
    expect(task).toMatchObject({
      kind: "task",
      runtime: "opencode",
      state: "running",
      mcp: ["fixture"],
    });
    expect(task).not.toHaveProperty("canonical_id");
    expect(task).not.toHaveProperty("session_id");
    expect(task).not.toHaveProperty("server_url");

    const exited = await waitForTaskExit(m, task.id);
    expect(exited).toMatchObject({ state: "exited", exit_code: 0 });
    expect(await m.output(task.id)).toContain("TASK_OUTPUT:task with tools");
    const start = (await lines(join(f.root, "starts.jsonl"))).find(
      (record) =>
        record.runtime === "opencode" && record.prompt === "task with tools",
    );
    expect(start).toMatchObject({
      runtime: "opencode",
      argv: ["run", "--format", "json", "--pure", "--", "task with tools"],
      mcp: {
        inherited: { enabled: false },
        fixture: { enabled: true, type: "local" },
      },
      intentPresent: true,
    });
    expect(
      await readFile(join(f.home, "launches.jsonl"), "utf8"),
    ).not.toContain(secret);
  } finally {
    await m.close();
  }
});

test("OpenCode task preserves a nonzero runtime exit", async () => {
  const f = await fixture({ MUSTER_FAKE_OPENCODE_TASK_EXIT: "7" });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const task = asTask(
      await m.run({
        runtime: "opencode",
        kind: "task",
        prompt: "failing task",
        cwd: f.root,
      }),
    );
    expect(await waitForTaskExit(m, task.id)).toMatchObject({
      runtime: "opencode",
      state: "exited",
      exit_code: 7,
    });
  } finally {
    await m.close();
  }
});

test("an opencode task records a model that came from config, tagged config", async () => {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.toml"),
    '[opencode]\nmodel = "local/qwen"\n',
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const task = asTask(
      await m.run({
        runtime: "opencode",
        kind: "task",
        prompt: "config model",
        cwd: f.root,
      }),
    );
    // The half of #71 no end-to-end test covered: a model nobody named on the
    // command line still reaches the record, and says where it came from.
    expect(task).toMatchObject({
      model: "local/qwen",
      model_source: "config",
    });
    const listed = (await m.list("task")).find((r: any) => r.id === task.id);
    expect(listed).toMatchObject({
      model: "local/qwen",
      model_source: "config",
    });
  } finally {
    await m.close();
  }
}, 20000);
