import { test, expect } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture, lines } from "./helpers.js";
import { asSession, asSessionOf, asTask } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { delay, processRef } from "../src/identity/processes.js";
import { suffixOf } from "../src/naming.js";
for (const host of ["pty", "tmux"] as const)
  for (const runtime of ["codex", "claude"] as const) {
    test(`${runtime} through ${host} returns only after reachability and logs before launch`, async () => {
      const f = await fixture({ MUSTER_FAKE_READY_MS: "500" });
      const m = await Muster.create({
        home: f.home,
        env: f.env,
        drivers: [
          host === "pty"
            ? new PtyHost()
            : new TmuxHost(testServer("run-" + runtime)),
        ],
      });
      const start = Date.now();
      const peer = asSession(
        await m.run({
          runtime,
          prompt: "test peer",
          cwd: f.root,
          host,
        }),
      );
      try {
        expect(Date.now() - start).toBeGreaterThanOrEqual(500);
        // The whole durable id since Tin Can 1.0.0, not the three-hex
        // suffix: two peers sharing a slug whose ids also shared their last
        // three hex characters used to produce the SAME canonical id, and
        // both became unaddressable.
        expect(peer.canonical_id).toMatch(
          new RegExp(
            "^" +
              (runtime === "codex" ? "codex" : "claude-code") +
              ":test-peer\\." +
              "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          ),
        );
        // Codex's durable field is thread_id, Claude's is session_id; the
        // canonical id must end in whichever this runtime carries.
        const durable = runtime === "codex" ? peer.thread_id : peer.session_id;
        expect(durable).toBeTruthy();
        expect(peer.canonical_id.endsWith(durable!)).toBe(true);
        expect(peer.host).toBe(host);
        expect(peer.capabilities.watchable).toBe(host === "tmux");
        expect(
          (await lines(join(f.root, "starts.jsonl")))[0].intentPresent,
        ).toBe(true);
        expect((await m.list())[0].kind).toBe("session");
      } finally {
        await m.stop(peer.canonical_id);
        await m.close();
      }
      expect(await processRef(peer.pid)).toBeUndefined();
    }, 15000);
  }

test.each(["codex", "claude"] as const)(
  "%s receives its full launch timeout after waiting for the registry lock",
  async (runtime) => {
    const f = await fixture();
    await writeFile(
      join(f.home, "config.toml"),
      'host="pty"\nlaunch_timeout_sec=2\n',
    );
    const lock = join(f.home, "registry.lock");
    await mkdir(lock);
    const unlock = setTimeout(() => void rm(lock, { recursive: true }), 2100);
    const m = await Muster.create({
      home: f.home,
      env: f.env,
      drivers: [new PtyHost()],
    });
    try {
      const peer = await m.run({
        runtime,
        prompt: "post reservation budget",
        cwd: f.root,
        host: "pty",
      });
      expect(peer).toMatchObject({ kind: "session", state: "idle" });
    } finally {
      clearTimeout(unlock);
      await rm(lock, { recursive: true, force: true });
      await m.close();
    }
  },
  15_000,
);
test("timeout kills the nested process and records the missing rollout", async () => {
  const f = await fixture({
    MUSTER_FAKE_READY_MS: "999999",
    MUSTER_FAKE_NEST: "2",
  });
  await writeFile(
    join(f.home, "config.toml"),
    'host="pty"\nlaunch_timeout_sec=3\n',
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  await expect(
    m.run({ runtime: "codex", prompt: "never ready", cwd: f.root }),
  ).rejects.toThrow(/rollout/);
  const started = await lines(join(f.root, "starts.jsonl"));
  expect(started).toHaveLength(1);
  expect(await processRef(started[0].pid)).toBeUndefined();
  expect((await lines(join(f.home, "launches.jsonl"))).at(-1).event).toBe(
    "failure",
  );
  await m.close();
}, 10000);
test("early process exit fails promptly rather than waiting the deadline", async () => {
  const f = await fixture({ MUSTER_FAKE_EXIT: "1" }),
    m = await Muster.create({ home: f.home, env: f.env });
  const start = Date.now();
  await expect(
    m.run({ runtime: "claude", prompt: "exit", cwd: f.root, host: "pty" }),
  ).rejects.toThrow(/exited/);
  expect(Date.now() - start).toBeLessThan(3000);
  await m.close();
});
test("a live exec source is never returned as a session peer", async () => {
  const f = await fixture({ MUSTER_FAKE_SOURCE: "exec" });
  // The rejection this asserts is still only raised at the deadline: the loop
  // stores each attempt's error as the diagnostic and throws it when time runs
  // out. So the budget has to cover the whole discovery path — pty launch, the
  // runtime spawning its lock holder, one lsof, and a thread/read round trip.
  // What it no longer has to cover is readiness: resolveCodex screens the lock
  // and raises this reason itself, so it is stored on the first pass that sees
  // the lock rather than arriving after the deadline and being discarded (#20).
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec=3\n");
  const m = await Muster.create({ home: f.home, env: f.env });
  await expect(
    m.run({
      runtime: "codex",
      prompt: "wrong source",
      cwd: f.root,
      host: "pty",
    }),
  ).rejects.toThrow(/source is exec/);
  await m.close();
}, 15000);
test("tasks return a run handle, keep output and never become peers", async () => {
  const f = await fixture(),
    m = await Muster.create({ home: f.home, env: f.env });
  const task = asTask(
    await m.run({
      runtime: "codex",
      kind: "task",
      prompt: "task hello",
      cwd: f.root,
    }),
  );
  // Probing for a field the type says a task does not have: the assertion is
  // about what the runtime actually emits, so it stays as a runtime check.
  expect(Object.hasOwn(task, "canonical_id")).toBe(false);
  for (let i = 0; i < 50; i++) {
    if ((await m.list("task"))[0]?.state === "exited") break;
    await delay(50);
  }
  expect(await m.output(task.id)).toContain("TASK_OUTPUT:task hello");
  expect(
    (await lines(join(f.home, "launches.jsonl"))).some(
      (e) => e.event === "task_exit" && e.exit_code === 0,
    ),
  ).toBe(true);
  expect((await m.list("task"))[0]).toMatchObject({
    kind: "task",
    state: "exited",
    exit_code: 0,
  });
  await m.close();
}, 10000);
test("intent log failure prevents starting any runtime", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "launches.jsonl"));
  const m = await Muster.create({ home: f.home, env: f.env });
  await expect(
    m.run({ runtime: "claude", prompt: "blocked", cwd: f.root, host: "pty" }),
  ).rejects.toThrow();
  expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  await m.close();
});

