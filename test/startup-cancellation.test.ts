import { test, expect } from "vitest";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFile, access } from "node:fs/promises";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { fixture, lines } from "./helpers.js";
import { isSame, processRef } from "../src/identity/processes.js";
function gate() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  return {
    ready,
    release,
    wait: async () => {
      entered();
      await hold;
    },
  };
}
async function setup(host = "pty") {
  const f = await fixture({
    MUSTER_FAKE_ID_MS: "1000",
    MUSTER_FAKE_TASK_MS: "10000",
  });
  const home = join(f.root, ".muster");
  const driver =
    host === "tmux" ? new TmuxHost(testServer("cancel-start")) : new PtyHost();
  const m = await Muster.create({ home, env: f.env, drivers: [driver] });
  const other = await Muster.create({ home, env: f.env, drivers: [driver] });
  return { f, m, other, driver, home };
}
for (const phase of [
  "preparing",
  "host-before-spawn",
  "host-after-spawn",
  "readiness",
] as const)
  for (const host of ["pty", "tmux"])
    test(`stop during ${phase} on ${host} cannot resurrect a launch`, async () => {
      const { f, m, other, driver } = await setup(host);
      const g = gate();
      let spawned: number | undefined;
      if (phase === "preparing") {
        const original = (m as any).prepareEnvironment.bind(m);
        (m as any).prepareEnvironment = async (...args: any[]) => {
          await g.wait();
          return original(...args);
        };
      } else if (phase === "readiness") {
        const original = (m as any).awaitReadiness.bind(m);
        (m as any).awaitReadiness = async (...args: any[]) => {
          await g.wait();
          return original(...args);
        };
      } else {
        const original = driver.launch.bind(driver);
        driver.launch = async (opts) => {
          if (phase === "host-before-spawn") await g.wait();
          const result = await original(opts);
          spawned = result.pid;
          if (phase === "host-after-spawn") await g.wait();
          return result;
        };
      }
      let launchId = "";
      const req = {
        runtime: "claude",
        host,
        cwd: f.root,
        prompt: "fixture",
        requestKey: "cancel-fixture",
        options: ["report-launch"],
      };
      const pending = m.run(req, undefined, (e) => (launchId = e.launch_id));
      void pending.catch(() => {});
      let stop: Promise<any> | undefined;
      let returned = false;
      try {
        await g.ready;
        stop = other.stop(launchId).then((result) => {
          returned = true;
          return result;
        });
        await expect
          .poll(
            async () => !!(await m.registry.peek(launchId))?.stopRequestedAt,
          )
          .toBe(true);
        expect(returned).toBe(false);
        g.release();
        expect(await stop).toMatchObject({ stopped: true });
        await expect(pending).rejects.toThrow(/cancel|stop/i);
        const record = (await m.list())[0];
        expect(record.state).toBe("stopped");
        if (phase === "preparing")
          expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
        if (spawned) expect(await processRef(spawned)).toBeUndefined();
        const entry = (await m.registry.all())[0]!;
        if (entry.root) expect(await isSame(entry.root)).toBe(false);
        await expect(m.run({ ...req, options: [] })).rejects.toThrow(/stopped/);
        expect((await m.wait(launchId, { timeoutMs: 100 })).done).toBe(true);
      } finally {
        g.release();
        await pending.catch(() => {});
        await stop?.catch(() => {});
        if (launchId) await other.stop(launchId).catch(() => {});
        await m.close();
        await other.close();
      }
    }, 15000);

