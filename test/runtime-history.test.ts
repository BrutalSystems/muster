import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";

test("Claude clear retains launch identity, follows current address and preserves observed history", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    const req = {
      runtime: "claude",
      kind: "session",
      cwd: f.root,
      prompt: "rotation",
      requestKey: "rotation",
    };
    const initial: any = await m.run(req);
    const entry = (await m.registry.all())[0]!;
    launch = entry.launchId;
    expect(initial.launch_id).toBe(launch);
    const file = join(f.root, ".claude", "sessions", `${initial.pid}.json`);
    const original = JSON.parse(await readFile(file, "utf8"));
    const next = randomUUID();
    await writeFile(file, JSON.stringify({ ...original, sessionId: next }));
    const [current] = await m.list("session");
    expect(current.state).toBe("idle");
    expect(current.session_id).toBe(next);
    expect(current.canonical_id).toContain(next);
    expect(current.id).toBe(entry.id);
    expect(current.runtime_history.map((h: any) => h.session_id)).toEqual([
      original.sessionId,
      next,
    ]);
    expect(
      current.runtime_history.every(
        (h: any) => !Number.isNaN(Date.parse(h.first_observed_at)),
      ),
    ).toBe(true);
    await Promise.all([m.list("session"), m.list("session")]);
    const retry: any = await m.run(req);
    expect(retry.session_id).toBe(next);
    expect(retry.runtime_history).toHaveLength(2);
    const third = randomUUID();
    await writeFile(file, JSON.stringify({ ...original, sessionId: third }));
    const afterSecond = await m.wait(launch, { timeoutMs: 0 });
    expect((afterSecond.record as any).runtime_history).toHaveLength(3);
    expect((await m.wait(next, { timeoutMs: 0 })).done).toBe(false);
    await m.stop(launch);
    const [ended] = await m.list("session");
    expect(ended.state).toBe("stopped");
    expect(ended.runtime_history).toEqual(
      (afterSecond.record as any).runtime_history,
    );
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("late refresh cannot roll history backward or resurrect a stopped launch", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    await m.run({ runtime: "claude", cwd: f.root, prompt: "race" });
    const old = (await m.registry.all())[0]!;
    launch = old.launchId;
    const next = randomUUID();
    await m.registry.observeRuntime(old, {
      runtimeId: next,
      peer: { session_id: next, canonical_id: `claude-code:test.${next}` },
    });
    const stale = await m.registry.observeRuntime(old, {
      runtimeId: old.id,
      peer: { state: "unreachable" },
    });
    expect(stale.runtimeId).toBe(next);
    expect(stale.runtime_history).toHaveLength(2);
    await m.stop(launch);
    const stopped = await m.registry.observeRuntime(stale, {
      runtimeId: randomUUID(),
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.runtime_history).toHaveLength(2);
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("a mismatched process generation cannot adopt a new Claude identity", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    const initial: any = await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "binding",
    });
    const old = (await m.registry.all())[0]!;
    launch = old.launchId;
    await m.registry.update(launch, {
      runtimeProcess: { pid: initial.pid, start: "different generation" },
    });
    const file = join(f.root, ".claude", "sessions", `${initial.pid}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...rec, sessionId: randomUUID() }));
    const [current] = await m.list("session");
    expect(current.state).toBe("unreachable");
    expect(current.session_id).toBe(old.id);
    expect(current.runtime_history).toHaveLength(1);
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("history cannot be replaced by a generic registry update", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "immutable history",
    });
    launch = (await m.registry.all())[0]!.launchId;
    await expect(
      m.registry.update(launch, { runtime_history: [] }),
    ).rejects.toThrow(/history/);
    const entry = (await m.registry.peek(launch))!;
    await expect(
      m.registry.observeRuntime(entry, { runtime_history: [] } as any),
    ).rejects.toThrow(/history/);
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("refresh merges observed fields without losing a concurrent title", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    await m.run({ runtime: "claude", cwd: f.root, prompt: "title" });
    const old = (await m.registry.all())[0]!;
    launch = old.launchId;
    await m.registry.update(launch, {
      peer: { ...old.peer, title: "new title" },
    });
    await m.registry.observeRuntime(old, { peer: { state: "idle" } });
    expect((await m.registry.peek(launch))!.peer!.title).toBe("new title");
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

for (const clearedFirst of [false, true])
  test(`legacy process binding, cleared first: ${clearedFirst}`, async () => {
    const f = await fixture();
    const m = await Muster.create({
      home: f.home,
      env: f.env,
      drivers: [new PtyHost()],
    });
    let launch: string | undefined;
    try {
      const result: any = await m.run({
        runtime: "claude",
        cwd: f.root,
        prompt: "legacy",
      });
      launch = (await m.registry.all())[0]!.launchId;
      const file = join(f.home, "registry.json");
      const records = JSON.parse(await readFile(file, "utf8"));
      for (const e of records) {
        delete e.runtime_history;
        delete e.runtimeId;
        delete e.runtimeProcess;
        delete e.runtimeRevision;
      }
      await writeFile(file, JSON.stringify(records));
      const sessionFile = join(
        f.root,
        ".claude",
        "sessions",
        `${result.pid}.json`,
      );
      const rec = JSON.parse(await readFile(sessionFile, "utf8"));
      const next = randomUUID();
      if (!clearedFirst) {
        const [before] = await m.list("session");
        expect(before.runtime_history).toHaveLength(1);
      }
      await writeFile(sessionFile, JSON.stringify({ ...rec, sessionId: next }));
      const waited = await m.wait(launch, { timeoutMs: 0 });
      expect(waited.done).toBe(false);
      expect(waited.record.state).toBe(clearedFirst ? "unreachable" : "idle");
      expect((waited.record as any).session_id).toBe(
        clearedFirst ? result.session_id : next,
      );
    } finally {
      if (launch) await m.stop(launch);
      await m.close();
    }
  });

test("Codex reports unsupported current-thread tracking instead of reading a stale thread", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    await m.run({ runtime: "codex", cwd: f.root, prompt: "codex tracking" });
    const entry = (await m.registry.all())[0]!;
    launch = entry.launchId;
    // The launch process is alive, but its persisted runtime generation no longer matches.
    await m.registry.update(launch, {
      runtimeProcess: {
        pid: Number(entry.peer!.pid),
        start: "different generation",
      },
    });
    const [record] = await m.list("session");
    expect(record.state).toBe("unreachable");
    expect(record.tracking_error).toBe("codex_thread_tracking_unsupported");
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("a newer identity retries when an older in-flight observation commits first", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  const releases: (() => void)[] = [];
  const arrivals: (() => void)[] = [];
  const gates = [0, 1].map(() => new Promise<void>((r) => arrivals.push(r)));
  const observe = m.registry.observeRuntime.bind(m.registry);
  let calls = 0;
  try {
    const result: any = await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "ordered race",
    });
    launch = (await m.registry.all())[0]!.launchId;
    m.registry.observeRuntime = async (entry, patch) => {
      const n = calls++;
      if (n < 2) {
        const held = new Promise<void>((r) => (releases[n] = r));
        arrivals[n]!();
        await held;
      }
      return observe(entry, patch);
    };
    const first = m.list("session");
    await gates[0];
    const file = join(f.root, ".claude", "sessions", `${result.pid}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    const next = randomUUID();
    await writeFile(file, JSON.stringify({ ...rec, sessionId: next }));
    const second = m.list("session");
    await gates[1];
    releases[0]!();
    await first;
    releases[1]!();
    const [current] = await second;
    expect(current.session_id).toBe(next);
    expect(current.runtime_history.map((h: any) => h.session_id)).toEqual([
      result.session_id,
      next,
    ]);
    expect(calls).toBe(3);
  } finally {
    for (const release of releases) release?.();
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("Codex's known review subagent does not look like a foreground-thread reset", async () => {
  const f = await fixture({ MUSTER_FAKE_REVIEWER: "review" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let launch: string | undefined;
  try {
    await m.run({ runtime: "codex", cwd: f.root, prompt: "review child" });
    launch = (await m.registry.all())[0]!.launchId;
    const [current] = await m.list("session");
    expect(current.state).toBe("idle");
    expect(current.tracking_error).toBeUndefined();
  } finally {
    if (launch) await m.stop(launch);
    await m.close();
  }
});

test("same-folder siblings remain separate and ambiguous descendants never rebind", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const launches: string[] = [];
  try {
    const one: any = await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "first",
    });
    const two: any = await m.run({
      runtime: "claude",
      cwd: f.root,
      prompt: "second",
    });
    const entries = await m.registry.all();
    launches.push(...entries.map((e) => e.launchId));
    const entry = entries.find((e) => e.id === one.session_id)!;
    const file = join(f.root, ".claude", "sessions", `${one.pid}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    const next = randomUUID();
    await writeFile(file, JSON.stringify({ ...rec, sessionId: next }));
    const list = await m.list("session");
    expect(list.find((e) => e.id === two.session_id)?.session_id).toBe(
      two.session_id,
    );
    expect(list.find((e) => e.id === one.session_id)?.session_id).toBe(next);
    const extra = join(
      f.root,
      ".claude",
      "sessions",
      `${entry.root!.pid}.json`,
    );
    await writeFile(
      extra,
      JSON.stringify({ ...rec, pid: entry.root!.pid, sessionId: randomUUID() }),
    );
    const result = await m.wait(entry.launchId, { timeoutMs: 0 });
    expect(result.record.state).toBe("unreachable");
    expect((result.record as any).runtime_history).toHaveLength(2);
  } finally {
    for (const id of launches) await m.stop(id);
    await m.close();
  }
});