test("stopping a runtime-qualified peer updates its own registry namespace", async () => {
  const f = await fixture(),
    m = await Muster.create({ home: f.home, env: f.env });
  const a = asSessionOf(
    await m.run({
      runtime: "codex",
      prompt: "codex peer",
      cwd: f.root,
      host: "pty",
    }),
    "codex",
  );
  const b = asSessionOf(
    await m.run({
      runtime: "claude",
      prompt: "claude peer",
      cwd: f.root,
      host: "pty",
    }),
    "claude-code",
  );
  try {
    const entries = await m.registry.all();
    const second = entries.find((e) => e.runtime === "claude")!;
    await m.registry.update(second.launchId, { id: a.thread_id });
    await m.stop(b.canonical_id);
    const after = await m.registry.all();
    expect(after.find((e) => e.runtime === "codex")!.status).toBe("running");
    expect(after.find((e) => e.runtime === "claude")!.status).toBe("stopped");
  } finally {
    await m.close();
  }
}, 10000);

test("a runtime that exits after forking cannot leave a child behind", async () => {
  const f = await fixture({ MUSTER_FAKE_ORPHAN: "1" }),
    m = await Muster.create({ home: f.home, env: f.env });
  await expect(
    m.run({
      runtime: "claude",
      prompt: "orphan check",
      cwd: f.root,
      host: "pty",
    }),
  ).rejects.toThrow(/exited/);
  const children = await lines(join(f.root, "orphan.jsonl"));
  expect(children).toHaveLength(1);
  expect(await processRef(children[0].pid)).toBeUndefined();
  await m.close();
}, 10000);
test("list refreshes Claude names and busy state rather than caching launch state", async () => {
  const f = await fixture(),
    m = await Muster.create({ home: f.home, env: f.env });
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "original",
      cwd: f.root,
      host: "pty",
    }),
  );
  try {
    const path = join(f.root, ".claude", "sessions", peer.pid + ".json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.name = "renamed";
    record.status = "busy";
    await writeFile(path, JSON.stringify(record));
    const current = (await m.list("session"))[0];
    expect(current.state).toBe("busy");
    expect(current.canonical_id).toMatch(/^claude-code:renamed\./);
  } finally {
    await m.close();
  }
});