test("CLI stop during preparation waits for owner acknowledgement and private cleanup", async () => {
  const { f, m, other, home } = await setup();
  const g = gate();
  const original = (m as any).prepareEnvironment.bind(m);
  const artifact = join(home, "private-fixture");
  (m as any).prepareEnvironment = async (...args: any[]) => {
    await g.wait();
    await writeFile(artifact, "fixture");
    await m.registry.update(args[0].entry.launchId, {
      mcpConfigPath: artifact,
    });
    return original(...args);
  };
  let launchId = "";
  const pending = m.run(
    {
      runtime: "claude",
      cwd: f.root,
      prompt: "fixture",
      options: ["report-launch"],
    },
    undefined,
    (e) => (launchId = e.launch_id),
  );
  void pending.catch(() => {});
  await g.ready;
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/muster.js"), "stop", launchId],
    { env: f.env },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const closed = new Promise((r) => child.on("close", r));
  try {
    await expect
      .poll(async () => !!(await m.registry.peek(launchId))?.stopRequestedAt)
      .toBe(true);
    expect(out).toBe("");
    g.release();
    expect(await closed).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ stopped: true });
    await expect(pending).rejects.toThrow(/cancel|stop/i);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    await expect(access(artifact)).rejects.toThrow();
  } finally {
    g.release();
    child.kill("SIGTERM");
    await closed;
    await pending.catch(() => {});
    await m.close();
    await other.close();
  }
}, 15000);

test("task cancellation between worker spawn and ownership publication never starts the agent", async () => {
  const { f, m, other } = await setup();
  const g = gate();
  const update = m.registry.update.bind(m.registry);
  m.registry.update = async (id, patch) => {
    if (patch.root && patch.outputPath) await g.wait();
    return update(id, patch);
  };
  let launchId = "";
  const pending = m.run(
    {
      runtime: "claude",
      kind: "task",
      cwd: f.root,
      prompt: "fixture",
      options: ["report-launch"],
    },
    undefined,
    (e) => (launchId = e.launch_id),
  );
  void pending.catch(() => {});
  let stopping: Promise<any> | undefined;
  try {
    await g.ready;
    stopping = other.stop(launchId);
    await expect
      .poll(async () => !!(await m.registry.peek(launchId))?.stopRequestedAt)
      .toBe(true);
    g.release();
    expect(await stopping).toMatchObject({ stopped: true });
    await expect(pending).rejects.toThrow(/cancel|stop/i);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    expect((await m.list())[0].state).toBe("stopped");
  } finally {
    g.release();
    await pending.catch(() => {});
    await stopping?.catch(() => {});
    await m.close();
    await other.close();
  }
}, 15000);

for (const failing of [false, true])
  test(`stop wins the final startup handoff (failure=${failing})`, async () => {
    const { f, m, other } = await setup();
    const g = gate();
    const finish = m.registry.finishStartup.bind(m.registry);
    m.registry.finishStartup = async (id, cancelled) => {
      if (!cancelled) await g.wait();
      return finish(id, cancelled);
    };
    if (failing)
      (m as any).prepareEnvironment = async () => {
        throw new Error("fixture failure");
      };
    let id = "";
    const pending = m.run(
      {
        runtime: "claude",
        cwd: f.root,
        prompt: "fixture",
        options: ["report-launch"],
      },
      undefined,
      (e) => {
        id = e.launch_id;
      },
    );
    void pending.catch(() => {});
    let stops: Promise<any>[] = [];
    try {
      await g.ready;
      stops = [other.stop(id), other.stop(id)];
      await expect
        .poll(async () => !!(await m.registry.peek(id))?.stopRequestedAt)
        .toBe(true);
      expect((await m.wait(id, { timeoutMs: 1 })).done).toBe(false);
      expect((await m.list())[0].cancellation_pending).toBe(true);
      g.release();
      await Promise.all(stops);
      await expect(pending).rejects.toThrow(/cancel/);
      expect((await m.list())[0]).toMatchObject({ state: "stopped" });
      expect((await m.registry.peek(id))?.startupPending).toBe(false);
    } finally {
      g.release();
      await pending.catch(() => {});
      await Promise.allSettled(stops);
      await m.close();
      await other.close();
    }
  }, 15000);