test("task exit cleans up descendants left by its runtime", async () => {
  const f = await fixture({ MUSTER_FAKE_ORPHAN: "1" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const task = asTask(
    await m.run({
      runtime: "claude",
      kind: "task",
      prompt: "task cleanup",
      cwd: f.root,
    }),
  );
  try {
    for (let i = 0; i < 100; i++) {
      if (
        (await m.list("task"))[0]?.state === "exited" &&
        !(await processRef(task.pid))
      )
        break;
      await delay(50);
    }
    const children = await lines(join(f.root, "orphan.jsonl"));
    expect(children).toHaveLength(1);
    expect(await processRef(children[0].pid)).toBeUndefined();
    expect((await m.list("task"))[0]).toMatchObject({
      state: "exited",
      exit_code: 7,
    });
  } finally {
    await m.stop(task.id);
    await m.close();
  }
}, 10000);

test.each(["1", "unloaded"])(
  "auto reviewer locks (%s) do not obscure the launched Codex CLI identity",
  async (reviewer) => {
    const f = await fixture({
      MUSTER_FAKE_REVIEWER: reviewer,
      MUSTER_FAKE_READY_MS: "500",
    });
    await writeFile(join(f.home, "config.toml"), "launch_timeout_sec=3\n");
    const m = await Muster.create({ home: f.home, env: f.env });
    try {
      const peer = asSessionOf(
        await m.run({
          runtime: "codex",
          prompt: "reviewer identity",
          cwd: f.root,
          host: "pty",
          permissions: "auto",
          sandbox: "workspace-write",
        }),
        "codex",
      );
      expect(peer.thread_id).toBe(
        (await lines(join(f.root, "starts.jsonl")))[0].id,
      );
      expect(peer.permissions).toBe("auto");
    } finally {
      await m.close();
    }
  },
  10000,
);

test("multiple messageable CLI identities still fail rather than choosing a peer", async () => {
  const f = await fixture({
    MUSTER_FAKE_REVIEWER: "ambiguous",
    MUSTER_FAKE_READY_MS: "500",
  });
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec=3\n");
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({
        runtime: "codex",
        prompt: "ambiguous",
        cwd: f.root,
        host: "pty",
        permissions: "auto",
        sandbox: "workspace-write",
      }),
    ).rejects.toThrow(/Multiple Codex CLI/);
  } finally {
    await m.close();
  }
}, 10000);

test("open selects tmux, opens the resolved session and records the result", async () => {
  const f = await fixture(),
    host = new TmuxHost(testServer("open"));
  let opened = "";
  host.openAvailable = async () => true;
  host.open = async (ref: string) => {
    opened = ref;
  };
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [host, new PtyHost()],
  });
  try {
    const peer = asSessionOf(
      await m.run({
        runtime: "claude",
        prompt: "open test",
        cwd: f.root,
        open: true,
      }),
      "claude-code",
    );
    expect(peer.host).toBe("tmux");
    expect(peer.terminal_opened).toBe(true);
    expect(peer.terminal).toBe("terminal");
    expect(opened).toMatch(/^@\d+$/);
    expect((await m.list())[0].terminal_opened).toBe(true);
    expect(
      (await lines(join(f.home, "launches.jsonl"))).find(
        (e) => e.event === "intent",
      ).open,
    ).toBe(true);
    await m.stop(peer.session_id!);
  } finally {
    await m.close();
  }
}, 10000);

test("open errors clean up the launched session; unsupported combinations never launch", async () => {
  const f = await fixture(),
    host = new TmuxHost(testServer("open-failure"));
  host.openAvailable = async () => true;
  host.open = async () => {
    throw new Error("Terminal permission denied");
  };
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [host, new PtyHost()],
  });
  try {
    for (const extra of [{ kind: "task" }, { host: "pty" }])
      await expect(
        m.run({
          runtime: "claude",
          prompt: "blocked",
          cwd: f.root,
          open: true,
          ...extra,
        }),
      ).rejects.toThrow(/--open/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    await expect(
      m.run({
        runtime: "claude",
        prompt: "open failure",
        cwd: f.root,
        open: true,
      }),
    ).rejects.toThrow(/Terminal permission denied/);
    const started = (await lines(join(f.root, "starts.jsonl")))[0];
    expect(await processRef(started.pid)).toBeUndefined();
    expect(await host.list()).toEqual([]);
  } finally {
    await m.close();
  }
}, 10000);

test("terminal selection requires open and persists the selected viewer", async () => {
  const f = await fixture();
  const host = new TmuxHost(testServer("viewer"));
  const selected: string[] = [];
  host.openAvailable = async (terminal) => {
    selected.push(terminal!);
    return true;
  };
  host.open = async (_ref, _deadline, terminal) => {
    selected.push(terminal!);
  };
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "viewer",
        cwd: f.root,
        terminal: "ghostty",
      }),
    ).rejects.toThrow(/--open/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    const peer = asSessionOf(
      await m.run({
        runtime: "claude",
        prompt: "viewer",
        cwd: f.root,
        open: true,
        terminal: "ghostty",
      }),
      "claude-code",
    );
    expect(peer).toMatchObject({
      terminal: "ghostty",
      terminal_opened: true,
      host: "tmux",
    });
    expect(selected).toEqual(["ghostty", "ghostty"]);
    expect((await m.list())[0].terminal).toBe("ghostty");
    expect((await lines(join(f.home, "launches.jsonl")))[0].terminal).toBe(
      "ghostty",
    );
    await m.stop(peer.session_id);
  } finally {
    await m.close();
  }
});
test("unavailable selected terminal fails before launching", async () => {
  const f = await fixture();
  const host = new TmuxHost(testServer("unavailable-viewer"));
  host.openAvailable = async () => false;
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "viewer",
        cwd: f.root,
        open: true,
        terminal: "iterm2",
      }),
    ).rejects.toThrow(/iterm2/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});

test("a claude launch that never registers names workspace trust when the directory is untrusted", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "999999" });
  await writeFile(
    join(f.home, "config.toml"),
    'host="pty"\nlaunch_timeout_sec=2\n',
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "never ready", cwd: f.root }),
    ).rejects.toThrow(/workspace trust has not been accepted/);
  } finally {
    await m.close();
  }
}, 15000);

test("a claude launch that never registers stops blaming trust once the directory is trusted", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "999999" });
  await writeFile(
    join(f.home, "config.toml"),
    'host="pty"\nlaunch_timeout_sec=2\n',
  );
  const cfg = join(f.home, "claude-cfg");
  await mkdir(cfg, { recursive: true });
  await writeFile(
    join(cfg, ".claude.json"),
    JSON.stringify({ projects: { [f.root]: { hasTrustDialogAccepted: true } } }),
  );
  const m = await Muster.create({
    home: f.home,
    env: { ...f.env, CLAUDE_CONFIG_DIR: cfg },
  });
  try {
    await expect(
      m.run({ runtime: "claude", prompt: "never ready", cwd: f.root }),
    ).rejects.toThrow(/is trusted for this profile/);
  } finally {
    await m.close();
  }
}, 15000);

test("a running session resolves by its qualified slug.suffix address", async () => {
  // find() rebuilt `suffix` by taking the last dot-separated segment of the
  // stored canonical id. On a 1.x id that segment is the whole uuid, not the
  // three-hex suffix, so the qualified address stopped resolving — silently,
  // because resolution simply reports the name as unknown.
  const f = await fixture({ MUSTER_FAKE_READY_MS: "0" });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "qualified address",
        cwd: f.root,
        host: "pty",
      }),
    );
    const qualified = `${peer.name}.${suffixOf(peer.session_id!)}`;
    expect(await m.stop(qualified)).toMatchObject({ stopped: true });
  } finally {
    await m.close();
  }
}, 15000);