test("stop timeout is pending, never success, and eventually prevents spawn", async () => {
  const { f, m, other } = await setup();
  const g = gate();
  const prepare = (m as any).prepareEnvironment.bind(m);
  (m as any).prepareEnvironment = async (...args: any[]) => {
    await g.wait();
    return prepare(...args);
  };
  let id = "";
  const pending = m.run(
    {
      runtime: "claude",
      cwd: f.root,
      prompt: "fixture",
      options: ["report-launch"],
    },
    undefined,
    (e) => {
      id = e.launch_id;
    },
  );
  void pending.catch(() => {});
  try {
    await g.ready;
    await expect(other.stop(id)).rejects.toThrow(/pending/);
    expect((await m.wait(id, { timeoutMs: 1 })).done).toBe(false);
    expect((await m.list())[0].cancellation_pending).toBe(true);
    g.release();
    await expect(pending).rejects.toThrow(/cancel/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    expect((await m.list())[0].state).toBe("stopped");
  } finally {
    g.release();
    await pending.catch(() => {});
    await m.close();
    await other.close();
  }
}, 15000);

test("dead startup owner with an unpublished spawn remains unknown", async () => {
  const { f, m, other } = await setup();
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "claude", kind: "session", cwd: f.root, startupPending: true },
      10,
    );
    await m.registry.update(entry.launchId, {
      spawning: true,
      owner: { pid: process.pid, start: "wrong-generation" },
    });
    await expect(other.stop(entry.launchId)).resolves.toMatchObject({
      stopped: false,
      state: "unknown",
    });
    expect((await m.registry.peek(entry.launchId))?.startupPending).toBe(false);
  } finally {
    await m.close();
    await other.close();
  }
});

test("stop interrupts slow readiness while a trust dialog is visible", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "60000" });
  const screen = join(f.root, "screen.txt");
  await writeFile(
    screen,
    "Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm",
  );
  f.env.MUSTER_FAKE_SCREEN_FILE = screen;
  const driver = new TmuxHost(testServer("cancel-dialog"));
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [driver],
  });
  const other = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [driver],
  });
  let id = "";
  const pending = m.run(
    {
      runtime: "claude",
      host: "tmux",
      cwd: f.root,
      prompt: "fixture",
      options: ["report-launch"],
    },
    undefined,
    (e) => {
      id = e.launch_id;
    },
  );
  void pending.catch(() => {});
  try {
    await expect
      .poll(async () => (await other.list())[0]?.input_status, {
        timeout: 5000,
      })
      .toMatchObject({ state: "waiting", reason: "trust" });
    expect(await other.stop(id)).toMatchObject({ stopped: true });
    await expect(pending).rejects.toThrow(/cancel/);
    expect((await other.wait(id)).record.state).toBe("stopped");
  } finally {
    if (id) await other.stop(id).catch(() => {});
    await pending.catch(() => {});
    await m.close();
    await other.close();
  }
}, 15000);

test("reporter failure acknowledges a concurrent stop without stranding startup", async () => {
  const { f, m, other } = await setup();
  const g = gate();
  const update = m.registry.update.bind(m.registry);
  m.registry.update = async (id, patch) => {
    if (patch.error === "Launch reporter failed before spawn") await g.wait();
    return update(id, patch);
  };
  let id = "";
  const pending = m.run(
    {
      runtime: "claude",
      cwd: f.root,
      prompt: "fixture",
      options: ["report-launch"],
    },
    undefined,
    (e) => {
      id = e.launch_id;
      throw new Error("fixture reporter failure");
    },
  );
  void pending.catch(() => {});
  let stopping: Promise<any> | undefined;
  try {
    await g.ready;
    stopping = other.stop(id);
    await expect
      .poll(async () => !!(await m.registry.peek(id))?.stopRequestedAt)
      .toBe(true);
    g.release();
    expect(await stopping).toMatchObject({ stopped: true });
    await expect(pending).rejects.toThrow(/reporter/);
    expect((await m.registry.peek(id))?.startupPending).toBe(false);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    g.release();
    await pending.catch(() => {});
    await stopping?.catch(() => {});
    await m.close();
    await other.close();
  }
});
